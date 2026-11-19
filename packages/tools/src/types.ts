// @bedrock/tools: shared context and helpers for every tool.

import { readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ArtifactStore } from "@bedrock/context";
import type { PermissionDecision, PermissionRequest } from "@bedrock/protocol";
import type { Sandbox, WrappedCommand } from "@bedrock/sandbox";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { JsonValue } from "@earendil-works/pi-ai";

export interface ToolContext {
	/** Absolute workspace root. Paths outside it are refused by the sandbox. */
	workspace: string;
	/** Max characters of a file read in one call. */
	maxReadChars?: number;
	sandbox: Sandbox;
	artifacts: ArtifactStore;
	/** Asks the human a question; returns the answer, or undefined when nobody can answer. */
	ask?: (question: string, options?: string[]) => Promise<string | undefined>;
	/** Called before a tool is blocked so the TUI can show an approval prompt. */
	onPermission?: (request: PermissionRequest, decision: PermissionDecision) => Promise<boolean>;
	/** Per-session todo list, owned by the todo tool. */
	todos?: TodoItem[];
	/** Background processes started by the bash tool. */
	processes?: Map<string, { command: string; startedAt: number; kill: () => void }>;
}

export interface TodoItem {
	id: number;
	text: string;
	status: "pending" | "in_progress" | "completed" | "cancelled";
}

/** Tool details must be JSON; this narrows our richer detail objects at the boundary. */
export function toDetails(value: Record<string, unknown>): JsonValue {
	return value as unknown as JsonValue;
}

export function text(value: string, details?: Record<string, unknown>): AgentToolResult<JsonValue | undefined> {
	return { content: [{ type: "text", text: value }], details: details ? toDetails(details) : undefined };
}

export function failure(value: string, details?: Record<string, unknown>): AgentToolResult<JsonValue | undefined> {
	return {
		content: [{ type: "text", text: value }],
		details: details ? toDetails(details) : undefined,
		isError: true,
	};
}

/** Resolves a user-supplied path against the workspace and refuses escapes. */
export function resolveInside(
	workspace: string,
	path: string,
): { ok: true; absolute: string; relative: string } | { ok: false; error: string } {
	const absolute = isAbsolute(path) ? resolve(path) : resolve(workspace, path);
	const rel = relative(workspace, absolute);
	if (rel.startsWith("..") || isAbsolute(rel)) {
		return { ok: false, error: `path "${path}" is outside the workspace (${workspace})` };
	}
	return { ok: true, absolute, relative: rel.split(sep).join("/") };
}

/** Reads at most `maxBytes` of a file, refusing binary files with a clear message. */
export function readTextFile(
	workspace: string,
	path: string,
	maxBytes: number,
):
	| { ok: true; absolute: string; relative: string; content: string; bytes: number; lines: number }
	| { ok: false; error: string; absolute?: string } {
	const resolved = resolveInside(workspace, path);
	if (!resolved.ok) return resolved;
	let stats: ReturnType<typeof statSync>;
	try {
		stats = statSync(resolved.absolute);
	} catch {
		return { ok: false, error: `file not found: ${resolved.relative}` };
	}
	if (stats.isDirectory()) return { ok: false, error: `${resolved.relative} is a directory; use find or ls` };
	if (stats.size > 10 * 1024 * 1024)
		return {
			ok: false,
			error: `${resolved.relative} is ${stats.size} bytes; read a window with offset/limit or grep it`,
		};
	const buffer = readFileSync(resolved.absolute);
	const sniff = buffer.subarray(0, 4096);
	if (sniff.includes(0))
		return {
			ok: false,
			error: `${resolved.relative} looks binary; use bash with an appropriate viewer`,
			absolute: resolved.absolute,
		};
	const content = buffer.toString("utf8");
	const lines = content.split("\n").length;
	return {
		ok: true,
		absolute: resolved.absolute,
		relative: resolved.relative,
		content: content.slice(0, maxBytes),
		bytes: stats.size,
		lines,
	};
}

/** Runs a command through the sandbox only when the permission decision allows it. */
export async function runSandboxed(
	ctx: ToolContext,
	command: string,
	options: { timeoutMs?: number; cwd?: string } = {},
): Promise<
	| { ok: true; outcome: ReturnType<Sandbox["run"]>; wrapped: WrappedCommand }
	| { ok: false; error: string; decision: PermissionDecision }
