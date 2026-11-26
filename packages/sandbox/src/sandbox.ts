// @bedrock/sandbox: Obsidian. One object that owns policy, sandboxing and the audit trail.

import { spawn, spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { AuditRecord, PermissionDecision, PermissionPreset, PermissionRequest } from "@bedrock/protocol";
import { type AuditSink, MemoryAuditLog } from "./audit.ts";
import { type Classification, classifyCommand } from "./classify.ts";
import { detectSandboxDenial } from "./denial.ts";
import { SandboxPolicyEngine } from "./policy.ts";
import { redact } from "./redact.ts";
import {
	containerArgs,
	type NetworkAccess,
	type SandboxPolicy,
	seatbeltAvailable,
	workspacePolicy,
	wrapWithSeatbelt,
} from "./seatbelt.ts";

export type SandboxBackend = "seatbelt" | "container" | "none";

export interface SandboxConfig {
	/** Workspace root the sandbox is centered on. */
	workspace: string;
	preset: PermissionPreset;
	/** Autonomous runs may widen `ask` to `allow` inside an isolated sandbox. */
	autonomous: boolean;
	/** Container image; enables the container backend. */
	containerImage?: string;
	/** Host workspace path, for the container bind mount. */
	hostWorkspace?: string;
	network?: NetworkAccess;
	privatePaths?: string[];
	audit?: AuditSink;
}

export interface WrappedCommand {
	backend: SandboxBackend;
	/** Executable to spawn. */
	file: string;
	args: string[];
	/** Human-readable reason, shown in tool cards. */
	explanation: string;
	policy: SandboxPolicy;
}

export interface CommandOutcome {
	exitCode: number;
	stdout: string;
	stderr: string;
	durationMs: number;
	/** True when the sandbox refused the operation rather than the command failing. */
	sandboxDenied: boolean;
	denialSignal?: string;
}

function canonicalPath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		const parent = dirname(path);
		return path === parent ? path : resolve(canonicalPath(parent), relative(parent, path));
	}
}

/**
 * The facade: decides, records, and (when asked) executes. Tools call
 * `check` before acting and `run` for shell commands so that every decision
 * and every command lands in the same audit trail.
 */
export class Sandbox {
	readonly config: SandboxConfig;
	readonly policy: SandboxPolicy;
	readonly engine: SandboxPolicyEngine;
	readonly audit: AuditSink;
	readonly backend: SandboxBackend;

	constructor(config: SandboxConfig) {
		this.config = config;
		this.policy = workspacePolicy(config.workspace, {
			network: config.network ?? "none",
			privatePaths: config.privatePaths?.flatMap((path) => [resolve(path), canonicalPath(resolve(path))]),
		});
		this.engine = new SandboxPolicyEngine({
			preset: config.preset,
			rules: [],
			workspace: config.workspace,
			autonomous: config.autonomous,
			isolated: config.preset !== "yolo",
		});
		this.audit = config.audit ?? new MemoryAuditLog();
		this.backend =
			config.preset !== "yolo" && config.containerImage
				? "container"
				: config.preset !== "yolo" && seatbeltAvailable()
					? "seatbelt"
					: "none";
	}

	check(request: PermissionRequest): PermissionDecision {
		const privatePaths = this.policy.privatePaths;
		if (!privatePaths?.length) return this.engine.check(request);
		for (const path of request.paths ?? []) {
			const absolute = resolve(request.cwd ?? this.config.workspace, path);
			const canonical = canonicalPath(absolute);
			for (const secret of privatePaths) {
				const rel = relative(secret, canonical);
				const ancestor = relative(canonical, secret);
				if (
					rel === "" ||
					(!rel.startsWith("..") && !isAbsolute(rel)) ||
					(request.tool === "grep" && !ancestor.startsWith("..") && !isAbsolute(ancestor))
				)
					return {
						effect: "deny",
						reason: "private harness state is not available to workers",
						ruleId: "private-path",
					};
			}
		}
		return this.engine.check(request);
	}

	classify(command: string): Classification {
		return classifyCommand(command);
	}

	/**
	 * Wraps a shell command for the strongest backend available. `none` means the
	 * permission decision is the only protection, which is why autonomous mode
	 * refuses to run without a worktree or container.
	 */
	wrap(command: string, shell = "/bin/bash"): WrappedCommand {
		if (this.backend === "container" && this.config.containerImage) {
			return {
				backend: "container",
				file: "docker",
				args: [
					...containerArgs({
						image: this.config.containerImage,
						workspace: this.config.workspace,
						hostWorkspace: this.config.hostWorkspace ?? this.config.workspace,
						network: this.config.network ?? "none",
						env: { TERM: "dumb", CI: "1" },
					}),
					shell,
					"-lc",
					command,
				],
				explanation: `container ${this.config.containerImage}, network ${this.config.network ?? "none"}`,
				policy: this.policy,
			};
		}
		const seatbelt = wrapWithSeatbelt(command, shell, this.policy, this.config.workspace);
		if (seatbelt) {
			return {
				backend: "seatbelt",
				file: seatbelt.command,
				args: seatbelt.args,
				explanation: `${this.policy.filesystem}, network ${this.policy.network}`,
				policy: this.policy,
			};
		}
		return {
			backend: "none",
			file: shell,
			args: ["-lc", command],
			explanation: "no OS sandbox available; permission policy only",
			policy: this.policy,
		};
	}

