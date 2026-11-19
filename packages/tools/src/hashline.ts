// @bedrock/tools: hashline files and edits.
//
// A read returns a tagged section:
//
//   ¶src/app.ts#A3F1
//   1:const x = 1;
//   2:export function main() {
//
// The tag is the first four hex digits of the sha1 of the normalized content. An
// edit names the section and the tag it saw; if the file changed since the read
// the tag mismatch is rejected before anything is written, so a stale line number
// can never corrupt a file. All operations in a patch refer to the original line
// numbers, so several edits to one file compose without shifting each other.
//
// Grammar (the idea is adapted from oh-my-pi's hashline format, MIT):
//
//   ¶PATH#TAG              section header (TAG optional: accept whatever is current)
//   PUT N                  replace line N with the following lines
//   PUT N.=M               replace lines N..M
//   PUT N.< / PUT N.>      insert before / after line N
//   PUT N.<M / PUT N.>M    insert before / after the range N..M
//   PUT .<  / PUT .>       insert at the start / end of the file
//   CUT N                  delete line N
//   CUT N*=M*              delete lines N..M
//   INS.PRE N / INS.POST N insert before / after line N

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/** Maximum lines returned by one tagged read; the header tag still covers the whole file. */
export const MAX_TAGGED_LINES = 2000;
export const TAG_LENGTH = 4;

/** LF-normalized content; hashing and editing both work on this form. */
export function normalize(text: string): string {
	return text.replace(/\r\n/g, "\n");
}

/** Short content tag, upper-case hex. */
export function contentTag(content: string): string {
	return createHash("sha1").update(normalize(content)).digest("hex").slice(0, TAG_LENGTH).toUpperCase();
}

export function sectionHeader(path: string, tag?: string): string {
	return tag ? `¶${path}#${tag}` : `¶${path}`;
}

export interface SectionSpec {
	path: string;
	tag?: string;
}

