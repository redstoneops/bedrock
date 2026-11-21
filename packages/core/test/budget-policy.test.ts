import type { BudgetSnapshot } from "@bedrock/protocol";
import { createId } from "@bedrock/protocol";
import { describe, expect, it } from "vitest";
import { DEFAULT_TUNING, decide, overBudget, pruneCandidates, signalsFrom } from "../src/index.ts";

function snapshot(
	overrides: Partial<BudgetSnapshot["signals"]> = {},
	limits: Partial<BudgetSnapshot["limits"]> = {},
): BudgetSnapshot {
	return {
		mission: {
			id: createId("mission"),
			spec: { goal: "g", mode: "run", budget: {}, isolation: "worktree" },
			status: "running",
			phase: "execute",
			createdAt: "t",
			updatedAt: "t",
			workspace: "/w",
			baseTree: "a",
		},
		signals: signalsFrom({
			turns: 10,
			turnsSinceNewFact: 1,
			gatePassRatio: 0,
			costUsd: 1,
			tokens: 1000,
			wallClockMs: 1000,
			attempts: 1,
			...overrides,
		}),
		workers: [],
		limits: { usd: 20, wallClockMs: 3_600_000, turns: 200, maxParallelWorkers: 4, ...limits },
	};
}

describe("budget limits", () => {
	it("stops at a hard limit, inclusively", () => {
		expect(overBudget(snapshot({ costUsd: 20 }))).toBe(true);
		expect(overBudget(snapshot({ costUsd: 19.99 }))).toBe(false);
		expect(overBudget(snapshot({ wallClockMs: 3_600_000 }))).toBe(true);
		expect(overBudget(snapshot({ turns: 200 }))).toBe(true);
	});
});

describe("decide", () => {
	it("stops on a pass before buying anything else", () => {
		expect(decide(snapshot(), DEFAULT_TUNING, true).action).toBe("stop");
	});

	it("stops when the budget is exhausted", () => {
		expect(decide(snapshot({ costUsd: 20 })).reason).toContain("budget");
	});

	it("escalates when verifiers disagree", () => {
		const decision = decide(snapshot({ verifierDisagreement: 0.5 }));
		expect(decision.action).toBe("escalate");
		expect(decision.reason).toContain("ambiguity");
	});

	it("asks the human after repeated blockers", () => {
		expect(decide(snapshot({ blockerCount: 2 })).action).toBe("ask_human");
	});

	it("refines when stalled, and branches when looping", () => {
		expect(decide(snapshot({ turnsSinceNewFact: 8 })).action).toBe("refine");
		expect(decide(snapshot({ repeatedActionRatio: 0.9, turnsSinceNewFact: 1 })).action).toBe("branch");
	});

	it("widens at the turn cap, then refines once candidates exist", () => {
		const widen = decide(snapshot({ turns: 120, candidateCount: 0, attempts: 2, candidateDiversity: 1 }));
		expect(widen.action).toBe("widen");
		expect(widen.parallelism).toBe(3);
		const refine = decide(snapshot({ turns: 120, candidateCount: 4, attempts: 4 }));
		expect(refine.action).toBe("refine");
	});

	it("widens when attempts are similar and none pass", () => {
		expect(decide(snapshot({ gatePassRatio: 0.4, attempts: 2, candidateDiversity: 0.1 })).action).toBe("widen");
	});

	it("widens after the first failed attempt when parallel workers are allowed", () => {
		const decision = decide(snapshot({ gatePassRatio: 0.5, attempts: 1, candidateCount: 1 }));
		expect(decision.action).toBe("widen");
		expect(decision.parallelism).toBe(2);
	});

	it("continues when there is no reason to change course", () => {
		expect(decide(snapshot({ gatePassRatio: 0.5, attempts: 1 }, { maxParallelWorkers: 1 })).action).toBe("continue");
	});
});

describe("pruneCandidates", () => {
	it("keeps the best candidates and returns the weak ones", () => {
		const make = (ratio: number, name: string) => ({
			strategyId: createId("strategy"),
			name,
			gate: { passRatio: ratio },
		});
		const a = make(0.1, "a");
		const b = make(0.9, "b");
		const c = make(0.5, "c");
		const pruned = pruneCandidates([a, b, c], 1);
		expect(pruned.map((candidate) => candidate.name)).toEqual(["a", "c"]);
	});
});
