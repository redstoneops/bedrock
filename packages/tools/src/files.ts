// @bedrock/tools: read, write and hashline edit.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentTool, AgentToolParams, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { JsonValue } from "@earendil-works/pi-ai";
import { int, obj, opt, str } from "@earendil-works/pi-schema";
import {
	applySection,
	contentTag,
	MAX_TAGGED_LINES,
	normalize,
	parsePatch,
	parseSectionHeader,
	renderTaggedFile,
	sectionHeader,
} from "./hashline.ts";
import { diffStat, failure, readTextFile, resolveInside, type ToolContext, toDetails, unifiedDiff } from "./types.ts";

const READ_DESCRIPTION = `Read a text file. Lines are numbered and the first line is a section header with a content tag, for example:

¶src/app.ts#A3F1
1:const x = 1;

Use the tag when you edit the file. If the file changes after this read, the edit is rejected and you must read again. Use offset and limit for large files; the header tag always covers the whole file.`;

const readParameters = obj({
	path: str({ description: "Path relative to the workspace, or absolute inside it." }),
	offset: opt(int({ description: "0-based line to start from.", minimum: 0 })),
	limit: opt(int({ description: `Maximum lines to return (default and max ${MAX_TAGGED_LINES}).`, minimum: 1 })),
});

export function createReadTool(ctx: ToolContext): AgentTool<typeof readParameters, JsonValue | undefined> {
	return {
		name: "read",
		label: "Read",
		description: READ_DESCRIPTION,
		parameters: readParameters,
		execute: async (
			_toolCallId,
			params: AgentToolParams<typeof readParameters>,
		): Promise<AgentToolResult<JsonValue | undefined>> => {
			const file = readTextFile(ctx.workspace, params.path, ctx.maxReadChars ?? 400_000);
			if (!file.ok) return failure(file.error);
			const rendered = renderTaggedFile(file.relative, file.content, { offset: params.offset, limit: params.limit });
			return {
				content: [{ type: "text", text: rendered.text }],
				details: toDetails({
					path: file.relative,
					tag: rendered.tag,
					lines: rendered.totalLines,
					truncated: rendered.truncated,
				}),
			};
		},
	};
}

const WRITE_DESCRIPTION = `Write a file. For a new file use the header ¶path (no tag) followed by the content with no line numbers:

¶src/new.ts
export const x = 1;

To replace an existing file you must first read it and keep its tag in the header; a mismatch is rejected. Prefer edit for changes to existing files.`;

const writeParameters = obj({
	path: str({ description: "Path relative to the workspace." }),
	content: str({ description: "Section header line, then the full file content with no line numbers." }),
});

export function createWriteTool(ctx: ToolContext): AgentTool<typeof writeParameters, JsonValue | undefined> {
	return {
		name: "write",
		label: "Write",
		description: WRITE_DESCRIPTION,
		parameters: writeParameters,
		execute: async (
			_toolCallId,
			params: AgentToolParams<typeof writeParameters>,
		): Promise<AgentToolResult<JsonValue | undefined>> => {
			const resolved = resolveInside(ctx.workspace, params.path);
			if (!resolved.ok) return failure(resolved.error);
			const permission = ctx.sandbox.check({ tool: "write", paths: [resolved.absolute] });
			if (permission.effect === "deny") return failure(`denied: ${permission.reason}`);
			if (
				permission.effect === "ask" &&
				!(ctx.onPermission && (await ctx.onPermission({ tool: "write", paths: [resolved.absolute] }, permission)))
			) {
				return failure(`not approved: ${permission.reason}`);
			}

			// The patch body is the header line plus unnumbered content.
			const normalized = normalize(params.content);
			const header = parseSectionHeader(normalized.split("\n")[0] ?? "");
			let body = normalized;
			let tag: string | undefined;
			if (header && (header.path === params.path || header.path === resolved.relative)) {
				body = normalized.slice(normalized.indexOf("\n") + 1);
				tag = header.tag;
			}
			let oldText = "";
			if (existsSync(resolved.absolute)) {
				oldText = normalize(readFileSync(resolved.absolute, "utf8"));
				if (!tag)
					return failure(
						`${resolved.relative} exists; read it first and include its tag in the header, or use edit`,
					);
				const current = contentTag(oldText);
				if (tag !== current)
					return failure(
						`${resolved.relative} changed since it was read (expected #${tag}, current #${current}). Re-read and retry.`,
					);
			}
			const next = body.endsWith("\n") ? body : `${body}\n`;
			mkdirSync(dirname(resolved.absolute), { recursive: true });
			writeFileSync(resolved.absolute, next, "utf8");
			const stat = diffStat(oldText, next);
			const diff = unifiedDiff(oldText, next, resolved.relative, resolved.relative);
			return {
				content: [
					{ type: "text", text: `wrote ${resolved.relative} (+${stat.additions} -${stat.deletions})\n${diff}` },
				],
				details: toDetails({ path: resolved.relative, ...stat, created: oldText.length === 0 }),
			};
		},
	};
}

