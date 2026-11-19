// @bedrock/core: the Pistons. One worker is one pi Agent in one isolated workspace.
//
// A worker is deliberately thin: it composes tools, a system prompt and events.
// It has no opinion about whether it is done; that is the verifier's job.

import type { Ai } from "@bedrock/ai";
import type { ArtifactStore } from "@bedrock/context";
import type { Gate, Id, LedgerEntry, Mission, WorkerSpec } from "@bedrock/protocol";
import type { Sandbox } from "@bedrock/sandbox";
import {
	createFinishTool,
	createLedgerTool,
	createTools,
	type FinishReport,
	type LedgerSink,
	type ToolContext,
} from "@bedrock/tools";
import type { AgentEvent, AgentTool } from "@earendil-works/pi-agent-core";
import { Agent } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { gateText } from "./prompts.ts";

/** Events a worker emits to the mission loop and the TUI. */
export type WorkerEvent =
	| { type: "turn"; turn: number }
	| { type: "text"; text: string }
	| { type: "tool_start"; toolCallId: string; name: string; args: unknown }
	| { type: "tool_end"; toolCallId: string; name: string; ok: boolean; durationMs?: number }
	| { type: "finished"; report: FinishReport }
	| { type: "error"; message: string };

export interface RunWorkerOptions {
	spec: WorkerSpec;
	mission: Mission;
	gate: Gate;
	ai: Ai;
	workspace: string;
	sandbox: Sandbox;
	artifacts: ArtifactStore;
	ledger: LedgerSink;
	/** Additional instructions, e.g. a refine brief from a previous attempt. */
	briefExtra?: string;
	onEvent?: (event: WorkerEvent) => void;
	/** Called for every ledger entry written through the ledger tool. */
	onLedgerEntry?: (entry: LedgerEntry) => void;
	/** Tools appended to the default set (tests use this to inject fakes). */
	extraTools?: AgentTool[];
	/** Ask the human; undefined in autonomous runs. */
	ask?: (question: string, options?: string[]) => Promise<string | undefined>;
	onPermission?: ToolContext["onPermission"];
}

export interface WorkerOutcome {
	turns: number;
	report: FinishReport;
	/** True when the turn cap ended the run rather than the finish tool. */
	turnCapReached: boolean;
	error?: string;
}

/** Compiles the worker system prompt: role, rules, gate and hashline guidance. */
export function workerSystemPrompt(options: { mission: Mission; gate: Gate; workspace: string }): string {
	const { mission, gate } = options;
	return [
		"You are a worker in Bedrock, a harness for hard, long-horizon tasks. You are one of possibly several workers; you own one approach.",
		"",
		"## How you are judged",
		"An independent verifier runs the gate below against your tree. It never reads your confidence. You are done when the checks pass, and only then.",
		"Never edit tests, checks or gate files to make them pass. If a check is wrong, say so in the ledger and finish; do not weaken it.",
		"",
		"## Working rules",
		"- Read before you edit. The read tool returns tagged lines; your edit patch must carry the tag it saw, and a stale tag is rejected.",
		"- Make one focused change at a time and verify it with a command you can name in your finish report.",
		"- Record durable facts, hypotheses, decisions and risks with the ledger tool. Claims without evidence are flagged.",
		"- When you are blocked by ambiguity, an environment problem or a permission, record it and finish with an honest summary.",
		"- Prefer the smallest change that makes the checks pass. Do not refactor unrelated code.",
		"- Do not claim a command passed unless you ran it and saw the exit code.",
		"",
		`## Workspace\n${options.workspace}`,
		`## Mission\n${mission.spec.goal}`,
		mission.spec.constraints?.length
			? `Constraints:\n${mission.spec.constraints.map((line) => `- ${line}`).join("\n")}`
			: "",
		"",
		"## Gate (the definition of done)",
		gateText(gate),
	].join("\n");
}

/** Runs one worker to completion (or to its turn cap) and returns what it claimed. */
export async function runWorker(options: RunWorkerOptions): Promise<WorkerOutcome> {
	const { spec, mission, gate, ai, sandbox, artifacts, ledger } = options;
	const resolved = ai.resolve(spec.role);
	const toolContext: ToolContext = {
		workspace: options.workspace,
		sandbox,
		artifacts,
		todos: [],
		ask: options.ask,
		onPermission: options.onPermission,
	};
	const tools: AgentTool[] = [
		...createTools(toolContext),
		createLedgerTool({
			missionId: mission.id,
			workerId: spec.strategyId as unknown as Id<"worker">,
			sink: ledger,
			onEntry: options.onLedgerEntry,
		}) as AgentTool,
	];

	let report: FinishReport | undefined;
	tools.push(
		createFinishTool({
			onReport: (value) => {
				report = value;
			},
		}) as AgentTool,
	);
	if (options.extraTools) tools.push(...options.extraTools);

	let turns = 0;
	let finished = false;
	let turnCapReached = false;

	const agent = new Agent({
		initialState: {
			systemPrompt: workerSystemPrompt({ mission, gate, workspace: options.workspace }),
			model: resolved.model,
			thinkingLevel: resolved.effort === "off" ? "off" : (resolved.effort as "low" | "medium" | "high"),
			tools,
		},
		streamFn: ai.models.streamSimple.bind(ai.models),
		finishTurn: () => {
			if (finished) return { action: "end" as const };
			if (turns >= spec.turnCap) {
				turnCapReached = true;
				return { action: "end" as const };
			}
			return { action: "continue" as const };
		},
		afterToolCall: async (context) => {
			if (context.toolCall.name === "finish") finished = true;
			return undefined;
		},
	});

	const unsubscribe = agent.subscribe((event: AgentEvent) => {
		if (event.type === "turn_start") {
			turns += 1;
			options.onEvent?.({ type: "turn", turn: turns });
		} else if (event.type === "message_update") {
			const assistant = event.message as AssistantMessage;
			const delta = event.assistantMessageEvent;
			if (delta.type === "text_delta") options.onEvent?.({ type: "text", text: delta.delta });
			else if (delta.type === "text_start") options.onEvent?.({ type: "text", text: "" });
			else if (assistant.stopReason === "error")
				options.onEvent?.({ type: "error", message: assistant.errorMessage ?? "provider error" });
		} else if (event.type === "tool_execution_start") {
			options.onEvent?.({
				type: "tool_start",
				toolCallId: event.toolCallId,
				name: event.toolName,
				args: event.args,
			});
		} else if (event.type === "tool_execution_end") {
			options.onEvent?.({
				type: "tool_end",
				toolCallId: event.toolCallId,
				name: event.toolName,
				ok: !event.isError,
				durationMs: event.durationMs,
			});
		}
	});

	const brief = [spec.brief, options.briefExtra].filter((part): part is string => Boolean(part)).join("\n\n");
	try {
		await agent.prompt(brief);
	} catch (error) {
		return {
			turns,
			report: report ?? { summary: "worker crashed", checks: [], unverified: [] },
			turnCapReached,
			error: (error as Error).message,
		};
	} finally {
		unsubscribe();
	}

	const finalReport: FinishReport = report ?? {
		summary: turnCapReached
			? `turn cap (${spec.turnCap}) reached without finishing`
			: "worker stopped without a finish report",
		checks: [],
		unverified: ["the worker did not report what it verified"],
	};
	options.onEvent?.({ type: "finished", report: finalReport });
	return { turns, report: finalReport, turnCapReached };
}
