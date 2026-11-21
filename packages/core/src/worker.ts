// @bedrock/core: the Pistons. One worker is one pi Agent in one isolated workspace.
//
// A worker composes tools, a system prompt and events. It has no opinion about
// whether it is done; that is the verifier's job. It does keep honest statistics
// (turns, repeated actions, turns since the last new ledger fact) so the budget
// policy can stop a stuck worker mid-run instead of letting it burn its turn cap.

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
import type { AgentEvent, AgentMessage, AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Agent } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AdvisorVerdict } from "./advisor.ts";
import { maskOldObservations } from "./compaction.ts";
import type { MissionController } from "./controller.ts";
import { gateText } from "./prompts.ts";

/** Events a worker emits to the mission loop and the TUI. */
export type WorkerEvent =
	| { type: "turn"; turn: number }
	| { type: "text"; text: string; start: boolean }
	| { type: "thinking"; text: string }
	| { type: "tool_start"; toolCallId: string; name: string; args: unknown }
	| {
			type: "tool_end";
			toolCallId: string;
			name: string;
			args: unknown;
			ok: boolean;
			durationMs?: number;
			/** First lines of the model-facing result, for collapsed tool cards. */
			head: string;
			details: unknown;
	  }
	| { type: "advisor"; tag: AdvisorVerdict["tag"]; text: string }
	| { type: "finished"; report: FinishReport }
	| { type: "stopped"; reason: string }
	| { type: "error"; message: string };

/** Live statistics, recomputed after every turn. */
export interface WorkerStats {
	turns: number;
	toolCalls: number;
	/** Fraction of tool calls that exactly repeat an earlier call (same tool, same arguments). */
	repeatedActionRatio: number;
	/** Turns since the worker last wrote a fact, decision or confirmed hypothesis. */
	turnsSinceNewFact: number;
	failedToolCalls: number;
	/** Advisor blockers raised during this run. */
	blockers: number;
}

export interface RunWorkerOptions {
	spec: WorkerSpec;
	workerId: Id<"worker">;
	mission: Mission;
	gate: Gate;
	ai: Ai;
	workspace: string;
	sandbox: Sandbox;
	artifacts: ArtifactStore;
	ledger: LedgerSink;
	/** Additional instructions, e.g. a refine brief from a previous attempt. */
	briefExtra?: string;
	/** Extra system-prompt notes (playbook lessons, harness notes). */
	systemNotes?: string[];
	onEvent?: (event: WorkerEvent) => void;
	/** Called for every ledger entry written through the ledger tool. */
	onLedgerEntry?: (entry: LedgerEntry) => void;
	/** Tools appended to the default set (gate checks, kernel, tests inject fakes). */
	extraTools?: AgentTool[];
	/** Ask the human; undefined in autonomous runs. */
	ask?: (question: string, options?: string[]) => Promise<string | undefined>;
	onPermission?: ToolContext["onPermission"];
	controller?: MissionController;
	/**
	 * Called after every turn. Return a reason to stop the worker early (stall,
	 * loop, budget); the mission loop then refines or branches.
	 */
	shouldStop?: (stats: WorkerStats) => string | undefined;
	/** Advisor called every `adviseEvery` turns with the transcript; its note is steered into the next turn. */
	advise?: (messages: AgentMessage[], turn: number) => Promise<AdvisorVerdict | undefined>;
	adviseEvery?: number;
	/** Token budget for the transcript; older tool outputs are masked beyond it. */
	contextBudgetTokens?: number;
}

export interface WorkerOutcome {
	turns: number;
	report: FinishReport;
	/** True when the turn cap ended the run rather than the finish tool. */
	turnCapReached: boolean;
	/** Set when `shouldStop` ended the run. */
	stoppedReason?: string;
	stats: WorkerStats;
	error?: string;
	aborted: boolean;
}

