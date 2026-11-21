// @bedrock/core: the Repeater. A small, explicit policy over observable signals.
//
// The policy is pure and synchronous on purpose: it is easy to test, easy to log,
// and easy for `bedrock lab evolve` to replace. Signals are harness-computed;
// nothing here trusts a model's self-report.

import type { BudgetDecision, BudgetPolicy, BudgetSignals, BudgetSnapshot, Id } from "@bedrock/protocol";

export interface PolicyTuning {
	/** Sequential turns after which a worker is considered saturated. */
	turnCap: number;
	/** Turns without a new ledger fact before the stall rule fires. */
	stallTurns: number;
	/** Gate pass ratio below which an attempt is treated as a failure. */
	partialThreshold: number;
	maxParallelWorkers: number;
	/** Repeated-action ratio above which a worker is looping. */
	loopThreshold: number;
}

export const DEFAULT_TUNING: PolicyTuning = {
	turnCap: 120,
	stallTurns: 8,
	partialThreshold: 0.999,
	maxParallelWorkers: 4,
	loopThreshold: 0.6,
};

/** True when any hard limit is reached. Limits are inclusive: reaching it ends the run. */
export function overBudget(snapshot: BudgetSnapshot): boolean {
	const { signals, limits } = snapshot;
	if (limits.usd !== undefined && signals.costUsd >= limits.usd) return true;
	if (limits.tokens !== undefined && signals.tokens >= limits.tokens) return true;
	if (limits.wallClockMs !== undefined && signals.wallClockMs >= limits.wallClockMs) return true;
	if (limits.turns !== undefined && signals.turns >= limits.turns) return true;
	return false;
}

/**
 * The default policy. Order matters: budget, then success, then ambiguity, then
 * stalling, then diversity, then parallel widening. The ordering encodes the
 * product's priorities: never fake a pass, never spend money on a run that is
 * done, escalate a confused verifier before buying more parallel attempts.
 */
export function decide(
	snapshot: BudgetSnapshot,
	tuning: PolicyTuning = DEFAULT_TUNING,
	attemptPassed = false,
): BudgetDecision {
	const { signals, limits } = snapshot;
	if (overBudget(snapshot)) {
		return { action: "stop", reason: "hard budget limit reached; report the best verified candidate honestly" };
	}
	if (attemptPassed) {
		return { action: "stop", reason: "the gate passed on a hashed tree; nothing left to buy" };
	}
	if (signals.verifierDisagreement > 0.3) {
		return {
			action: "escalate",
			reason:
				"verifiers disagree, which points at ambiguity rather than difficulty; strengthen the judge before buying more attempts",
		};
	}
	if (signals.blockerCount >= 2) {
		return {
			action: "ask_human",
			reason: `${signals.blockerCount} advisor blockers; continuing would likely repeat the same mistake`,
			question: "Should I widen the sandbox, change the approach, or stop?",
		};
	}
	if (signals.repeatedActionRatio >= tuning.loopThreshold) {
		return {
			action: "branch",
			reason:
				"the same action keeps repeating; a different approach in a different workspace is cheaper than another retry",
		};
	}
	if (signals.turnsSinceNewFact >= tuning.stallTurns) {
		return {
			action: "refine",
			reason: `${signals.turnsSinceNewFact} turns without a new ledger fact; restart from a distilled brief instead of extending a stalled context`,
		};
	}
	if (
		signals.attempts === 1 &&
		signals.candidateCount <= 1 &&
		Math.min(limits.maxParallelWorkers, tuning.maxParallelWorkers) > 1
	) {
		return {
			action: "widen",
			reason: "the first full attempt failed; diversity is now cheaper than persistence",
			parallelism: 2,
		};
	}
	if (signals.turns >= tuning.turnCap) {
		const workers = limits.maxParallelWorkers;
		if (signals.candidateCount < Math.min(workers, tuning.maxParallelWorkers)) {
			return {
				action: "widen",
				reason: `sequential turns reached the cap (${tuning.turnCap}); spend the next budget on parallel diversity`,
				parallelism: Math.min(workers, signals.attempts + 1),
			};
		}
		return { action: "refine", reason: "parallel candidates exist; distill their failures and restart once more" };
	}
	if (
		signals.gatePassRatio > 0 &&
		signals.gatePassRatio < tuning.partialThreshold &&
		signals.attempts >= 2 &&
		signals.candidateDiversity < 0.3
	) {
		return {
			action: "widen",
			reason: "attempts are similar and none passes; diversity is the missing resource",
			parallelism: Math.min(limits.maxParallelWorkers, signals.attempts + 1),
		};
	}
	return { action: "continue", reason: "progress is within budget and the signals give no reason to change course" };
}

/** The policy object the mission loop uses. */
export class DefaultBudgetPolicy implements BudgetPolicy {
	readonly name = "default";
	#tuning: PolicyTuning;
	#lastPassed = (): boolean => false;

	constructor(tuning: Partial<PolicyTuning> = {}) {
		this.#tuning = { ...DEFAULT_TUNING, ...tuning };
	}

	/** Wired by the mission loop so `decide` can see whether the last attempt passed. */
	onAttemptResult(read: () => boolean): void {
		this.#lastPassed = read;
	}

	async decide(snapshot: BudgetSnapshot): Promise<BudgetDecision> {
		return decide(snapshot, this.#tuning, this.#lastPassed());
	}
}

/** Builds a snapshot from a mission's live numbers. */
export function signalsFrom(input: {
	turns: number;
	turnsSinceNewFact: number;
	gatePassRatio: number;
	gateTrend?: number;
	verifierDisagreement?: number;
	repeatedActionRatio?: number;
	candidateCount?: number;
	candidateDiversity?: number;
	blockerCount?: number;
	costUsd: number;
	tokens: number;
	wallClockMs: number;
	attempts: number;
}): BudgetSignals {
	return {
		turns: input.turns,
		turnsSinceNewFact: input.turnsSinceNewFact,
		gatePassRatio: input.gatePassRatio,
		gateTrend: input.gateTrend ?? 0,
		verifierDisagreement: input.verifierDisagreement ?? 0,
		repeatedActionRatio: input.repeatedActionRatio ?? 0,
		candidateCount: input.candidateCount ?? 0,
		candidateDiversity: input.candidateDiversity ?? 0,
		blockerCount: input.blockerCount ?? 0,
		costUsd: input.costUsd,
		tokens: input.tokens,
		wallClockMs: input.wallClockMs,
		attempts: input.attempts,
	};
}

/** The branches a prune decision should kill: failed strategies with the lowest pass ratio. */
export function pruneCandidates<T extends { strategyId: Id<"strategy">; gate: { passRatio: number } }>(
	candidates: T[],
	keep = 1,
): T[] {
	return [...candidates]
		.sort((a, b) => a.gate.passRatio - b.gate.passRatio)
		.slice(0, Math.max(0, candidates.length - keep));
}
