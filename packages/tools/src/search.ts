// @bedrock/tools: grep, find and a tree listing, all workspace-bounded.

import { spawnSync } from "node:child_process";
import { type Dirent, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { truncateOutput } from "@bedrock/context";
import type { AgentTool, AgentToolParams, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { JsonValue } from "@earendil-works/pi-ai";
import { bool, int, obj, opt, str } from "@earendil-works/pi-schema";
import { failure, resolveInside, type ToolContext, toDetails } from "./types.ts";

/** Directory names never worth walking. */
const SKIP_DIRS = new Set([
	".git",
	"node_modules",
	"dist",
	"build",
	"coverage",
	".next",
	".turbo",
	"__pycache__",
	".venv",
	"target",
]);

/** Content patterns for the JS fallback (ripgrep is preferred when installed). */
export function walkFiles(root: string, options: { limit?: number; includeHidden?: boolean } = {}): string[] {
	const found: string[] = [];
	const limit = options.limit ?? 20_000;
	const visit = (dir: string) => {
		if (found.length >= limit) return;
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (found.length >= limit) return;
			if (entry.name.startsWith(".") && !options.includeHidden && entry.name !== ".") {
				if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) continue;
				if (!entry.isDirectory()) continue;
			}
			const absolute = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (SKIP_DIRS.has(entry.name)) continue;
				visit(absolute);
			} else if (entry.isFile()) {
				found.push(absolute);
			}
		}
	};
	visit(root);
	return found;
}

/** Converts a glob to a RegExp (subset: **, *, ?, {}). */
export function globMatch(pattern: string): RegExp {
	let out = "";
	for (let index = 0; index < pattern.length; index++) {
		const char = pattern[index];
		if (char === "*") {
			if (pattern[index + 1] === "*") {
				out += pattern[index + 2] === "/" ? "(?:.*/)?" : ".*";
				index += pattern[index + 2] === "/" ? 2 : 1;
			} else out += "[^/]*";
		} else if (char === "?") out += "[^/]";
		else if (char === "{") {
			const end = pattern.indexOf("}", index);
			if (end < 0) out += "\\{";
			else {
				out += `(${pattern
					.slice(index + 1, end)
					.split(",")
					.map((part) => part.replace(/[.+^${}()|[\]\\]/g, "\\$&"))
					.join("|")})`;
				index = end;
			}
		} else out += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	}
	return new RegExp(`^${out}$`);
}

const grepParameters = obj({
	pattern: str({ description: "Rust/JavaScript regular expression." }),
	path: opt(str({ description: "File or directory to search, relative to the workspace (default: workspace root)." })),
	glob: opt(str({ description: "Only search files matching this glob, e.g. **/*.ts." })),
	ignoreCase: opt(bool({ description: "Case-insensitive match." })),
	context: opt(int({ description: "Lines of context around each match.", minimum: 0, maximum: 10 })),
	maxResults: opt(int({ description: "Maximum matches to return (default 200).", minimum: 1, maximum: 2000 })),
	filesOnly: opt(bool({ description: "Return only the names of matching files." })),
});

export function createGrepTool(ctx: ToolContext): AgentTool<typeof grepParameters, JsonValue | undefined> {
	return {
		name: "grep",
		label: "Grep",
		description: `Search file contents with a regular expression. Returns path:line:text. Uses ripgrep when available, otherwise a built-in walker. Narrow with glob and path; use context to see surrounding lines.`,
		parameters: grepParameters,
		execute: async (
			_toolCallId,
			params: AgentToolParams<typeof grepParameters>,
		): Promise<AgentToolResult<JsonValue | undefined>> => {
			const root = resolveInside(ctx.workspace, params.path ?? ".");
			if (!root.ok) return failure(root.error);
			const maxResults = params.maxResults ?? 200;
			const rg = spawnSync("rg", ["--version"], { stdio: "ignore" });
			let output: string;
			if (rg.status === 0) {
				const args = ["--line-number", "--no-heading", "--color", "never", "--max-count", "5000"];
				if (params.ignoreCase) args.push("--ignore-case");
				if (params.glob) args.push("--glob", params.glob);
				if (params.filesOnly) args.push("--files-with-matches");
				if (params.context) args.push("--context", String(params.context));
				args.push("--", params.pattern, root.absolute);
				const result = spawnSync("rg", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, cwd: ctx.workspace });
				if (result.status === 2) return failure(`grep failed: ${result.stderr}`);
				output = result.stdout ?? "";
			} else {
				output = fallbackGrep(root.absolute, params);
			}
			if (output.trim().length === 0)
				return { content: [{ type: "text", text: "no matches" }], details: toDetails({ matches: 0 }) };
			const lines = output
				.trimEnd()
				.split("\n")
				.map((line) => line.replaceAll(`${ctx.workspace}/`, ""));
			const limited = lines.slice(0, maxResults);
			const truncated = truncateOutput(limited.join("\n"), { maxLines: 400, maxBytes: 40_000 });
			return {
				content: [{ type: "text", text: truncated.text }],
				details: toDetails({
					matches: lines.length,
					truncated: truncated.truncated || limited.length < lines.length,
				}),
			};
		},
	};
}

