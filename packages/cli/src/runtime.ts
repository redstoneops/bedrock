// @bedrock/cli: shared runtime wiring for every mode.

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Ai } from "@bedrock/ai";
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

/**
 * Builds the objects a mode needs. State lives under `<workspace>/.bedrock`:
 * the ledger is SQLite, the event log JSONL, artifacts content-addressed, and the
 * audit log append-only.
 */
export function createRuntime(options: RuntimeOptions): Runtime {
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
		audit,
	});
	const models = options.models ?? builtinModels();
	const scriptPath = process.env.BEDROCK_SCRIPT;
	if (scriptPath) installScript(models, options.config, loadScript(scriptPath));
	const ai = new Ai({ config: options.config, models });
	excludeStateDir(options.workspace, stateDir);
	return {
		config: options.config,
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

/** Environment variables that indicate at least one provider is configured. */
const CREDENTIAL_ENV = [
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_AUTH_TOKEN",
	"OPENAI_API_KEY",
	"GOOGLE_API_KEY",
	"GEMINI_API_KEY",
	"DEEPSEEK_API_KEY",
	"OPENROUTER_API_KEY",
	"GROQ_API_KEY",
	"MISTRAL_API_KEY",
	"XAI_API_KEY",
	"MOONSHOT_API_KEY",
	"ZAI_API_KEY",
	"AWS_ACCESS_KEY_ID",
	"AZURE_OPENAI_API_KEY",
];

/**
 * True when an obvious provider credential is present. A missing credential is a
 * warning, not a hard stop: OAuth logins and cloud profiles are valid too.
 */
export function hasProviderCredentials(env: NodeJS.ProcessEnv = process.env): boolean {
	if (env.BEDROCK_SCRIPT) return true;
	return CREDENTIAL_ENV.some((name) => (env[name] ?? "").trim().length > 0);
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
