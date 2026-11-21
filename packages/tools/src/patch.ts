// @bedrock/tools: fallback edit formats, for model families that do better with them.
//
// `str_replace` replaces one exact, unique occurrence. `apply_patch` accepts the
// Codex patch grammar (idea from OpenAI Codex, Apache-2.0; reimplemented):
//
//   *** Begin Patch
//   *** Add File: path        followed by "+" lines
//   *** Delete File: path
//   *** Update File: path     optionally "*** Move to: new/path", then hunks:
//   @@ optional header
//    context line
//   -removed line
//   +added line
//   *** End Patch
//
// Hunks are located by their context and removed lines, trying an exact match,
// then ignoring trailing whitespace, then ignoring all surrounding whitespace.
// Every file is planned before anything is written.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentTool, AgentToolParams, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { JsonValue } from "@earendil-works/pi-ai";
import { obj, str } from "@earendil-works/pi-schema";
import { normalize } from "./hashline.ts";
import { diffStat, failure, resolveInside, type ToolContext, toDetails, unifiedDiff } from "./types.ts";

export type PatchOperation =
	| { kind: "add"; path: string; lines: string[] }
	| { kind: "delete"; path: string }
	| { kind: "update"; path: string; moveTo?: string; hunks: Hunk[] };

export interface Hunk {
	header?: string;
	/** Lines as they are now (context and removed). */
	before: string[];
	/** Lines as they should be (context and added). */
	after: string[];
	/** The hunk is anchored at the end of the file. */
	endOfFile: boolean;
}

/** Parses a Codex-style patch. */
export function parseApplyPatch(
	text: string,
): { ok: true; operations: PatchOperation[] } | { ok: false; error: string } {
	const lines = normalize(text).split("\n");
	let index = lines.findIndex((line) => line.trim() === "*** Begin Patch");
	if (index < 0) return { ok: false, error: 'a patch must start with "*** Begin Patch"' };
	index += 1;
	const operations: PatchOperation[] = [];
	while (index < lines.length) {
		const line = lines[index];
		if (line.trim() === "*** End Patch")
			return operations.length > 0 ? { ok: true, operations } : { ok: false, error: "the patch has no operations" };
		const add = /^\*\*\* Add File: (.+)$/.exec(line);
		const del = /^\*\*\* Delete File: (.+)$/.exec(line);
		const update = /^\*\*\* Update File: (.+)$/.exec(line);
		if (add) {
			const body: string[] = [];
			index += 1;
			while (index < lines.length && !lines[index].startsWith("*** ")) {
				if (!lines[index].startsWith("+"))
					return {
						ok: false,
						error: `added file ${add[1]}: every line must start with "+" (got "${lines[index].slice(0, 40)}")`,
					};
				body.push(lines[index].slice(1));
				index += 1;
			}
			operations.push({ kind: "add", path: add[1].trim(), lines: body });
			continue;
		}
		if (del) {
			operations.push({ kind: "delete", path: del[1].trim() });
			index += 1;
			continue;
		}
		if (update) {
			index += 1;
			let moveTo: string | undefined;
			const move = /^\*\*\* Move to: (.+)$/.exec(lines[index] ?? "");
			if (move) {
				moveTo = move[1].trim();
				index += 1;
			}
			const hunks: Hunk[] = [];
			let current: Hunk | undefined;
			while (index < lines.length && !/^\*\*\* (Add|Delete|Update) File: |^\*\*\* End Patch/.test(lines[index])) {
				const row = lines[index];
				if (row.startsWith("@@")) {
					current = { header: row.slice(2).trim() || undefined, before: [], after: [], endOfFile: false };
					hunks.push(current);
				} else if (row.trim() === "*** End of File") {
					if (current) current.endOfFile = true;
				} else {
					if (!current) {
						current = { before: [], after: [], endOfFile: false };
						hunks.push(current);
					}
					const marker = row[0];
					const body = row.slice(1);
					if (marker === " " || row === "") {
						current.before.push(body);
						current.after.push(body);
					} else if (marker === "-") current.before.push(body);
					else if (marker === "+") current.after.push(body);
					else
						return {
							ok: false,
							error: `update ${update[1]}: unexpected line "${row.slice(0, 60)}" (lines start with " ", "-", "+" or "@@")`,
						};
				}
				index += 1;
			}
			if (hunks.length === 0 && !moveTo) return { ok: false, error: `update ${update[1]} has no hunks` };
			operations.push({ kind: "update", path: update[1].trim(), moveTo, hunks });
			continue;
		}
		if (line.trim().length === 0) {
			index += 1;
			continue;
		}
		return {
			ok: false,
			error: `unexpected line "${line.slice(0, 60)}"; expected "*** Add File:", "*** Update File:", "*** Delete File:" or "*** End Patch"`,
		};
	}
	return { ok: false, error: 'the patch must end with "*** End Patch"' };
}

