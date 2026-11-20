// @bedrock/kernel: a persistent Python kernel where context is a variable.
//
// The kernel is a long-lived Python process speaking JSON lines on stdin/stdout.
// Variables survive between calls, so a worker can load a 50 MB log once and
// slice it, grep it and summarize it without ever putting it in the prompt.
// Helpers for reading files, grepping and spawning sub-agents are injected into
// the namespace; `spawn()` queues a request that the host drains.
//
// This is a deliberately small cousin of prime-agent's IPython runtime: one
// process, one protocol, stdlib only. It can be swapped for an IPython bridge
// later behind the same interface.

import { type ChildProcessWithoutNullStreams, spawn as spawnProcess, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

export interface KernelResult {
	ok: boolean;
	/** Captured stdout from this execution. */
	stdout: string;
	/** Captured stderr, including the traceback when the code raised. */
	stderr: string;
	/** The repr of the last expression, IPython-style, when there is one. */
	result?: string;
	error?: { type: string; message: string; traceback: string };
	durationMs: number;
}

export interface SpawnRequest {
	id: string;
	role: string;
	brief: string;
	createdAt: string;
}

export interface KernelOptions {
	workspace: string;
	/** Python executable. Defaults to PYTHON or python3. */
	python?: string;
	/** State directory for snapshots; snapshots are refused when omitted. */
	stateDir?: string;
	timeoutMs?: number;
}

type Pending = {
	resolve: (result: KernelResult) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
};

/**
 * The Python side. Kept as a string so the package has no runtime assets to
 * resolve and the protocol is reviewable in one place.
 */
const BOOTSTRAP = String.raw`
import json, sys, os, io, traceback, time, ast, glob as _glob, re as _re

WORKSPACE = os.environ.get("BEDROCK_WORKSPACE", os.getcwd())
SPAWNS = []

def _path(p):
    return p if os.path.isabs(p) else os.path.join(WORKSPACE, p)

def read(path, offset=0, limit=2000):
    with open(_path(path), "r", encoding="utf-8", errors="replace") as f:
        lines = f.read().split("\n")
    return "\n".join(lines[offset:offset + limit])

def write(path, text):
    full = _path(path)
    os.makedirs(os.path.dirname(full) or ".", exist_ok=True)
    with open(full, "w", encoding="utf-8") as f:
        f.write(text)
    return len(text)

def ls(path=".", limit=500):
    full = _path(path)
    return sorted(os.listdir(full))[:limit]

def grep(pattern, path=".", glob="**/*", limit=200):
    rx = _re.compile(pattern)
    out = []
    root = _path(path)
    for base, dirs, files in os.walk(root):
        dirs[:] = [d for d in dirs if d not in (".git", "node_modules", "dist", "build", "__pycache__")]
        for name in files:
            if not _glob.fnmatch.fnmatch(name, os.path.basename(glob)) and glob != "**/*":
                continue
            full = os.path.join(base, name)
            try:
                with open(full, "r", encoding="utf-8", errors="ignore") as f:
                    for number, line in enumerate(f, 1):
                        if rx.search(line):
                            out.append({"path": os.path.relpath(full, WORKSPACE), "line": number, "text": line.rstrip("\n")})
                            if len(out) >= limit:
                                return out
            except OSError:
                continue
    return out

def spawn(role, brief):
    request = {"id": "spawn_%d" % (len(SPAWNS) + 1), "role": role, "brief": brief}
    SPAWNS.append(request)
    return request["id"]

def pending_spawns():
    items = list(SPAWNS)
    SPAWNS.clear()
    return items

def snapshot_state(path):
    import pickle
    ns = globals().get("__bedrock_ns__", {})
    data = {k: v for k, v in ns.items() if not k.startswith("__") and not callable(v)}
    with open(path, "wb") as f:
        f.write(pickle.dumps(data))
    return len(data)

def restore_state(path):
    import pickle
    ns = globals().get("__bedrock_ns__")
    if ns is None:
        ns = {"__name__": "__bedrock__", "__builtins__": __builtins__}
        ns.update(HELPERS)
        globals()["__bedrock_ns__"] = ns
    with open(path, "rb") as f:
        data = pickle.load(f)
    ns.update(data)
    return len(data)

HELPERS = {"read": read, "write": write, "ls": ls, "grep": grep, "spawn": spawn, "pending_spawns": pending_spawns, "snapshot_state": snapshot_state, "restore_state": restore_state}

def _execute(code):
    started = time.time()
    namespace = globals().get("__bedrock_ns__")
    if namespace is None:
        namespace = {"__name__": "__bedrock__", "__builtins__": __builtins__}
        namespace.update(HELPERS)
        globals()["__bedrock_ns__"] = namespace
    out, err = io.StringIO(), io.StringIO()
    result = None
    error = None
    old_out, old_err = sys.stdout, sys.stderr
    sys.stdout, sys.stderr = out, err
    try:
        try:
            # REPL semantics without running anything twice: a trailing expression
            # is evaluated once and its repr returned; everything else is exec'd.
            tree = ast.parse(code)
            if tree.body and isinstance(tree.body[-1], ast.Expr):
                last = tree.body.pop()
                if tree.body:
                    exec(compile(tree, "<bedrock>", "exec"), namespace)
                value = eval(compile(ast.Expression(last.value), "<bedrock>", "eval"), namespace)
                result = repr(value)
                if result == "None":
                    result = None
            else:
                exec(compile(tree, "<bedrock>", "exec"), namespace)
        except Exception:
            error = {"type": "error", "message": str(sys.exc_info()[1]), "traceback": traceback.format_exc()}
    finally:
        sys.stdout, sys.stderr = old_out, old_err
    return {"ok": error is None, "stdout": out.getvalue(), "stderr": err.getvalue(), "result": result, "error": error, "durationMs": int((time.time() - started) * 1000)}

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        request = json.loads(line)
    except Exception:
        print(json.dumps({"id": None, "ok": False, "stdout": "", "stderr": "bad json", "error": {"type": "protocol", "message": "bad json", "traceback": ""}, "durationMs": 0}), flush=True)
        continue
    kind = request.get("kind")
    if kind == "shutdown":
        print(json.dumps({"id": request.get("id"), "ok": True, "stdout": "", "stderr": "", "durationMs": 0}), flush=True)
        break
    if kind == "execute":
        payload = _execute(request.get("code", ""))
        payload["id"] = request.get("id")
        print(json.dumps(payload), flush=True)
    else:
        print(json.dumps({"id": request.get("id"), "ok": False, "stdout": "", "stderr": "unknown request", "error": {"type": "protocol", "message": "unknown request", "traceback": ""}, "durationMs": 0}), flush=True)
`;

/**
 * The host side. `execute` is serialized: one request is in flight at a time, so
 * a worker's variables and output ordering stay predictable.
 */
export class Kernel {
	readonly workspace: string;
	readonly python: string;
	readonly stateDir?: string;
	readonly timeoutMs: number;
	#process?: ChildProcessWithoutNullStreams;
	#pending?: Pending;
	#buffer = "";
	#queue: Promise<unknown> = Promise.resolve();
	#closed = false;

	constructor(options: KernelOptions) {
		this.workspace = options.workspace;
		this.python = options.python ?? process.env.PYTHON ?? "python3";
		this.stateDir = options.stateDir;
		this.timeoutMs = options.timeoutMs ?? 120_000;
	}

	get running(): boolean {
		return this.#process !== undefined && !this.#closed;
	}

	/** Starts the Python process and injects the helpers. Throws when Python is unavailable. */
	async start(): Promise<void> {
		if (this.running) return;
		const child = spawnProcess(this.python, ["-u", "-c", BOOTSTRAP], {
			cwd: this.workspace,
			env: {
				...process.env,
				BEDROCK_WORKSPACE: this.workspace,
				PYTHONIOENCODING: "utf-8",
				PYTHONDONTWRITEBYTECODE: "1",
			},
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.#process = child;
		this.#closed = false;
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => this.#onData(chunk));
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			// Python writes import errors and warnings here before any request.
			if (this.#pending) this.#pending.reject(new Error(`kernel stderr: ${chunk.trim()}`));
		});
		child.on("exit", () => {
			this.#closed = true;
			this.#pending?.reject(new Error("kernel process exited"));
			this.#pending = undefined;
		});
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error(`python did not start within 10s (tried "${this.python}")`)),
				10_000,
			);
			child.once("spawn", () => {
				clearTimeout(timer);
				resolve();
			});
			child.once("error", (error) => {
				clearTimeout(timer);
				reject(new Error(`cannot start ${this.python}: ${error.message}`));
			});
		});
		// Prove the loop is alive before callers treat the kernel as ready.
		const probe = await this.execute("1 + 1");
		if (!probe.ok) throw new Error(`kernel bootstrap failed: ${probe.stderr || probe.error?.message}`);
	}

	#onData(chunk: string): void {
		this.#buffer += chunk;
		let newline = this.#buffer.indexOf("\n");
		while (newline >= 0) {
			const line = this.#buffer.slice(0, newline);
			this.#buffer = this.#buffer.slice(newline + 1);
			if (line.trim().length > 0) this.#handleLine(line);
			newline = this.#buffer.indexOf("\n");
		}
	}

	#handleLine(line: string): void {
		const pending = this.#pending;
		if (!pending) return;
		this.#pending = undefined;
		clearTimeout(pending.timer);
		try {
			const parsed = JSON.parse(line) as KernelResult & { id: string };
			pending.resolve({
				ok: parsed.ok,
				stdout: parsed.stdout ?? "",
				stderr: parsed.stderr ?? "",
				result: parsed.result ?? undefined,
				error: parsed.error ?? undefined,
				durationMs: parsed.durationMs ?? 0,
			});
		} catch (error) {
			pending.reject(new Error(`kernel sent invalid JSON: ${(error as Error).message}`));
		}
	}

	/** Executes code, serialized with any other execution. */
	async execute(code: string): Promise<KernelResult> {
		const run = this.#queue.then(() => this.#send({ kind: "execute", code }));
		this.#queue = run.catch(() => undefined);
		return run;
	}

	#send(request: Record<string, unknown>): Promise<KernelResult> {
		if (!this.#process || this.#closed) return Promise.reject(new Error("kernel is not running; call start() first"));
		if (this.#pending) return Promise.reject(new Error("kernel is busy"));
		return new Promise<KernelResult>((resolve, reject) => {
			const id = randomUUID();
			const timer = setTimeout(() => {
				this.#pending = undefined;
				reject(new Error(`kernel execution timed out after ${this.timeoutMs}ms`));
			}, this.timeoutMs);
			this.#pending = { resolve, reject, timer };
			this.#process!.stdin.write(`${JSON.stringify({ ...request, id })}\n`);
		});
	}

	/** Drains sub-agent requests queued by `spawn()` in the kernel. */
	async drainSpawns(): Promise<SpawnRequest[]> {
		// Print the JSON instead of returning it: `repr()` of a string would add quotes.
		const result = await this.execute("print(__import__('json').dumps(pending_spawns()))");
		if (!result.ok) return [];
		let items: Array<{ id: string; role: string; brief: string }>;
		try {
			items = JSON.parse(result.stdout.trim() || "[]") as Array<{ id: string; role: string; brief: string }>;
		} catch {
			return [];
		}
		return items.map((item) => ({ ...item, createdAt: new Date().toISOString() }));
	}

	/** Pickles the user namespace so a crash loses only the last turn. */
	async snapshot(): Promise<string> {
		if (!this.stateDir) throw new Error("no stateDir configured; refusing to snapshot into memory only");
		mkdirSync(this.stateDir, { recursive: true });
		const path = join(this.stateDir, "kernel-state.pkl");
		const result = await this.execute(`snapshot_state(${JSON.stringify(path)})`);
		if (!result.ok) throw new Error(`snapshot failed: ${result.error?.message}`);
		return path;
	}

	/** Restores a snapshot written by `snapshot()`. */
	async restore(path: string): Promise<number> {
		if (!existsSync(path)) throw new Error(`no kernel snapshot at ${path}`);
		const result = await this.execute(`restore_state(${JSON.stringify(path)})`);
		if (!result.ok) throw new Error(`restore failed: ${result.error?.message}`);
		return Number(result.result ?? 0);
	}

	/** Stops the process. Safe to call twice. */
	async stop(): Promise<void> {
		if (!this.#process) return;
		const child = this.#process;
		this.#process = undefined;
		this.#closed = true;
		if (this.#pending) {
			clearTimeout(this.#pending.timer);
			this.#pending.reject(new Error("kernel stopped"));
			this.#pending = undefined;
		}
		child.stdin.write(`${JSON.stringify({ kind: "shutdown", id: "shutdown" })}\n`);
		await new Promise<void>((resolve) => {
			const timer = setTimeout(() => {
				child.kill("SIGKILL");
				resolve();
			}, 2000);
			child.once("exit", () => {
				clearTimeout(timer);
				resolve();
			});
		});
	}
}

/** Writes a small script that a worker can run under `python3` to use the helpers. */
export function writeKernelBootstrap(directory: string): string {
	mkdirSync(directory, { recursive: true });
	const path = join(directory, "bedrock_kernel.py");
	writeFileSync(path, BOOTSTRAP, "utf8");
	return path;
}

/** True when the Python binary exists and can run. */
export function kernelAvailable(python = process.env.PYTHON ?? "python3"): boolean {
	const result = spawnSync(python, ["--version"], { encoding: "utf8" });
	return result.status === 0;
}

/** Files under a directory, for a worker that wants to feed them to the kernel. */
export function listFiles(directory: string, limit = 5000): string[] {
	return readdirSync(directory, { recursive: true, encoding: "utf8" })
		.filter((entry) => typeof entry === "string")
		.slice(0, limit)
		.map((entry) => relative(directory, join(directory, entry)));
}

/** Reads a file as text; used by tests and by the host when a worker asks for context. */
export function readKernelFile(path: string): string {
	return readFileSync(path, "utf8");
}
