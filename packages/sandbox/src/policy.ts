// @bedrock/sandbox: permission presets and the rule engine.
//
// Presets are ordered rule tables, not code branches, so the TUI can show exactly
// which rule decided a call and users can extend them from config. The first
// matching rule wins.

import { isAbsolute, relative, resolve, sep } from "node:path";
import type {
	PermissionDecision,
	PermissionPolicy,
	PermissionPolicyConfig,
	PermissionPreset,
	PermissionRequest,
} from "@bedrock/protocol";
import { classifyCommand } from "./classify.ts";

const WRITE_TOOLS = new Set(["write", "edit", "str_replace", "apply_patch", "ast_edit", "todo"]);
const READ_TOOLS = new Set([
	"read",
	"grep",
	"find",
	"ls",
	"glob",
	"lsp",
	"history",
	"ledger",
	"web_search",
	"web_fetch",
	"fetch",
	"artifact",
	"checks",
]);

function isWebTool(tool: string): boolean {
	return tool === "web_search" || tool === "web_fetch";
}

/** Files never readable or writable by a worker, regardless of preset. */
export const SECRET_PATTERNS = [
	"**/.env",
	"**/.env.*",
	"**/*.pem",
	"**/*.key",
	"**/id_rsa*",
	"**/.ssh/**",
	"**/.aws/credentials",
	"**/.config/gh/hosts.yml",
];

/** Directories a worker must not rewrite: its own bookkeeping, gate and holdout material. */
export const PROTECTED_WRITE_PATTERNS = [".git/**", ".git", ".bedrock/gate/**", ".bedrock/holdout/**"];

