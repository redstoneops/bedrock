// @bedrock/tools: one-line, human-readable labels for tool calls, used by tool cards.

import { parseSectionHeader } from "./hashline.ts";

const MAX = 120;

function clip(text: string): string {
	const single = text.replace(/\s+/g, " ").trim();
	return single.length > MAX ? `${single.slice(0, MAX - 1)}…` : single;
}

function str(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Files named by `¶path#TAG` headers in a hashline patch, in order. */
export function patchPaths(patch: string): string[] {
	const paths: string[] = [];
	for (const line of patch.split("\n")) {
		const header = parseSectionHeader(line);
		if (header && !paths.includes(header.path)) paths.push(header.path);
	}
	return paths;
}

/**
 * Describes a tool call the way a reader scans it: `read src/a.ts`,
 * `$ npm test`, `edit src/a.ts, src/b.ts`. Unknown tools fall back to their name.
 * Arguments come from the model, so every field is treated as untrusted.
 */
export function describeToolCall(name: string, args: unknown): string {
	const record = args !== null && typeof args === "object" ? (args as Record<string, unknown>) : {};
	switch (name) {
		case "read": {
			const offset = typeof record.offset === "number" ? ` @${record.offset}` : "";
			return clip(`read ${str(record.path) ?? "?"}${offset}`);
		}
		case "write":
			return clip(`write ${str(record.path) ?? "?"}`);
		case "edit": {
			const paths = patchPaths(str(record.patch) ?? "");
			return clip(`edit ${paths.length > 0 ? paths.join(", ") : "?"}`);
		}
		case "str_replace":
			return clip(`replace in ${str(record.path) ?? "?"}`);
		case "apply_patch":
			return clip(
				`apply_patch ${patchPathsFromApplyPatch(str(record.patch) ?? str(record.input) ?? "").join(", ") || "?"}`,
			);
		case "bash":
			return clip(`$ ${str(record.command) ?? "?"}`);
		case "web_search":
			return clip(`web search ${str(record.query) ?? "?"}`);
		case "web_fetch":
			return clip(`web fetch ${str(record.url) ?? "?"}`);
		case "grep":
			return clip(`grep ${str(record.pattern) ?? "?"}${str(record.path) ? ` in ${record.path}` : ""}`);
		case "find":
			return clip(
				`find ${str(record.pattern) ?? str(record.contains) ?? "*"}${str(record.path) ? ` in ${record.path}` : ""}`,
			);
		case "ls":
			return clip(`ls ${str(record.path) ?? "."}`);
		case "todo":
			return Array.isArray(record.items) ? `todo (${record.items.length} items)` : "todo";
		case "ask":
			return clip(`ask: ${str(record.question) ?? "?"}`);
		case "ledger":
			return clip(`ledger ${str(record.kind) ?? ""}: ${str(record.statement) ?? ""}`);
		case "finish":
			return clip(`finish: ${str(record.summary) ?? ""}`);
		case "checks":
			return Array.isArray(record.only) && record.only.length > 0
				? clip(`checks ${record.only.join(", ")}`)
				: "checks (visible gate)";
		case "python":
			return clip(`python ${(str(record.code) ?? "").split("\n")[0] ?? ""}`);
		case "artifact":
			return clip(`artifact ${str(record.id) ?? "?"}${str(record.pattern) ? ` /${record.pattern}/` : ""}`);
		default:
			return name;
	}
}

/** Files named by `*** Update File:` / `*** Add File:` / `*** Delete File:` lines. */
export function patchPathsFromApplyPatch(patch: string): string[] {
	const paths: string[] = [];
	for (const line of patch.split("\n")) {
		const match = /^\*\*\* (?:Update|Add|Delete) File: (.+)$/.exec(line.trim());
		if (match && !paths.includes(match[1].trim())) paths.push(match[1].trim());
	}
	return paths;
}