/** Compiles the worker system prompt: role, rules, gate and hashline guidance. */
export function workerSystemPrompt(options: {
	mission: Mission;
	gate: Gate;
	workspace: string;
	notes?: string[];
}): string {
	const { mission, gate } = options;
	const lines = [
		"You are a worker in Bedrock, a harness for hard, long-horizon software tasks. You own one approach to the mission below.",
		"",
		"## How you are judged",
		"An independent verifier runs the gate below against your tree, plus hidden holdout checks. It never reads your confidence. You are done when the checks pass, and only then.",
		"Never edit tests, checks or gate files to make them pass, never special-case test inputs, never read evaluation files you were not given. If a check is wrong, record that in the ledger and finish; do not weaken it.",
		"",
		"## Working rules",
		"- Orient first: read the files the task points at, find the tests, reproduce the failure before changing anything.",
		"- Read before you edit. The read tool returns tagged lines; your edit patch must carry the tag it saw. A stale tag is rejected: re-read and retry.",
		"- Make one focused change at a time and verify it with a command. Use the checks tool to run the visible gate; it records evidence automatically.",
		"- Record durable facts, hypotheses, decisions and risks with the ledger tool. Refute hypotheses explicitly when an experiment disproves them.",
		"- If you are stuck after two different attempts at the same problem, step back: write down what you ruled out, then try a genuinely different approach.",
		"- Prefer the smallest change that makes the checks pass. Do not refactor unrelated code. Do not add dependencies unless the task needs them.",
		"- Never claim a command passed unless you ran it and saw the exit code. When you finish, list the commands you ran and anything you could not verify.",
		"",
		`## Workspace\n${options.workspace}`,
		`## Mission\n${mission.spec.goal}`,
	];
	if (mission.spec.constraints?.length)
		lines.push(`Constraints:\n${mission.spec.constraints.map((line) => `- ${line}`).join("\n")}`);
	lines.push("", "## Gate (the definition of done)", gateText(gate));
	if (options.notes?.length)
		lines.push(
			"",
			"## Lessons from earlier missions (verify before relying on them)",
			...options.notes.map((note) => `- ${note}`),
		);
	return lines.join("\n");
}