	/**
	 * Runs a command through the sandbox, records the audit entry, redacts
	 * secrets from captured output, and detects sandbox denials.
	 */
	run(
		command: string,
		options: { cwd?: string; timeoutMs?: number; env?: Record<string, string> } = {},
	): CommandOutcome {
		const decision = this.check({ tool: "bash", command, cwd: options.cwd ?? this.config.workspace });
		if (decision.effect === "deny") {
			this.record({ at: new Date().toISOString(), tool: "bash", command, decision, executed: false });
			return {
				exitCode: 126,
				stdout: "",
				stderr: `denied: ${decision.reason}`,
				durationMs: 0,
				sandboxDenied: false,
			};
		}
		const wrapped = this.wrap(command);
		const started = performance.now();
		const cwd = options.cwd ?? this.config.workspace;
		const result = spawnSync(wrapped.file, wrapped.args, {
			cwd,
			timeout: options.timeoutMs ?? 120_000,
			encoding: "utf8",
			maxBuffer: 32 * 1024 * 1024,
			env: { ...process.env, ...options.env },
		});
		const durationMs = Math.round(performance.now() - started);
		const stdout = redact(result.stdout ?? "").text;
		const stderr = redact(result.stderr ?? "").text;
		const exitCode = result.status ?? (result.error ? 1 : 0);
		const denial = detectSandboxDenial(exitCode, `${stdout}\n${stderr}`);
		this.record({ at: new Date().toISOString(), tool: "bash", command, decision, executed: true, exitCode });
		return { exitCode, stdout, stderr, durationMs, sandboxDenied: denial.detected, denialSignal: denial.signal };
	}

	/**
	 * Non-blocking `run`: streams output through `onOutput`, honors an abort
	 * signal (the TUI's Esc) and a timeout, and never blocks the event loop, so
	 * rendering and input stay live during a ten-minute test suite.
	 */
	async runAsync(
		command: string,
		options: {
			cwd?: string;
			timeoutMs?: number;
			env?: Record<string, string>;
			signal?: AbortSignal;
			onOutput?: (chunk: string) => void;
		} = {},
	): Promise<CommandOutcome> {
		const decision = this.check({ tool: "bash", command, cwd: options.cwd ?? this.config.workspace });
		if (decision.effect === "deny") {
			this.record({ at: new Date().toISOString(), tool: "bash", command, decision, executed: false });
			return {
				exitCode: 126,
				stdout: "",
				stderr: `denied: ${decision.reason}`,
				durationMs: 0,
				sandboxDenied: false,
			};
		}
		const wrapped = this.wrap(command);
		const started = performance.now();
		const cwd = options.cwd ?? this.config.workspace;
		const maxBytes = 32 * 1024 * 1024;
		return new Promise<CommandOutcome>((resolve) => {
			const child = spawn(wrapped.file, wrapped.args, {
				cwd,
				env: { ...process.env, ...options.env },
				stdio: ["ignore", "pipe", "pipe"],
				detached: process.platform !== "win32",
			});
			let stdout = "";
			let stderr = "";
			let killedBy: "timeout" | "abort" | undefined;
			const kill = (reason: "timeout" | "abort") => {
				killedBy = reason;
				try {
					// Kill the whole process group: test runners spawn workers.
					if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
					else child.kill("SIGKILL");
				} catch {
					child.kill("SIGKILL");
				}
			};
			const timer = setTimeout(() => kill("timeout"), options.timeoutMs ?? 120_000);
			const onAbort = () => kill("abort");
			options.signal?.addEventListener("abort", onAbort, { once: true });
			child.stdout.setEncoding("utf8");
			child.stderr.setEncoding("utf8");
			child.stdout.on("data", (chunk: string) => {
				if (stdout.length < maxBytes) stdout += chunk;
				options.onOutput?.(chunk);
			});
			child.stderr.on("data", (chunk: string) => {
				if (stderr.length < maxBytes) stderr += chunk;
				options.onOutput?.(chunk);
			});
			child.on("close", (code) => {
				clearTimeout(timer);
				options.signal?.removeEventListener("abort", onAbort);
				const durationMs = Math.round(performance.now() - started);
				let exitCode = code ?? 1;
				if (killedBy === "timeout") {
					exitCode = 124;
					stderr += `\n[killed after ${options.timeoutMs ?? 120_000}ms timeout]`;
				} else if (killedBy === "abort") {
					exitCode = 130;
					stderr += "\n[interrupted]";
				}
				const cleanOut = redact(stdout).text;
				const cleanErr = redact(stderr).text;
				const denial = detectSandboxDenial(exitCode, `${cleanOut}\n${cleanErr}`);
				this.record({ at: new Date().toISOString(), tool: "bash", command, decision, executed: true, exitCode });
				resolve({
					exitCode,
					stdout: cleanOut,
					stderr: cleanErr,
					durationMs,
					sandboxDenied: denial.detected,
					denialSignal: denial.signal,
				});
			});
			child.on("error", (error) => {
				clearTimeout(timer);
				resolve({
					exitCode: 127,
					stdout,
					stderr: `${stderr}\n${error.message}`,
					durationMs: Math.round(performance.now() - started),
					sandboxDenied: false,
				});
			});
		});
	}

	private record(record: AuditRecord): void {
		this.audit.record({ ...record, command: record.command ? redact(record.command).text : undefined });
	}
}
