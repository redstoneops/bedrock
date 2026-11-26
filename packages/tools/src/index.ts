// @bedrock/tools: every built-in tool, assembled for a session.

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createArtifactTool } from "./artifact-tool.ts";
import { createBashTool } from "./bash.ts";
import { createEditTool, createReadTool, createWriteTool } from "./files.ts";
import { createApplyPatchTool, createStrReplaceTool } from "./patch.ts";
import { createFindTool, createGrepTool, createListTool } from "./search.ts";
import { createAskTool, createTodoTool } from "./todo.ts";
import type { ToolContext } from "./types.ts";
import { createWebFetchTool, createWebSearchTool, type WebToolsOptions } from "./web.ts";

export type EditTool = "hashline" | "str_replace" | "patch";

export interface ToolRegistryOptions {
	/** Tools to leave out, by name. */
	exclude?: string[];
	/** Edit tools to expose (default: hashline). One primary format per model family works best. */
	edits?: EditTool[];
	/** Explicit opt-in. No web tool is exposed by the default registry. */
	web?: WebToolsOptions;
}

/** The default tool set for a worker: read, write, hashline edit, grep, find, ls, bash, todo, ask. */
export function createTools(ctx: ToolContext, options: ToolRegistryOptions = {}): AgentTool[] {
	const edits = options.edits ?? ["hashline"];
	const tools: AgentTool[] = [
		createReadTool(ctx),
		createWriteTool(ctx),
		...(edits.includes("hashline") ? [createEditTool(ctx) as AgentTool] : []),
		...(edits.includes("str_replace") ? [createStrReplaceTool(ctx) as AgentTool] : []),
		...(edits.includes("patch") ? [createApplyPatchTool(ctx) as AgentTool] : []),
		createArtifactTool(ctx),
		createGrepTool(ctx),
		createFindTool(ctx),
		createListTool(ctx),
		createBashTool(ctx),
		createTodoTool(ctx),
		createAskTool(ctx),
		...(options.web?.braveKey ? [createWebSearchTool(ctx, options.web.braveKey)] : []),
		...(options.web?.hosts?.length ? [createWebFetchTool(ctx, options.web.hosts)] : []),
	];
	const excluded = new Set(options.exclude ?? []);
	return tools.filter((tool) => !excluded.has(tool.name));
}

export { createArtifactTool } from "./artifact-tool.ts";
export { createBashTool } from "./bash.ts";
export { describeToolCall, patchPaths, patchPathsFromApplyPatch } from "./describe.ts";
export { createEditTool, createReadTool, createWriteTool, currentHeader, removeForTest } from "./files.ts";
export {
	applySection,
	contentTag,
	parsePatch,
	parseSectionHeader,
	renderTaggedFile,
	sectionHeader,
	splitLines,
	TAG_LENGTH,
} from "./hashline.ts";
export type { FinishReport, LedgerSink } from "./ledger-tool.ts";
export { createFinishTool, createLedgerTool } from "./ledger-tool.ts";
export { applyHunks, createApplyPatchTool, createStrReplaceTool, parseApplyPatch } from "./patch.ts";
export { createFindTool, createGrepTool, createListTool, globMatch, walkFiles } from "./search.ts";
export { createAskTool, createTodoTool } from "./todo.ts";
export type { TodoItem, ToolContext } from "./types.ts";
export { diffStat, failure, resolveInside, runSandboxed, text, toDetails, unifiedDiff } from "./types.ts";
export { createWebFetchTool, createWebSearchTool, type WebToolsOptions } from "./web.ts";
