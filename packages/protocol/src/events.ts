// @bedrock/protocol: the append-only event stream every surface (TUI, RPC, JSONL, lab) consumes.

import type { FinalState, GateResult, Suspicion } from "./gate.ts";
import type { Id, Timestamp } from "./ids.ts";
import type { LedgerEntry, LedgerSummary } from "./ledger.ts";
import type {
	MissionPhase,
	ProofOfWork,
	ScoutReport,
	StrategyNode,
	StrategyTree,
	WorkerSpec,
	WorkerStatus,
} from "./mission.ts";
import type { Role } from "./roles.ts";

export type AdvisorTag = "aside" | "concern" | "blocker";

export type BudgetAction = "continue" | "refine" | "branch" | "widen" | "escalate" | "prune" | "ask_human" | "stop";

/** A note from the advisor model, injected into a worker's next turn. */
export interface AdvisorNote {
	id: Id<"entry">;
	workerId: Id<"worker">;
	tag: AdvisorTag;
	text: string;
	createdAt: Timestamp;
}

export interface BudgetDecisionRecord {
	id: Id<"entry">;
	action: BudgetAction;
	reason: string;
	signals: Record<string, number>;
	createdAt: Timestamp;
}

/** One unit of tool output, ready to render as a card. */
export interface ToolCallCard {
	toolCallId: string;
	workerId: Id<"worker">;
	name: string;
	args: Record<string, unknown>;
	label: string;
	status: "running" | "ok" | "error";
	startedAt: Timestamp;
	finishedAt?: Timestamp;
	exitCode?: number;
	durationMs?: number;
	/** First lines of output, for the collapsed card. */
	head?: string;
	/** Full output artifact handle. */
	artifact?: Id<"artifact">;
	/** Line counts for edit tools. */
	diffStat?: { additions: number; deletions: number };
}

export interface Heartbeat {
	workerId: Id<"worker">;
	at: Timestamp;
	lastAction: string;
	turns: number;
	costUsd: number;
}

export type BedrockEvent =
	| { type: "mission_start"; missionId: Id<"mission">; goal: string; workspace: string; at: Timestamp }
	| { type: "mission_phase"; missionId: Id<"mission">; phase: MissionPhase; at: Timestamp }
	| { type: "mission_finish"; missionId: Id<"mission">; finalState: FinalState; proof: ProofOfWork; at: Timestamp }
	| { type: "scout_report"; missionId: Id<"mission">; report: ScoutReport; at: Timestamp }
	| {
			type: "gate_compiled";
			missionId: Id<"mission">;
			gateId: Id<"gate">;
			version: number;
			checks: number;
			at: Timestamp;
	  }
	| { type: "strategy_tree"; missionId: Id<"mission">; tree: StrategyTree; at: Timestamp }
	| { type: "strategy_node"; missionId: Id<"mission">; node: StrategyNode; at: Timestamp }
	| { type: "worker_spawned"; missionId: Id<"mission">; workerId: Id<"worker">; spec: WorkerSpec; at: Timestamp }
	| { type: "worker_status"; missionId: Id<"mission">; workerId: Id<"worker">; status: WorkerStatus; at: Timestamp }
	| { type: "worker_turn"; missionId: Id<"mission">; workerId: Id<"worker">; turn: number; at: Timestamp }
	| {
			type: "assistant_delta";
			missionId: Id<"mission">;
			workerId: Id<"worker">;
			text: string;
			/** True when this delta continues the previous one (streaming). */
			append: boolean;
			at: Timestamp;
	  }
	| { type: "tool_call"; missionId: Id<"mission">; card: ToolCallCard; at: Timestamp }
	| { type: "advisor_note"; missionId: Id<"mission">; note: AdvisorNote; at: Timestamp }
	| { type: "ledger_entry"; missionId: Id<"mission">; entry: LedgerEntry; at: Timestamp }
	| { type: "ledger_summary"; missionId: Id<"mission">; summary: LedgerSummary; at: Timestamp }
	| {
			type: "verification";
			missionId: Id<"mission">;
			workerId: Id<"worker">;
			level: 0 | 1 | 2 | 3 | 4;
			result: GateResult;
			at: Timestamp;
	  }
	| { type: "suspicion"; missionId: Id<"mission">; workerId: Id<"worker">; suspicion: Suspicion; at: Timestamp }
	| { type: "budget_decision"; missionId: Id<"mission">; decision: BudgetDecisionRecord; at: Timestamp }
	| { type: "steer"; missionId: Id<"mission">; workerId?: Id<"worker">; text: string; at: Timestamp }
	| { type: "checkpoint"; missionId: Id<"mission">; label: string; commit: string; at: Timestamp }
	| {
			type: "subagent";
			missionId: Id<"mission">;
			parentId: Id<"worker">;
			childId: Id<"session">;
			role: Role;
			brief: string;
			status: "spawned" | "settled" | "failed";
			at: Timestamp;
	  }
	| { type: "heartbeat"; missionId: Id<"mission">; heartbeat: Heartbeat; at: Timestamp }
	| {
			type: "notice";
			missionId: Id<"mission">;
			level: "info" | "warning" | "error";
			text: string;
			at: Timestamp;
	  }
	| { type: "crash_recovered"; missionId: Id<"mission">; replayedEvents: number; at: Timestamp };

export type BedrockEventType = BedrockEvent["type"];

/** A numbered event as persisted in the session event log. */
export interface LoggedEvent {
	seq: number;
	sessionId: Id<"session">;
	event: BedrockEvent;
	at: Timestamp;
}

/** Filters accepted by event subscriptions. */
export interface EventFilter {
	missionId?: Id<"mission">;
	types?: BedrockEventType[];
}