const MATCHERS: Array<(a: string, b: string) => boolean> = [
	(a, b) => a === b,
	(a, b) => a.trimEnd() === b.trimEnd(),
	(a, b) => a.trim() === b.trim(),
];

function findSequence(lines: string[], needle: string[], from: number, endOfFile: boolean): number {
	if (needle.length === 0) return endOfFile ? lines.length : from;
	for (const equal of MATCHERS) {
		const starts = endOfFile
			? [lines.length - needle.length]
			: Array.from({ length: Math.max(0, lines.length - needle.length - from + 1) }, (_, offset) => from + offset);
		for (const start of starts) {
			if (start < 0) continue;
			if (needle.every((line, offset) => equal(lines[start + offset] ?? "\u0000", line))) return start;
		}
	}
	return -1;
}

/** Applies hunks to one file's content, in order. */
export function applyHunks(
	content: string,
	hunks: Hunk[],
	path: string,
): { ok: true; content: string } | { ok: false; error: string } {
	const hadNewline = content.endsWith("\n");
	const lines = normalize(content).split("\n");
	if (hadNewline) lines.pop();
	let cursor = 0;
	for (const [number, hunk] of hunks.entries()) {
		let from = cursor;
		if (hunk.header) {
			const anchor = lines.findIndex((line, index) => index >= cursor && line.includes(hunk.header as string));
			if (anchor >= 0) from = anchor;
		}
		const start = findSequence(lines, hunk.before, from, hunk.endOfFile);
		if (start < 0) {
			const preview = hunk.before.slice(0, 3).join("\\n");
			return {
				ok: false,
				error: `${path}: hunk ${number + 1} does not match the file (looked for "${preview}"). Read the file again and copy the context exactly.`,
			};
		}
		lines.splice(start, hunk.before.length, ...hunk.after);
		cursor = start + hunk.after.length;
	}
	return { ok: true, content: `${lines.join("\n")}${hadNewline || lines.length > 0 ? "\n" : ""}` };
}

const applyPatchParameters = obj({
	patch: str({ description: "The full patch text, from *** Begin Patch to *** End Patch." }),
});