/** Converts a glob (`**`, `*`, `?`, `{a,b}`) to an anchored RegExp. */
export function globToRegExp(glob: string): RegExp {
	let out = "";
	for (let index = 0; index < glob.length; index++) {
		const char = glob[index];
		if (char === "*") {
			if (glob[index + 1] === "*") {
				// A trailing `**` also matches zero segments, so `src/**` matches `src/a.ts`.
				out += glob[index + 2] === undefined ? "(?:.*)?" : ".*";
				index++;
				if (glob[index + 1] === "/") index++;
			} else {
				out += "[^/]*";
			}
		} else if (char === "?") {
			out += "[^/]";
		} else if (char === "{") {
			const end = glob.indexOf("}", index);
			if (end < 0) {
				out += "\\{";
			} else {
				const parts = glob
					.slice(index + 1, end)
					.split(",")
					.map((part) => part.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*"));
				out += `(${parts.join("|")})`;
				index = end;
			}
		} else {
			out += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
		}
	}
	return new RegExp(`^${out}$`);
}

/** True when `path` (absolute or workspace-relative) matches any glob. */
export function matchesAnyGlob(path: string, globs: string[], workspace: string): boolean {
	const absolute = isAbsolute(path) ? path : resolve(workspace, path);
	const rel = relative(workspace, absolute).split(sep).join("/");
	const normalized = absolute.split(sep).join("/");
	return globs.some((glob) => {
		const pattern = globToRegExp(glob);
		// Glob is anchored, so test the path both relative to the workspace and
		// as an absolute path with the workspace prefix stripped for `**` patterns.
		return pattern.test(rel) || pattern.test(normalized) || (normalized.endsWith(`/${rel}`) && pattern.test(rel));
	});
}

/** True when a shell command names a credential file as an argument, e.g. `cat .env`. */
function commandReadsSecret(command: string | undefined): boolean {
	if (!command) return false;
	const words = command.split(/\s+/);
	return words.some(
		(word) => /(^|[/])(\.env(\.[\w.-]+)?|\.pem|id_rsa[\w.]*)$/.test(word) || /\.ssh\/|\.aws\/credentials/.test(word),
	);
}

function isOutsideWorkspace(path: string, workspace: string): boolean {
	const absolute = isAbsolute(path) ? path : resolve(workspace, path);
	const rel = relative(workspace, absolute);
	return rel.startsWith("..") || isAbsolute(rel);
}

interface Rule {
	id: string;
	effect: "allow" | "deny" | "ask";
	reason: string;
	test: (request: PermissionRequest, workspace: string) => boolean;
}

/** Ordered rules for a preset. Exported so the TUI can explain a decision. */
export function presetRules(preset: PermissionPreset): Rule[] {
	if (preset === "yolo") {
		return [
			{ id: "yolo", effect: "allow", reason: "yolo preset allows every call inside the sandbox", test: () => true },
		];
	}

	const protectSecrets: Rule = {
		id: "protect-secrets",
		effect: "deny",
		reason: "secret files are never exposed to a worker; inject them at execution time",
		test: (request, workspace) =>
			(request.paths ?? []).some((path) => matchesAnyGlob(path, SECRET_PATTERNS, workspace)) ||
			commandReadsSecret(request.command),
	};
	const protectGate: Rule = {
		id: "protect-gate",
		effect: "deny",
		reason: "gate and holdout material cannot be modified by a worker",
		test: (request) =>
			WRITE_TOOLS.has(request.tool) &&
			(request.paths ?? []).some((path) =>
				/(^|\/)(\.bedrock\/(gate|holdout)|\.git)\//.test(path.replaceAll("\\", "/")),
			),
	};

	if (preset === "strict") {
		return [
			protectSecrets,
			protectGate,
			{
				id: "strict-no-shell",
				effect: "deny",
				reason: "strict mode forbids shell commands; run them through the human",
				test: (request) => request.tool === "bash",
			},
			{
				id: "strict-reads",
				effect: "ask",
				reason: "strict mode asks before every read",
				test: (request) => READ_TOOLS.has(request.tool),
			},
			{
				id: "strict-fallback",
				effect: "ask",
				reason: "strict mode asks for anything unclassified",
				test: () => true,
			},
		];
	}

	return [
		protectSecrets,
		protectGate,
		{
			id: "standard-web",
			effect: "allow",
			reason: "the user explicitly enabled this bounded web tool",
			test: (request) => isWebTool(request.tool),
		},
		{
			id: "standard-writes-foreign",
			effect: "deny",
			reason: "writes outside the workspace are not allowed",
			test: (request, workspace) =>
				WRITE_TOOLS.has(request.tool) && (request.paths ?? []).some((path) => isOutsideWorkspace(path, workspace)),
		},
		{
			id: "standard-reads",
			effect: "allow",
			reason: "reads inside the workspace are allowed",
			test: (request) => READ_TOOLS.has(request.tool),
		},
		{
			id: "standard-writes-workspace",
			effect: "allow",
			reason: "writes inside the workspace are allowed",
			test: (request) => WRITE_TOOLS.has(request.tool),
		},
		{
			id: "standard-safe-shell",
			effect: "allow",
			reason: "read-only shell commands are allowed",
			test: (request) =>
				request.tool === "bash" &&
				request.command !== undefined &&
				classifyCommand(request.command).class === "read_only",
		},
		{
			id: "standard-shell",
			effect: "ask",
			reason: "shell commands that write, reach the network or are unclassified need approval",
			test: (request) => request.tool === "bash",
		},
		{ id: "standard-other", effect: "ask", reason: "unclassified tool call", test: () => true },
	];
}

/** Evaluates a request against a preset. */
export function evaluatePreset(
	preset: PermissionPreset,
	request: PermissionRequest,
	workspace: string,
): PermissionDecision {
	for (const rule of presetRules(preset)) {
		if (rule.test(request, workspace)) return { effect: rule.effect, reason: rule.reason, ruleId: rule.id };
	}
	return { effect: "ask", reason: "no rule matched", ruleId: "fallback" };
}

/** The stateful policy object tools call. */
export class SandboxPolicyEngine implements PermissionPolicy {
	readonly preset: PermissionPreset;
	#config: PermissionPolicyConfig;

	constructor(config: PermissionPolicyConfig) {
		this.preset = config.preset;
		this.#config = config;
	}

	check(request: PermissionRequest): PermissionDecision {
		const decision = evaluatePreset(this.preset, request, this.#config.workspace);
		// Autonomous runs cannot ask a human. Inside an isolated workspace with an
		// enforced sandbox, `ask` becomes `allow`; the OS sandbox still bounds damage.
		if (decision.effect === "ask" && this.#config.autonomous && this.#config.isolated && !isWebTool(request.tool)) {
			return { effect: "allow", reason: `${decision.reason} (autonomous, isolated)`, ruleId: decision.ruleId };
		}
		return decision;
	}
}
