// @bedrock/tools: every built-in tool, assembled for a session.

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createBashTool } from "./bash.ts";
import { createEditTool, createReadTool, createWriteTool } from "./files.ts";
import { createFindTool, createGrepTool, createListTool } from "./search.ts";
import { createAskTool, createTodoTool } from "./todo.ts";
import type { ToolContext } from "./types.ts";

export interface ToolRegistryOptions {
	/** Tools to leave out, by name. */
	exclude?: string[];
}

/** The default tool set for a worker: read, write, hashline edit, grep, find, ls, bash, todo, ask. */
export function createTools(ctx: ToolContext, options: ToolRegistryOptions = {}): AgentTool[] {
	const tools: AgentTool[] = [
		createReadTool(ctx),
		createWriteTool(ctx),
		createEditTool(ctx),
		createGrepTool(ctx),
		createFindTool(ctx),
		createListTool(ctx),
		createBashTool(ctx),
		createTodoTool(ctx),
		createAskTool(ctx),
	];
	const excluded = new Set(options.exclude ?? []);
	return tools.filter((tool) => !excluded.has(tool.name));
}

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
export { createFindTool, createGrepTool, createListTool, globMatch, walkFiles } from "./search.ts";
export { createAskTool, createTodoTool } from "./todo.ts";
export type { TodoItem, ToolContext } from "./types.ts";
export { diffStat, failure, resolveInside, runSandboxed, text, toDetails, unifiedDiff } from "./types.ts";
