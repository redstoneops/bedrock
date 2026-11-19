// @bedrock/tools: ledger writes and the finish line.
//
// Workers cannot mark anything done: `finish` ends their turn and states what
// they claim, and the harness decides the outcome from the gate. The ledger tool
// is how a claim gets evidence attached instead of just being asserted.

import type { Id, LedgerEntry } from "@bedrock/protocol";
import { createId } from "@bedrock/protocol";
import type { AgentTool, AgentToolParams, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { JsonValue } from "@earendil-works/pi-ai";
import { arr, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import { type ToolContext, toDetails } from "./types.ts";

export interface LedgerSink {
	append(entry: LedgerEntry): void;
}

const LEDGER_DESCRIPTION = `Record a belief, a decision or a risk in the mission ledger.

- fact: something true about the code or environment. Say how you know it.
- hypothesis: something you believe but have not proven. It stays open until you confirm or refute it.
- decision: a choice with its rationale, so a later reader understands why.
- risk: something that could still go wrong.
- question: something you cannot resolve alone.

Write short, specific entries ("the parser strips CRLF in readLine", not "parser stuff"). If a claim has evidence, name the command or file in the statement. Do not record narration; record things that stay true.`;

const ledgerParameters = obj({
	kind: oneOf(["fact", "hypothesis", "decision", "risk", "question"]),
	statement: str({ description: "One sentence. Specific enough that someone else can check it." }),
	confidence: opt(oneOf(["certain", "likely", "speculative"], { description: "For facts: how sure are you?" })),
	rationale: opt(str({ description: "For decisions: why this choice over the alternatives." })),
	severity: opt(oneOf(["low", "medium", "high"], { description: "For risks: how bad if it happens." })),
	tags: opt(arr(str(), { description: "Retrieval tags, e.g. parser, tests, perf." })),
});

export function createLedgerTool(context: {
	missionId: Id<"mission">;
	workerId: Id<"worker">;
	sessionId?: Id<"session">;
	sink: LedgerSink;
	onEntry?: (entry: LedgerEntry) => void;
}): AgentTool<typeof ledgerParameters, JsonValue | undefined> {
	return {
		name: "ledger",
		label: "Ledger",
		description: LEDGER_DESCRIPTION,
		parameters: ledgerParameters,
		execute: async (
			_toolCallId,
			params: AgentToolParams<typeof ledgerParameters>,
		): Promise<AgentToolResult<JsonValue | undefined>> => {
			const base = {
				id: createId("entry"),
				missionId: context.missionId,
				author: "worker" as const,
				sessionId: context.sessionId,
				createdAt: new Date().toISOString(),
				tags: params.tags,
			};
			let entry: LedgerEntry;
			switch (params.kind) {
				case "fact":
					entry = {
						...base,
						kind: "fact",
						statement: params.statement,
						confidence: params.confidence ?? "likely",
					};
					break;
				case "hypothesis":
					entry = { ...base, kind: "hypothesis", statement: params.statement, status: "open" };
					break;
				case "decision":
					entry = {
						...base,
						kind: "decision",
						statement: params.statement,
						rationale: params.rationale ?? "not stated",
					};
					break;
				case "risk":
					entry = { ...base, kind: "risk", statement: params.statement, severity: params.severity ?? "medium" };
					break;
				case "question":
					entry = { ...base, kind: "question", question: params.statement, status: "open" };
					break;
			}
			context.sink.append(entry);
			context.onEntry?.(entry);
			return {
				content: [{ type: "text", text: `recorded ${params.kind} ${entry.id}` }],
				details: toDetails({ id: entry.id, kind: entry.kind }),
			};
		},
	};
}

const FINISH_DESCRIPTION = `Finish your work on this task. Call this exactly once, when you believe the task is done or when you are blocked.

Include:
- summary: what you changed and why, in a few sentences
- checks: the commands you ran and what they printed (the last line of the output is enough)
- unverified: anything you could not confirm, stated plainly

Finishing is a claim, not a verdict: an independent verifier runs the gate afterwards. Do not say "done" if you have not run the checks; say what is unverified instead.`;

const finishParameters = obj({
	summary: str({ description: "What changed and why." }),
	checks: opt(arr(str(), { description: "Commands you ran and their outcomes." })),
	unverified: opt(arr(str(), { description: "Claims you could not verify." })),
});

export interface FinishReport {
	summary: string;
	checks: string[];
	unverified: string[];
	/** Set by callers to distinguish "done" from "stopping because blocked". */
	blocked?: boolean;
}

export function createFinishTool(context: {
	onReport: (report: FinishReport) => void;
}): AgentTool<typeof finishParameters, JsonValue | undefined> {
	return {
		name: "finish",
		label: "Finish",
		description: FINISH_DESCRIPTION,
		parameters: finishParameters,
		execute: async (
			_toolCallId,
			params: AgentToolParams<typeof finishParameters>,
		): Promise<AgentToolResult<JsonValue | undefined>> => {
			context.onReport({
				summary: params.summary,
				checks: params.checks ?? [],
				unverified: params.unverified ?? [],
			});
			return {
				content: [{ type: "text", text: "recorded. The verdict comes from the verifier, not from this claim." }],
				details: toDetails({ summary: params.summary }),
				terminate: true,
			};
		},
	};
}

/** A ToolContext with a ledger sink attached, for tools that need it. */
export type LedgerToolContext = ToolContext & { ledger?: LedgerSink };