> {
	const request: PermissionRequest = { tool: "bash", command, cwd: options.cwd ?? ctx.workspace };
	const decision = ctx.sandbox.check(request);
	if (decision.effect === "deny") return { ok: false, error: `denied: ${decision.reason}`, decision };
	if (decision.effect === "ask") {
		const approved = ctx.onPermission ? await ctx.onPermission(request, decision) : false;
		if (!approved) return { ok: false, error: `not approved: ${decision.reason}`, decision };
	}
	const wrapped = ctx.sandbox.wrap(command);
	const outcome = ctx.sandbox.run(command, options);
	return { ok: true, outcome, wrapped };
}

/** A compact unified diff: `context` unchanged lines around each change, standard hunk headers. */
export function unifiedDiff(oldText: string, newText: string, oldLabel: string, newLabel: string, context = 3): string {
	const before = oldText.split("\n");
	const after = newText.split("\n");
	type Op = { kind: " " | "-" | "+"; text: string; oldIndex: number; newIndex: number };
	const ops: Op[] = [];
	// LCS table; diffs are per file and small enough that O(n*m) is acceptable.
	const table: number[][] = Array.from({ length: before.length + 1 }, () =>
		new Array<number>(after.length + 1).fill(0),
	);
	for (let i = before.length - 1; i >= 0; i--) {
		for (let j = after.length - 1; j >= 0; j--) {
			table[i][j] = before[i] === after[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
		}
	}
	let i = 0;
	let j = 0;
	while (i < before.length && j < after.length) {
		if (before[i] === after[j]) {
			ops.push({ kind: " ", text: before[i], oldIndex: i, newIndex: j });
			i++;
			j++;
		} else if (table[i + 1][j] >= table[i][j + 1]) {
			ops.push({ kind: "-", text: before[i], oldIndex: i, newIndex: j });
			i++;
		} else {
			ops.push({ kind: "+", text: after[j], oldIndex: i, newIndex: j });
			j++;
		}
	}
	while (i < before.length) ops.push({ kind: "-", text: before[i], oldIndex: i++, newIndex: j });
	while (j < after.length) ops.push({ kind: "+", text: after[j], oldIndex: i, newIndex: j++ });

	const changes = ops.map((op, index) => (op.kind === " " ? -1 : index)).filter((index) => index >= 0);
	if (changes.length === 0) return "";
	// Group changes whose unchanged gap is short enough to keep in one hunk.
	const groups: Array<{ start: number; end: number }> = [];
	for (const index of changes) {
		const last = groups.at(-1);
		if (last && index - last.end <= context * 2) last.end = index;
		else groups.push({ start: index, end: index });
	}
	const hunks: string[] = [];
	for (const group of groups) {
		const from = Math.max(0, group.start - context);
		const to = Math.min(ops.length, group.end + context + 1);
		const slice = ops.slice(from, to);
		const oldStart = (slice.find((op) => op.kind !== "+")?.oldIndex ?? slice[0]?.oldIndex ?? 0) + 1;
		const newStart = (slice.find((op) => op.kind !== "-")?.newIndex ?? slice[0]?.newIndex ?? 0) + 1;
		const oldCount = slice.filter((op) => op.kind !== "+").length;
		const newCount = slice.filter((op) => op.kind !== "-").length;
		hunks.push(
			`@@ -${oldCount === 0 ? oldStart - 1 : oldStart},${oldCount} +${newCount === 0 ? newStart - 1 : newStart},${newCount} @@`,
		);
		hunks.push(...slice.map((op) => `${op.kind}${op.text}`));
	}
	return `--- a/${oldLabel}\n+++ b/${newLabel}\n${hunks.join("\n")}`;
}

/** Counts additions and deletions between two texts. */
export function diffStat(oldText: string, newText: string): { additions: number; deletions: number } {
	const diff = unifiedDiff(oldText, newText, "a", "b", 0);
	let additions = 0;
	let deletions = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("+") && !line.startsWith("+++")) additions++;
		if (line.startsWith("-") && !line.startsWith("---")) deletions++;
	}
	return { additions, deletions };
}
