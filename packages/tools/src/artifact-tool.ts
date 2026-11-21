// @bedrock/tools: reading stored outputs by handle, so truncation never loses information.

import type { AgentTool, AgentToolParams, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { JsonValue } from "@earendil-works/pi-ai";
import { int, obj, opt, str } from "@earendil-works/pi-schema";
import { failure, type ToolContext, toDetails } from "./types.ts";

const artifactParameters = obj({
	id: str({ description: "The artifact handle, e.g. art_3f2a… from a truncated tool result." }),
	pattern: opt(str({ description: "Regular expression; return only matching lines (with line numbers)." })),
	offset: opt(int({ description: "0-based first line to return.", minimum: 0 })),
	limit: opt(int({ description: "Maximum lines to return (default 200).", minimum: 1, maximum: 2000 })),
});

export function createArtifactTool(ctx: ToolContext): AgentTool<typeof artifactParameters, JsonValue | undefined> {
	return {
		name: "artifact",
		label: "Artifact",
		description:
			"Read or grep a stored tool output by its handle. Long command and check outputs are truncated in the conversation and kept in full as artifacts; query them here instead of re-running the command.",
		parameters: artifactParameters,
		execute: async (
			_toolCallId,
			params: AgentToolParams<typeof artifactParameters>,
		): Promise<AgentToolResult<JsonValue | undefined>> => {
			const content = ctx.artifacts.getById(params.id);
			if (content === undefined) return failure(`no artifact ${params.id}`);
			const lines = content.split("\n");
			let selected: string[];
			if (params.pattern) {
				let regex: RegExp;
				try {
					regex = new RegExp(params.pattern);
				} catch (error) {
					return failure(`invalid pattern: ${(error as Error).message}`);
				}
				selected = lines.flatMap((line, index) => (regex.test(line) ? [`${index + 1}:${line}`] : []));
			} else {
				const offset = params.offset ?? 0;
				selected = lines
					.slice(offset, offset + (params.limit ?? 200))
					.map((line, index) => `${offset + index + 1}:${line}`);
			}
			const limit = params.limit ?? 200;
			const shown = selected.slice(0, limit);
			const note =
				selected.length > shown.length
					? `\n... ${selected.length - shown.length} more lines; narrow the pattern or page with offset`
					: "";
			return {
				content: [{ type: "text", text: `${shown.join("\n") || "(no matching lines)"}${note}` }],
				details: toDetails({ lines: lines.length, matched: selected.length }),
			};
		},
	};
}