/** Parses a `¶path#TAG` (or `[path#TAG]`) header. Returns null for any other line. */
export function parseSectionHeader(line: string): SectionSpec | null {
	const trimmed = line.trim();
	if (!trimmed.startsWith("¶") && !trimmed.startsWith("[")) return null;
	const inner = trimmed.replace(/^[¶[]/, "").replace(/\]$/, "");
	const match = /^(.+?)(?:#([0-9A-Fa-f]{4}))?$/.exec(inner);
	if (!match) return null;
	const path = match[1].trim();
	if (path.length === 0) return null;
	return { path, tag: match[2]?.toUpperCase() };
}

/** Renders a window of a file as numbered lines under a tagged header. */
export function renderTaggedFile(
	path: string,
	content: string,
	options: { offset?: number; limit?: number } = {},
): { text: string; tag: string; totalLines: number; truncated: boolean } {
	const lines = splitLines(normalize(content));
	const tag = contentTag(content);
	const offset = Math.max(0, options.offset ?? 0);
	if (offset > lines.length) {
		return {
			text: `${sectionHeader(path, tag)}\n... (file has ${lines.length} lines; offset ${offset} is past the end) ...`,
			tag,
			totalLines: lines.length,
			truncated: false,
		};
	}
	const limit = Math.max(1, Math.min(options.limit ?? MAX_TAGGED_LINES, MAX_TAGGED_LINES));
	const end = Math.min(lines.length, offset + limit);
	const body = lines
		.slice(offset, end)
		.map((line, index) => `${offset + index + 1}:${line}`)
		.join("\n");
	const note =
		end < lines.length ? `\n... (lines ${end + 1}-${lines.length} hidden; read with offset ${end}) ...` : "";
	return {
		text: `${sectionHeader(path, tag)}\n${body}${note}`,
		tag,
		totalLines: lines.length,
		truncated: end < lines.length,
	};
}

/** Splits normalized content into real lines, dropping the empty element a trailing newline creates. */
export function splitLines(content: string): string[] {
	const lines = normalize(content).split("\n");
	if (lines.length > 0 && lines.at(-1) === "") lines.pop();
	return lines;
}

export type OpKind = "replace" | "delete" | "insert";

export interface EditOp {
	kind: OpKind;
	/** 1-based first line the op refers to (0 for start/end of file inserts). */
	start: number;
	/** 1-based last line, for range ops. */
	end: number;
	/** For insert: whether the lines go before or after the anchor line (or range). */
	position: "before" | "after";
	/** Replacement or inserted lines. Empty for delete. */
	lines: string[];
}

export interface ParsedSection {
	path: string;
	tag?: string;
	ops: EditOp[];
}

export type ParseResult = { ok: true; sections: ParsedSection[] } | { ok: false; error: string };

const PUT_RE = /^PUT\s+(?:(\d+)(?:\.([=*<>])(\d*))?|\.([<>]))$/;
const CUT_RE = /^CUT\s+(\d+)(?:\*=(\d+)\*)?$/;
const INS_RE = /^INS\.(PRE|POST)\s+(\d+)$/;

/**
 * Parses a hashline patch into sections of ops. Lines that are not headers or
 * operations are content for the preceding operation.
 */
export function parsePatch(patch: string): ParseResult {
	const lines = normalize(patch).split("\n");
	const sections: ParsedSection[] = [];
	let section: ParsedSection | undefined;
	let op: EditOp | undefined;

	const flush = () => {
		if (op && section) section.ops.push(op);
		op = undefined;
	};

	for (const raw of lines) {
		const header = parseSectionHeader(raw);
		if (header) {
			flush();
			section = { path: header.path, tag: header.tag, ops: [] };
			sections.push(section);
			continue;
		}
		if (!section) {
			if (raw.trim().length === 0) continue;
			return {
				ok: false,
				error: `expected a section header like "¶path/to/file#ABCD" before "${raw.slice(0, 60)}"`,
			};
		}
		const trimmed = raw.trim();
		if (trimmed.length === 0) {
			// Blank lines are content only inside an insertion/replacement op.
			if (op && op.kind !== "delete") op.lines.push("");
			continue;
		}

		const put = PUT_RE.exec(trimmed);
		if (put) {
			flush();
			const [, startText, mark, endText, edge] = put;
			if (edge) {
				op = { kind: "insert", start: 0, end: 0, position: edge === "<" ? "before" : "after", lines: [] };
			} else if (mark === "*") {
				// PUT N*M means replace the range; accepted for symmetry with CUT.
				const start = Number(startText);
				op = { kind: "replace", start, end: Number(endText || start), position: "after", lines: [] };
			} else if (mark === ">") {
				op = {
					kind: "insert",
					start: Number(startText),
					end: Number(endText || startText),
					position: "after",
					lines: [],
				};
			} else if (mark === "<") {
				op = {
					kind: "insert",
					start: Number(startText),
					end: Number(endText || startText),
					position: "before",
					lines: [],
				};
			} else {
				const start = Number(startText);
				op = {
					kind: "replace",
					start,
					end: mark === "=" ? Number(endText || start) : start,
					position: "after",
					lines: [],
				};
			}
			continue;
		}
		const cut = CUT_RE.exec(trimmed);
		if (cut) {
			flush();
			op = { kind: "delete", start: Number(cut[1]), end: Number(cut[2] || cut[1]), position: "after", lines: [] };
			continue;
		}
		const ins = INS_RE.exec(trimmed);
		if (ins) {
			flush();
			op = {
				kind: "insert",
				start: Number(ins[2]),
				end: Number(ins[2]),
				position: ins[1] === "PRE" ? "before" : "after",
				lines: [],
			};
			continue;
		}
		if (!op) {
			return {
				ok: false,
				error: `expected an operation (PUT, CUT, INS.PRE, INS.POST) before "${raw.slice(0, 60)}"`,
			};
		}
		op.lines.push(raw);
	}
	flush();

	if (sections.length === 0) return { ok: false, error: "patch contains no sections" };
	for (const parsed of sections) {
		if (parsed.ops.length === 0) return { ok: false, error: `section ${parsed.path} has no operations` };
	}
	return { ok: true, sections };
}

export type ApplyResult =
	| { ok: true; content: string; preview: string; added: number; removed: number }
	| { ok: false; error: string };

/**
 * Applies one parsed section to current content. Everything is validated before
 * anything is produced, and the original line numbers are used throughout, so a
 * bad op or a stale tag leaves the file untouched and returns a retry message.
 */
export function applySection(content: string, section: ParsedSection): ApplyResult {
	const normalized = normalize(content);
	const hadFinalNewline = normalized.endsWith("\n");
	const lines = splitLines(normalized);
	const tag = contentTag(normalized);
	if (section.tag && section.tag !== tag) {
		return {
			ok: false,
			error: `${section.path} changed since it was read (patch tag #${section.tag}, current tag #${tag}). Re-read the file and retry.`,
		};
	}

	const replaces = new Map<number, { end: number; lines: string[] }>();
	const before = new Map<number, string[]>();
	const after = new Map<number, string[]>();
	const deletes = new Set<number>();
	const touched = new Set<number>();
	let startInsert: string[] = [];
	let endInsert: string[] = [];

	const push = (map: Map<number, string[]>, key: number, values: string[]) => {
		map.set(key, [...(map.get(key) ?? []), ...values]);
	};

	for (const op of section.ops) {
		if (op.kind === "insert" && op.start === 0) {
			if (op.position === "before") startInsert = [...startInsert, ...op.lines];
			else endInsert = [...endInsert, ...op.lines];
			continue;
		}
		if (op.start < 1 || op.start > lines.length) {
			return { ok: false, error: `line ${op.start} is out of range for ${section.path} (1-${lines.length})` };
		}
		if (op.end > lines.length) {
			return { ok: false, error: `line ${op.end} is out of range for ${section.path} (1-${lines.length})` };
		}
		if (op.end < op.start) return { ok: false, error: `range ${op.start}..${op.end} is reversed in ${section.path}` };
		if (op.kind === "replace" || op.kind === "delete") {
			for (let line = op.start; line <= op.end; line++) {
				if (touched.has(line)) return { ok: false, error: `line ${line} is changed by more than one operation` };
				touched.add(line);
			}
			if (op.kind === "delete") {
				for (let line = op.start; line <= op.end; line++) deletes.add(line);
			} else {
				replaces.set(op.start, { end: op.end, lines: op.lines });
			}
			continue;
		}
		// Inserts anchor on a line, never consume it.
		if (op.position === "before") push(before, op.start, op.lines);
		else push(after, op.end, op.lines);
	}

	const output: string[] = [];
	const preview: string[] = [];
	let added = 0;
	let removed = 0;
	if (startInsert.length > 0) {
		output.push(...startInsert);
		added += startInsert.length;
	}
	for (let index = 0; index < lines.length; index++) {
		const lineNumber = index + 1;
		if (before.has(lineNumber)) {
			const inserted = before.get(lineNumber) ?? [];
			output.push(...inserted);
			added += inserted.length;
		}
		if (deletes.has(lineNumber)) {
			preview.push(`-${lines[index]}`);
			removed += 1;
		} else if (replaces.has(lineNumber)) {
			const replacement = replaces.get(lineNumber)!;
			for (let line = replacement.end; line >= lineNumber; line--) preview.push(`-${lines[line - 1]}`);
			for (const newLine of replacement.lines) preview.push(`+${newLine}`);
			removed += replacement.end - lineNumber + 1;
			added += replacement.lines.length;
			output.push(...replacement.lines);
			index = replacement.end - 1;
		} else {
			output.push(lines[index]);
		}
		if (after.has(lineNumber)) {
			const inserted = after.get(lineNumber) ?? [];
			output.push(...inserted);
			added += inserted.length;
		}
	}
	if (endInsert.length > 0) {
		output.push(...endInsert);
		added += endInsert.length;
	}

	const content2 = output.join("\n") + (hadFinalNewline || output.length !== lines.length ? "\n" : "");
	return { ok: true, content: content2, preview: preview.join("\n"), added, removed };
}

/** Reads a file as LF-normalized text. */
export function readNormalized(path: string): string {
	return normalize(readFileSync(path, "utf8"));
}
