// @bedrock/protocol: a Mission is one unit of work, from goal to proof of work.

import type { FinalState, GateResult } from "./gate.ts";
import type { Id, Timestamp } from "./ids.ts";
import type { BudgetLimits, IsolationMode, MissionMode, Role } from "./roles.ts";

/** Phase of the Bedrock loop. The TUI renders this verbatim. */
export type MissionPhase =
	| "bootstrap"
	| "scout"
	| "gate"
	| "plan"
	| "execute"
	| "verify"
	| "select"
	| "refine"
	| "reflect"
	| "done";

export type MissionStatus = "running" | "paused" | "awaiting_input" | "finished";

export interface MissionSpec {
	goal: string;
	/** Things that must not change or must be respected (API surface, perf, files). */
	constraints?: string[];
	mode: MissionMode;
	budget: BudgetLimits;
	/** User-provided gate commands; always included in the compiled gate and never weakened. */
	gateCommands?: string[];
	isolation: IsolationMode;
	/** Container image when `isolation` is `container`. */
	containerImage?: string;
	/** Start from an existing gate instead of compiling one (lab/eval use). */
	gateId?: Id<"gate">;
}

export interface Mission {
	id: Id<"mission">;
	spec: MissionSpec;
	status: MissionStatus;
	phase: MissionPhase;
	createdAt: Timestamp;
	updatedAt: Timestamp;
	finishedAt?: Timestamp;
	/** Absolute path of the primary workspace (the repo root the mission was started in). */
	workspace: string;
	gateId?: Id<"gate">;
	/** Tree hash of the workspace when the mission started, used to prove what changed. */
	baseTree: string;
	baseCommit?: string;
	finalState?: FinalState;
	/** Populated when the mission ends. */
	proof?: ProofOfWork;
}

/** Everything a reviewer needs to trust or reject the result. */
export interface ProofOfWork {
	missionId: Id<"mission">;
	finalState: FinalState;
	summary: string;
	/** Files changed across the delivered candidate(s). */
	diffStat: { files: number; additions: number; deletions: number };
	gate?: GateResult;
	/** Ledger entries a reader should start from, newest evidence first. */
	evidence: Id<"entry">[];
	/** Claims the harness could not verify, stated plainly. */
	unverified: string[];
	/** Known risks that remain after the mission. */
	risks: string[];
	checkpoints: { label: string; commit: string }[];
	cost: { usd: number; tokens: number; wallClockMs: number };
	createdAt: Timestamp;
}

export type StrategyStatus = "planned" | "running" | "passed" | "failed" | "pruned" | "abandoned";

/** One node of the strategy tree: root = mission, children = distinct approaches. */
export interface StrategyNode {
	id: Id<"strategy">;
	parentId?: Id<"strategy">;
	/** Short title shown in the TUI tree, e.g. "B: incremental port". */
	title: string;
	hypothesis: string;
	risks: string[];
	/** Why this approach is meaningfully different from its siblings. */
	distinctFrom?: string;
	estimatedCostUsd?: number;
	status: StrategyStatus;
	/** Worker that pursued this branch. */
	workerId?: Id<"worker">;
	children: Id<"strategy">[];
}

export interface StrategyTree {
	id: Id<"strategy">;
	missionId: Id<"mission">;
	rootId: Id<"strategy">;
	nodes: Record<string, StrategyNode>;
	createdAt: Timestamp;
	rationale: string;
}

/** A worker is one agent session running one approach in one isolated workspace. */
export interface WorkerSpec {
	missionId: Id<"mission">;
	strategyId: Id<"strategy">;
	role: Role;
	/** The brief: goal, gate summary, constraints, refine brief, and anything the worker needs. */
	brief: string;
	/** Isolated workspace the worker owns (worktree path or container name). */
	workspace: string;
	branch?: string;
	baseCommit: string;
	model?: string;
	turnCap: number;
	kernel: boolean;
}

export type WorkerStatus = "starting" | "running" | "idle" | "passed" | "failed" | "killed" | "crashed";

export interface WorkerState {
	id: Id<"worker">;
	missionId: Id<"mission">;
	strategyId: Id<"strategy">;
	status: WorkerStatus;
	sessionId: Id<"session">;
	workspace: string;
	branch?: string;
	turns: number;
	startedAt: Timestamp;
	updatedAt: Timestamp;
	/** Verifier verdict for this worker's final tree, once verified. */
	gateResult?: GateResult;
}

/** The environment snapshot taken before the first model turn. */
export interface ScoutReport {
	missionId: Id<"mission">;
	createdAt: Timestamp;
	root: string;
	vcs?: { kind: "git"; branch: string; commit: string; clean: boolean };
	languages: { name: string; files: number }[];
	buildSystem?: string;
	/** Commands the scout believes are the canonical build/test/lint entry points. */
	commands: {
		install?: string;
		build?: string;
		test?: string;
		lint?: string;
		typecheck?: string;
		format?: string;
	};
	contextFiles: string[];
	/** Human- and agent-readable notes: conventions, gotchas, CI config. */
	notes: string[];
	services: { name: string; reachable: boolean; detail?: string }[];
}
