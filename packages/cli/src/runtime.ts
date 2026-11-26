// @bedrock/cli: shared runtime wiring for every mode.

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { Ai, configuredProviders, defaultAuthPath, FileCredentialStore } from "@bedrock/ai";
import { ArtifactStore, EventLog } from "@bedrock/context";
import { Ledger } from "@bedrock/ledger";
import { type BedrockConfig, createId, type Id } from "@bedrock/protocol";
import { FileAuditLog, Sandbox } from "@bedrock/sandbox";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { installScript, loadScript } from "./scripted.ts";

export interface Runtime {
	config: BedrockConfig;
	ai: Ai;
	ledger: Ledger;
	artifacts: ArtifactStore;
	sandbox: Sandbox;
	eventLog: EventLog;
	audit: FileAuditLog;
	missionId: Id<"mission">;
	sessionId: Id<"session">;
	/** Set when BEDROCK_SCRIPT replaced the real models. */
	scripted?: string;
	close(): void;
}

export interface RuntimeOptions {
	config: BedrockConfig;
	workspace: string;
	/** Autonomous modes get `yolo` unless the config says otherwise. */
	autonomous: boolean;
	models?: ReturnType<typeof builtinModels>;
}

export function providerModels() {
	return builtinModels({ credentials: new FileCredentialStore() });
}

/** Resolve provider availability before the first model request, not when opening the UI. */
export async function prepareAi(ai: Ai, scripted?: string): Promise<void> {
	if (!scripted) ai.setAvailableProviders(await configuredProviders(ai.models));
	ai.resolve("worker");
}

/** Prevents credential files from entering a workspace snapshot or bind mount. */
export function assertExternalAuth(workspace: string, authPath = defaultAuthPath()): void {
	const canonical = (path: string): string => {
		if (existsSync(path)) return realpathSync(path);
		const parent = dirname(path);
		return parent === path ? path : join(canonical(parent), basename(path));
	};
	const authPaths = [authPath, canonical(authPath), canonical(dirname(authPath))];
	for (const root of [workspace, canonical(workspace)]) {
		for (const path of authPaths) {
			const rel = relative(root, path);
			if (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
				throw new Error(
					"Bedrock's auth store must be outside the workspace; set BEDROCK_HOME to a private external directory",
				);
		}
	}
}

/**
 * Builds the objects a mode needs. State lives under `<workspace>/.bedrock`:
 * the ledger is SQLite, the event log JSONL, artifacts content-addressed, and the
 * audit log append-only.
 */
export function createRuntime(options: RuntimeOptions): Runtime {
	const authPath = defaultAuthPath();
	assertExternalAuth(options.workspace, authPath);
	const stateDir = options.config.stateDir;
	mkdirSync(stateDir, { recursive: true });
	const sessionId = createId("session");
	const missionId = createId("mission");
	const ledger = new Ledger({ path: join(stateDir, "ledger.sqlite") });
	const artifacts = new ArtifactStore({ kind: "file", root: join(stateDir, "artifacts") });
	const audit = new FileAuditLog(join(stateDir, "audit.jsonl"));
	const eventLog = new EventLog({ sessionId, path: join(stateDir, "sessions", `${sessionId}.jsonl`) });
	const sandbox = new Sandbox({
		workspace: options.workspace,
		preset: options.config.permissions,
		autonomous: options.autonomous,
		containerImage: options.config.isolation === "container" ? options.config.containerImage : undefined,
		hostWorkspace: options.workspace,
		network: "none",
		privatePaths: [authPath, `${authPath}.lock`],
		audit,
	});
	const models = options.models ?? providerModels();
	const scriptPath = process.env.BEDROCK_SCRIPT;
	const config = scriptPath ? structuredClone(options.config) : options.config;
	if (scriptPath) installScript(models, config, loadScript(scriptPath));
	const ai = new Ai({ config, models });
	excludeStateDir(options.workspace, stateDir);
	return {
		config,
		ai,
		ledger,
		artifacts,
		sandbox,
		eventLog,
		audit,
		missionId,
		sessionId,
		scripted: scriptPath,
		close: () => ledger.close(),
	};
}

/**
 * Keeps `.bedrock/` out of the user's git status by adding it to the local,
 * uncommitted `.git/info/exclude` (never to a tracked .gitignore).
 */
export function excludeStateDir(workspace: string, stateDir: string): void {
	const gitDir = spawnSync("git", ["rev-parse", "--git-common-dir"], { cwd: workspace, encoding: "utf8" });
	if (gitDir.status !== 0) return;
	const relative = stateDir.startsWith(`${workspace}/`) ? stateDir.slice(workspace.length + 1) : undefined;
	if (!relative) return;
	const ignored = spawnSync("git", ["check-ignore", "-q", relative], { cwd: workspace });
	if (ignored.status === 0) return;
	const exclude = join(workspace, gitDir.stdout.trim(), "info", "exclude");
	const existing = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
	mkdirSync(join(exclude, ".."), { recursive: true });
	appendFileSync(exclude, `${existing.endsWith("\n") || existing.length === 0 ? "" : "\n"}/${relative}/\n`);
}

/** True when the process can talk to a human (a TTY on stdin). */
export function isInteractive(): boolean {
	return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/** Reads one line from stdin; resolves undefined on EOF or in non-interactive runs. */
export async function readLine(prompt: string): Promise<string | undefined> {
	if (!isInteractive()) return undefined;
	process.stdout.write(prompt);
	return new Promise((resolve) => {
		const onData = (chunk: Buffer | string) => {
			process.stdin.off("data", onData);
			process.stdin.pause();
			const value = chunk.toString().trim();
			resolve(value.length > 0 ? value : undefined);
		};
		process.stdin.resume();
		process.stdin.once("data", onData);
	});
}