const EDIT_DESCRIPTION = `Edit files with hashline operations. Start with a section header carrying the tag from read, then operations against the original line numbers:

¶src/app.ts#A3F1
PUT 12
  const renamed = 1;
CUT 20*=24*
PUT 30.<
  // inserted before line 30

Operations:
- PUT N replaces line N, PUT N.=M replaces lines N..M
- PUT N.< and PUT N.> insert before or after line N (also .<M / .>M for a range)
- PUT .> appends to the end of the file
- CUT N deletes line N, CUT N*=M* deletes N..M
- INS.PRE N / INS.POST N insert before or after line N

All line numbers refer to the file as you read it; operations do not shift each other. A patch may contain several sections. If the file changed since the read the whole patch is rejected.`;

const editParameters = obj({
	patch: str({ description: "One or more ¶path#TAG sections with PUT/CUT/INS operations." }),
});

export function createEditTool(ctx: ToolContext): AgentTool<typeof editParameters, JsonValue | undefined> {
	return {
		name: "edit",
		label: "Edit",
		description: EDIT_DESCRIPTION,
		parameters: editParameters,
		execute: async (
			_toolCallId,
			params: AgentToolParams<typeof editParameters>,
		): Promise<AgentToolResult<JsonValue | undefined>> => {
			const parsed = parsePatch(params.patch);
			if (!parsed.ok) return failure(parsed.error);

			// Validate every section before writing anything, so a bad section leaves all files untouched.
			const planned: Array<{
				absolute: string;
				relative: string;
				before: string;
				after: string;
				preview: string;
				added: number;
				removed: number;
			}> = [];
			for (const section of parsed.sections) {
				const resolved = resolveInside(ctx.workspace, section.path);
				if (!resolved.ok) return failure(resolved.error);
				const permission = ctx.sandbox.check({ tool: "edit", paths: [resolved.absolute] });
				if (permission.effect === "deny") return failure(`denied: ${permission.reason}`);
				if (
					permission.effect === "ask" &&
					!(ctx.onPermission && (await ctx.onPermission({ tool: "edit", paths: [resolved.absolute] }, permission)))
				) {
					return failure(`not approved: ${permission.reason}`);
				}
				if (!existsSync(resolved.absolute)) return failure(`file not found: ${resolved.relative}`);
				const before = normalize(readFileSync(resolved.absolute, "utf8"));
				const applied = applySection(before, section);
				if (!applied.ok) return failure(applied.error);
				planned.push({
					absolute: resolved.absolute,
					relative: resolved.relative,
					before,
					after: applied.content,
					preview: applied.preview,
					added: applied.added,
					removed: applied.removed,
				});
			}

			let report = "";
			for (const plan of planned) {
				writeFileSync(plan.absolute, plan.after, "utf8");
				const diff = unifiedDiff(plan.before, plan.after, plan.relative, plan.relative);
				report += `${plan.relative}: +${plan.added} -${plan.removed}\n${diff}\n`;
			}
			const totals = planned.reduce(
				(sum, plan) => ({ additions: sum.additions + plan.added, deletions: sum.deletions + plan.removed }),
				{ additions: 0, deletions: 0 },
			);
			return {
				content: [{ type: "text", text: report.trimEnd() }],
				details: toDetails({ files: planned.map((plan) => plan.relative), ...totals }),
			};
		},
	};
}

/** Extracts the current section header for files named in an edit, for error recovery messages. */
export function currentHeader(workspace: string, path: string): string | undefined {
	const resolved = resolveInside(workspace, path);
	if (!resolved.ok || !existsSync(resolved.absolute)) return undefined;
	return sectionHeader(resolved.relative, contentTag(readFileSync(resolved.absolute, "utf8")));
}

/** Removes a file. Kept out of the model surface unless a tool explicitly needs it (tests). */
export function removeForTest(path: string): void {
	if (existsSync(path)) rmSync(path);
}
