// @bedrock/protocol: pluggable contracts. Each one is a seam the lab can optimize.

import type { BudgetAction } from "./events.ts";
import type { Gate, GateResult, IntegrityRules } from "./gate.ts";
import type { Id, Timestamp } from "./ids.ts";
import type { Candidate, LedgerEntry, RefineBrief } from "./ledger.ts";
import type { Mission, ScoutReport, StrategyTree, WorkerState } from "./mission.ts";
import type { Role } from "./roles.ts";

/** A candidate as selection and verification see it: the ledger record plus its gate result and diff. */
export type CandidateView = Candidate & {
	/** The gate result that produced this candidate. */
	gate: GateResult;
	/** Compact summary the judge sees: intent, diffstat, key hunks, remaining risks. */
	summary: string;
	diff?: string;
	/** Rubric score from L3, 0..1. */
	rubricScore?: number;
};

/** Produces a gate for a mission. The default implementation is the LLM gate compiler. */
export interface GateProvider {
	compile(mission: Mission, scout: ScoutReport | undefined): Promise<Gate>;
}

/** One layer of verification. Layers run cheapest-first; `0` to `4` map to L0..L4 in the docs. */
export interface Verifier {
	readonly level: 0 | 1 | 2 | 3 | 4;
	readonly name: string;
	/** Skip this layer when its preconditions are not met (e.g. no candidate tree or no rubric). */
	applies(candidate: CandidateView, gate: Gate): boolean;
	verify(candidate: CandidateView, gate: Gate, context?: unknown): Promise<GateResult>;
}

/** Picks a winner among gate-passing candidates. */
export interface SelectionStrategy {
	/** Picks a winner; `winner` is undefined when no candidate is eligible. */
	select(
		candidates: CandidateView[],
		gate: Gate,
	): Promise<{ winner?: CandidateView; rationale: string; ranking: Id<"worker">[] }>;
}

/**
 * Observable signals the budget controller reasons over. Every value is
 * computed by the harness, never reported by the model.
 */
export interface BudgetSignals {
	turns: number;
	turnsSinceNewFact: number;
	gatePassRatio: number;
	gateTrend: number;
	verifierDisagreement: number;
	repeatedActionRatio: number;
	candidateCount: number;
	candidateDiversity: number;
	blockerCount: number;
	costUsd: number;
	tokens: number;
	wallClockMs: number;
	attempts: number;
}

export interface BudgetSnapshot {
	mission: Mission;
	signals: BudgetSignals;
	workers: WorkerState[];
	limits: { usd?: number; tokens?: number; wallClockMs?: number; turns?: number; maxParallelWorkers: number };
}

export interface BudgetDecision {
	action: BudgetAction;
	reason: string;
	/** For `widen`: how many workers to run in total. */
	parallelism?: number;
	/** For `prune`: which branches to kill. */
	prune?: Id<"strategy">[];
	/** Human-readable question for `ask_human`. */
	question?: string;
}

/** The brain. Small, explicit, testable, and replaceable by `bedrock lab evolve`. */
export interface BudgetPolicy {
	name: string;
	decide(snapshot: BudgetSnapshot): Promise<BudgetDecision>;
}

/** Turns a strategy tree plus scout report into worker briefs. */
export interface Strategist {
	plan(mission: Mission, gate: Gate, scout: ScoutReport | undefined, playbook: LedgerEntry[]): Promise<StrategyTree>;
}

/** Distills failed attempts into a compact brief for the next rollout (PDR). */
export interface Refiner {
	distill(failed: CandidateView[], gate: Gate, entries: LedgerEntry[], at: Timestamp): Promise<RefineBrief>;
}

/** A role-specific model assignment resolved from configuration. */
export interface ResolvedRole {
	role: Role;
	model: string;
	fallbacks: string[];
	effort: string;
}

/** Integrity rules are committed with the gate and are immutable to refinement. */
export interface IntegrityRulesProvider {
	rules(): IntegrityRules;
}
