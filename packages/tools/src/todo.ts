// @bedrock/tools: the session checklist (todo) and the human question (ask) tools.

import type { AgentTool, AgentToolParams, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { JsonValue } from "@earendil-works/pi-ai";
import { arr, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import { failure, type TodoItem, type ToolContext, toDetails } from "./types.ts";

const TODO_DESCRIPTION = `Read or update the task checklist for this session. Call with no items to read it. Provide items to replace the list; each item has text and a status of pending, in_progress, completed or cancelled.

Keep the list small (3-8 items), keep exactly one item in_progress while you work on it, and mark items completed only when a check proves them. The list is for you and the human watching; it is not evidence.`;

const todoParameters = obj({
	items: opt(
		arr(
			obj({
				text: str({ description: "What the step is." }),
				status: oneOf(["pending", "in_progress", "completed", "cancelled"]),
			}),
			{
				description: "Replacement list. Omit to read the current one.",
			},
		),
	),
});

export function createTodoTool(ctx: ToolContext): AgentTool<typeof todoParameters, JsonValue | undefined> {
	return {
		name: "todo",
		label: "Todo",
		description: TODO_DESCRIPTION,
		parameters: todoParameters,
		execute: async (
			_toolCallId,
			params: AgentToolParams<typeof todoParameters>,
		): Promise<AgentToolResult<JsonValue | undefined>> => {
			if (params.items) {
				ctx.todos = params.items.map((item, index) => ({ id: index + 1, text: item.text, status: item.status }));
			}
			const items = ctx.todos ?? [];
			if (items.length === 0)
				return { content: [{ type: "text", text: "(no todo items)" }], details: toDetails({ items }) };
			const render = items.map(
				(item) =>
					`[${item.status === "completed" ? "x" : item.status === "in_progress" ? ">" : " "}] ${item.id}. ${item.text}`,
			);
			const done = items.filter((item) => item.status === "completed").length;
			return {
				content: [{ type: "text", text: `${done}/${items.length} done\n${render.join("\n")}` }],
				details: toDetails({ items }),
			};
		},
	};
}

const ASK_DESCRIPTION = `Ask the human a question when the answer changes what you do next: an ambiguous requirement, a decision with real cost, or a permission you cannot get. State the options briefly. In autonomous runs this returns "no human available"; do not block on it, pick the safest option and record the assumption in the ledger.`;

const askParameters = obj({
	question: str({ description: "The question, one or two sentences." }),
	options: opt(arr(str(), { description: "Suggested answers, if the question is multiple choice." })),
});

export function createAskTool(ctx: ToolContext): AgentTool<typeof askParameters, JsonValue | undefined> {
	return {
		name: "ask",
		label: "Ask",
		description: ASK_DESCRIPTION,
		parameters: askParameters,
		execute: async (
			_toolCallId,
			params: AgentToolParams<typeof askParameters>,
		): Promise<AgentToolResult<JsonValue | undefined>> => {
			if (!ctx.ask) {
				return {
					content: [
						{
							type: "text",
							text: "no human available; record your assumption in the ledger and continue with the safest option",
						},
					],
					details: toDetails({ answered: false }),
				};
			}
			const answer = await ctx.ask(params.question);
			return {
				content: [
					{ type: "text", text: answer ?? "no answer; continue with the safest option and record the assumption" },
				],
				details: toDetails({ answered: answer !== undefined, answer }),
				terminate: true,
			};
		},
	};
}