export function createApplyPatchTool(ctx: ToolContext): AgentTool<typeof applyPatchParameters, JsonValue | undefined> {
	return {
		name: "apply_patch",
		label: "Apply patch",
		description: `Edit files with a patch. Format:
*** Begin Patch
*** Update File: src/app.ts
@@ function main
 unchanged context line
-old line
+new line
*** Add File: src/new.ts
+file content
*** Delete File: src/old.ts
*** End Patch
Include three lines of context around each change so the hunk is unambiguous. All files are checked before any is written.`,
		parameters: applyPatchParameters,
		execute: async (
			_toolCallId,
			params: AgentToolParams<typeof applyPatchParameters>,
		): Promise<AgentToolResult<JsonValue | undefined>> => {
			const parsed = parseApplyPatch(params.patch);
			if (!parsed.ok) return failure(parsed.error);
			type Planned = { absolute: string; relative: string; before: string; after?: string; removeFrom?: string };
			const planned: Planned[] = [];
			for (const operation of parsed.operations) {
				const resolved = resolveInside(ctx.workspace, operation.path);
				if (!resolved.ok) return failure(resolved.error);
				const permission = ctx.sandbox.check({ tool: "apply_patch", paths: [resolved.absolute] });
				if (permission.effect === "deny") return failure(`denied: ${permission.reason}`);
				const exists = existsSync(resolved.absolute);
				if (operation.kind === "add") {
					if (exists) return failure(`${resolved.relative} already exists; use *** Update File`);
					planned.push({
						absolute: resolved.absolute,
						relative: resolved.relative,
						before: "",
						after: `${operation.lines.join("\n")}\n`,
					});
				} else if (operation.kind === "delete") {
					if (!exists) return failure(`cannot delete ${resolved.relative}: not found`);
					planned.push({
						absolute: resolved.absolute,
						relative: resolved.relative,
						before: readFileSync(resolved.absolute, "utf8"),
						removeFrom: resolved.absolute,
					});
				} else {
					if (!exists) return failure(`cannot update ${resolved.relative}: not found`);
					const before = readFileSync(resolved.absolute, "utf8");
					const applied = applyHunks(before, operation.hunks, resolved.relative);
					if (!applied.ok) return failure(applied.error);
					if (operation.moveTo) {
						const target = resolveInside(ctx.workspace, operation.moveTo);
						if (!target.ok) return failure(target.error);
						planned.push({
							absolute: target.absolute,
							relative: target.relative,
							before: "",
							after: applied.content,
						});
						planned.push({
							absolute: resolved.absolute,
							relative: resolved.relative,
							before,
							removeFrom: resolved.absolute,
						});
					} else
						planned.push({
							absolute: resolved.absolute,
							relative: resolved.relative,
							before,
							after: applied.content,
						});
				}
			}
			let additions = 0;
			let deletions = 0;
			const report: string[] = [];
			for (const plan of planned) {
				if (plan.after !== undefined) {
					mkdirSync(dirname(plan.absolute), { recursive: true });
					writeFileSync(plan.absolute, plan.after, "utf8");
				}
				if (plan.removeFrom) rmSync(plan.removeFrom);
				const stat = diffStat(plan.before, plan.after ?? "");
				additions += stat.additions;
				deletions += stat.deletions;
				report.push(
					`${plan.relative}: +${stat.additions} -${stat.deletions}\n${unifiedDiff(plan.before, plan.after ?? "", plan.relative, plan.relative)}`,
				);
			}
			return {
				content: [{ type: "text", text: report.join("\n").trimEnd() }],
				details: toDetails({ files: planned.map((plan) => plan.relative), additions, deletions }),
			};
		},
	};
}

const strReplaceParameters = obj({
	path: str({ description: "File to edit, relative to the workspace." }),
	old: str({ description: "Exact text to replace; must occur exactly once. Include enough context to be unique." }),
	new: str({ description: "Replacement text." }),
});

export function createStrReplaceTool(ctx: ToolContext): AgentTool<typeof strReplaceParameters, JsonValue | undefined> {
	return {
		name: "str_replace",
		label: "Replace",
		description:
			"Replace one exact, unique occurrence of text in a file. Fails when the text is missing or appears more than once; add surrounding lines to make it unique.",
		parameters: strReplaceParameters,
		execute: async (
			_toolCallId,
			params: AgentToolParams<typeof strReplaceParameters>,
		): Promise<AgentToolResult<JsonValue | undefined>> => {
			const resolved = resolveInside(ctx.workspace, params.path);
			if (!resolved.ok) return failure(resolved.error);
			const permission = ctx.sandbox.check({ tool: "edit", paths: [resolved.absolute] });
			if (permission.effect === "deny") return failure(`denied: ${permission.reason}`);
			if (!existsSync(resolved.absolute)) return failure(`file not found: ${resolved.relative}`);
			const before = normalize(readFileSync(resolved.absolute, "utf8"));
			const old = normalize(params.old);
			if (old.length === 0) return failure("old text is empty");
			const first = before.indexOf(old);
			if (first < 0)
				return failure(`the text was not found in ${resolved.relative}; read the file and copy it exactly`);
			if (before.indexOf(old, first + 1) >= 0)
				return failure(`the text occurs more than once in ${resolved.relative}; include more context`);
			const after = before.slice(0, first) + normalize(params.new) + before.slice(first + old.length);
			writeFileSync(resolved.absolute, after, "utf8");
			const stat = diffStat(before, after);
			return {
				content: [
					{
						type: "text",
						text: `${resolved.relative}: +${stat.additions} -${stat.deletions}\n${unifiedDiff(before, after, resolved.relative, resolved.relative)}`,
					},
				],
				details: toDetails({ path: resolved.relative, ...stat }),
			};
		},
	};
}