function fallbackGrep(
	root: string,
	params: { pattern: string; glob?: string; ignoreCase?: boolean; filesOnly?: boolean },
): string {
	let regex: RegExp;
	try {
		regex = new RegExp(params.pattern, params.ignoreCase ? "gi" : "g");
	} catch (error) {
		return `invalid pattern: ${(error as Error).message}`;
	}
	const files = walkFiles(root);
	const glob = params.glob ? globMatch(params.glob) : undefined;
	const lines: string[] = [];
	for (const file of files) {
		const rel = relative(root, file).split("\\").join("/");
		if (glob && !glob.test(rel)) continue;
		let content: string;
		try {
			content = readFileSync(file, "utf8");
		} catch {
			continue;
		}
		if (content.includes("\u0000")) continue;
		content.split("\n").forEach((line, index) => {
			regex.lastIndex = 0;
			if (regex.test(line)) lines.push(params.filesOnly ? file : `${file}:${index + 1}:${line}`);
		});
	}
	return lines.join("\n");
}

const findParameters = obj({
	pattern: opt(str({ description: "Glob applied to the path, e.g. **/*.test.ts." })),
	path: opt(str({ description: "Directory to search, relative to the workspace (default: workspace root)." })),
	contains: opt(str({ description: "Only paths containing this substring." })),
	maxResults: opt(int({ description: "Maximum paths to return (default 500).", minimum: 1, maximum: 5000 })),
});

export function createFindTool(ctx: ToolContext): AgentTool<typeof findParameters, JsonValue | undefined> {
	return {
		name: "find",
		label: "Find",
		description: `Find files by glob and/or substring in the path. Returns paths relative to the workspace. Skips node_modules, .git, dist and similar build directories.`,
		parameters: findParameters,
		execute: async (
			_toolCallId,
			params: AgentToolParams<typeof findParameters>,
		): Promise<AgentToolResult<JsonValue | undefined>> => {
			const root = resolveInside(ctx.workspace, params.path ?? ".");
			if (!root.ok) return failure(root.error);
			const maxResults = params.maxResults ?? 500;
			const glob = params.pattern ? globMatch(params.pattern.replace(/^\.\//, "")) : undefined;
			const files = walkFiles(root.absolute);
			const matches: string[] = [];
			for (const file of files) {
				const rel = relative(ctx.workspace, file).split("\\").join("/");
				const searchable = relative(root.absolute, file).split("\\").join("/");
				if (glob && !(glob.test(searchable) || glob.test(rel))) continue;
				if (params.contains && !rel.includes(params.contains)) continue;
				matches.push(rel);
				if (matches.length >= maxResults) break;
			}
			if (matches.length === 0)
				return { content: [{ type: "text", text: "no files matched" }], details: toDetails({ count: 0 }) };
			const truncated = truncateOutput(matches.join("\n"), { maxLines: 500, maxBytes: 40_000 });
			return {
				content: [{ type: "text", text: truncated.text }],
				details: toDetails({ count: matches.length, truncated: truncated.truncated }),
			};
		},
	};
}

/** Directory listing with sizes, for orientation. */
const listParameters = obj({
	path: opt(str({ description: "Directory relative to the workspace (default: workspace root)." })),
});

export function createListTool(ctx: ToolContext): AgentTool<typeof listParameters, JsonValue | undefined> {
	return {
		name: "ls",
		label: "List",
		description: "List a directory: names, types and sizes, one per line. Hidden files are included.",
		parameters: listParameters,
		execute: async (
			_toolCallId,
			params: AgentToolParams<typeof listParameters>,
		): Promise<AgentToolResult<JsonValue | undefined>> => {
			const dir = resolveInside(ctx.workspace, params.path ?? ".");
			if (!dir.ok) return failure(dir.error);
			let entries: Dirent[];
			try {
				entries = readdirSync(dir.absolute, { withFileTypes: true });
			} catch {
				return failure(`cannot list ${dir.relative}`);
			}
			const lines = entries
				.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
				.map((entry) => {
					if (entry.isDirectory()) return `${entry.name}/`;
					try {
						return `${entry.name} (${statSync(join(dir.absolute, entry.name)).size} bytes)`;
					} catch {
						return entry.name;
					}
				});
			return {
				content: [{ type: "text", text: lines.join("\n") || "(empty)" }],
				details: toDetails({ count: entries.length }),
			};
		},
	};
}