function resultHead(result: unknown): string {
	const record = result as AgentToolResult<unknown> | undefined;
	const text = (record?.content ?? [])
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n");
	return text.split("\n").slice(0, 6).join("\n");
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

	const stats: WorkerStats = {
		turns: 0,
		toolCalls: 0,
		repeatedActionRatio: 0,
		turnsSinceNewFact: 0,
		failedToolCalls: 0,
		blockers: 0,
	};
	const signatures = new Map<string, number>();
	let repeated = 0;
	let lastFactTurn = 0;

	const onLedgerEntry = (entry: LedgerEntry) => {
		if (
			entry.kind === "fact" ||
			entry.kind === "decision" ||
			(entry.kind === "hypothesis" && entry.status !== "open")
		)
			lastFactTurn = stats.turns;
		options.onLedgerEntry?.(entry);
	};

	let report: FinishReport | undefined;
	const tools: AgentTool[] = [
		...createTools(toolContext),
		createLedgerTool({
			missionId: mission.id,
			workerId: options.workerId,
			sink: ledger,
			onEntry: onLedgerEntry,
		}) as AgentTool,
		createFinishTool({
			onReport: (value) => {
				report = value;
			},
		}) as AgentTool,
		...(options.extraTools ?? []),
	];

	let finished = false;
	let turnCapReached = false;
	let stoppedReason: string | undefined;

	const agent = new Agent({
		initialState: {
			systemPrompt: workerSystemPrompt({ mission, gate, workspace: options.workspace, notes: options.systemNotes }),
			model: resolved.model,
			thinkingLevel: resolved.effort === "off" ? "off" : (resolved.effort as "low" | "medium" | "high"),
			tools,
		},
		streamFn: ai.models.streamSimple.bind(ai.models),
		transformContext: options.contextBudgetTokens
			? async (messages) => maskOldObservations(messages, { maxTokens: options.contextBudgetTokens ?? 0 })
			: undefined,
		finishTurn: async (turn) => {
			if (finished) return { action: "end" as const };
			const every = options.adviseEvery ?? 3;
			if (options.advise && stats.turns > 0 && stats.turns % every === 0) {
				const verdict = await options.advise(turn.context.messages, stats.turns);
				if (verdict) {
					if (verdict.tag === "blocker") stats.blockers += 1;
					options.onEvent?.({ type: "advisor", tag: verdict.tag, text: verdict.text });
					agent.steer({
						role: "user",
						content: `[advisor ${verdict.tag}] ${verdict.text}`,
						timestamp: Date.now(),
					});
				}
			}
			if (stats.turns >= spec.turnCap) {
				turnCapReached = true;
				return { action: "end" as const };
			}
			stats.turnsSinceNewFact = stats.turns - lastFactTurn;
			const reason = options.shouldStop?.({ ...stats });
			if (reason) {
				stoppedReason = reason;
				options.onEvent?.({ type: "stopped", reason });
				return { action: "end" as const };
			}
			return { action: "continue" as const };
		},
		afterToolCall: async (context) => {
			if (context.toolCall.name === "finish") finished = true;
			return undefined;
		},
	});
	options.controller?.attach(agent);

	const unsubscribe = agent.subscribe((event: AgentEvent) => {
		if (event.type === "turn_start") {
			stats.turns += 1;
			options.onEvent?.({ type: "turn", turn: stats.turns });
		} else if (event.type === "message_update") {
			const delta = event.assistantMessageEvent;
			if (delta.type === "text_start") options.onEvent?.({ type: "text", text: "", start: true });
			else if (delta.type === "text_delta") options.onEvent?.({ type: "text", text: delta.delta, start: false });
			else if (delta.type === "thinking_delta") options.onEvent?.({ type: "thinking", text: delta.delta });
		} else if (event.type === "message_end") {
			const message = event.message as AssistantMessage;
			if (message.role === "assistant" && message.stopReason === "error") {
				options.onEvent?.({ type: "error", message: message.errorMessage ?? "provider error" });
			}
		} else if (event.type === "tool_execution_start") {
			stats.toolCalls += 1;
			const signature = `${event.toolName}:${JSON.stringify(event.args)}`;
			const seen = signatures.get(signature) ?? 0;
			if (seen > 0) repeated += 1;
			signatures.set(signature, seen + 1);
			stats.repeatedActionRatio = stats.toolCalls === 0 ? 0 : repeated / stats.toolCalls;
			options.onEvent?.({
				type: "tool_start",
				toolCallId: event.toolCallId,
				name: event.toolName,
				args: event.args,
			});
		} else if (event.type === "tool_execution_end") {
			if (event.isError) stats.failedToolCalls += 1;
			// Progress is anything that changes or measures the tree, not only ledger facts.
			else if (["edit", "write", "str_replace", "apply_patch", "checks"].includes(event.toolName))
				lastFactTurn = stats.turns;
			options.onEvent?.({
				type: "tool_end",
				toolCallId: event.toolCallId,
				name: event.toolName,
				args: undefined,
				ok: !event.isError,
				durationMs: event.durationMs,
				head: resultHead(event.result),
				details: (event.result as AgentToolResult<unknown> | undefined)?.details,
			});
		}
	});

	const brief = [spec.brief, options.briefExtra].filter((part): part is string => Boolean(part)).join("\n\n");
	let error: string | undefined;
	try {
		await agent.prompt(brief);
	} catch (caught) {
		error = (caught as Error).message;
	} finally {
		unsubscribe();
		options.controller?.detach(agent);
	}
	const aborted = options.controller?.cancelled ?? false;
	stats.turnsSinceNewFact = stats.turns - lastFactTurn;

	const finalReport: FinishReport = report ?? {
		summary: aborted
			? "interrupted by the human"
			: stoppedReason
				? `stopped early: ${stoppedReason}`
				: turnCapReached
					? `turn cap (${spec.turnCap}) reached without finishing`
					: error
						? `worker crashed: ${error}`
						: "worker stopped without a finish report",
		checks: [],
		unverified: ["the worker did not report what it verified"],
	};
	options.onEvent?.({ type: "finished", report: finalReport });
	return { turns: stats.turns, report: finalReport, turnCapReached, stoppedReason, stats, error, aborted };
}
