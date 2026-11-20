import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "@bedrock/protocol";
import { afterEach, describe, expect, it } from "vitest";
import {
	type ArchiveEntry,
	type AttemptResult,
	type BenchTask,
	computeMetrics,
	evolve,
	listRuns,
	paretoFront,
	reportRun,
	runSuite,
	saveRun,
} from "../src/index.ts";

const dirs: string[] = [];
function temp(): string {
	const dir = mkdtempSync(join(tmpdir(), "bedrock-lab-"));
	dirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function attempt(
	taskId: string,
	finalState: AttemptResult["finalState"],
	holdoutPassed: boolean,
	costUsd = 1,
): AttemptResult {
	return { taskId, finalState, holdoutPassed, costUsd, wallClockMs: 1000, tokens: 100, turns: 3 };
}

describe("metrics", () => {
	it("computes pass@1, best@k, false completion and cost per solve", () => {
		const metrics = computeMetrics([
			attempt("a", "passed", true, 2),
			attempt("b", "failed", false, 1),
			attempt("b", "passed", true, 1),
			// Claims success but the holdout fails: a false completion.
			attempt("c", "passed", false, 1),
			attempt("c", "failed", false, 1),
		]);
		expect(metrics.tasks).toBe(3);
		expect(metrics.passAt1).toBeCloseTo(1 / 3, 5);
		expect(metrics.bestAtK).toBeCloseTo(2 / 3, 5);
		expect(metrics.falseCompletionRate).toBeCloseTo(1 / 3, 5);
		expect(metrics.costPerSolved).toBeCloseTo(6 / 2, 5);
		expect(metrics.solved).toBe(2);
	});

	it("reports no cost per solve when nothing was solved", () => {
		const metrics = computeMetrics([attempt("a", "failed", false)]);
		expect(metrics.costPerSolved).toBeUndefined();
		expect(metrics.falseCompletionRate).toBe(0);
	});
});

describe("runSuite", () => {
	const suite = {
		name: "smoke",
		description: "two tasks",
		tasks: [
			{ id: "a", goal: "do a", gate: ["true"], tags: ["hard"] },
			{ id: "b", goal: "do b", gate: ["true"], tags: ["easy"] },
		] satisfies BenchTask[],
	};

	it("runs every task, records attempts and survives a throwing runner", async () => {
		const config = defaultConfig();
		const seen: string[] = [];
		const run = await runSuite({
			suite,
			config,
			attempts: 2,
			runner: async (task, _config, attemptNumber) => {
				seen.push(`${task.id}:${attemptNumber}`);
				if (task.id === "b") throw new Error("boom");
				return attempt(task.id, attemptNumber === 1 ? "failed" : "passed", attemptNumber === 2);
			},
		});
		expect(seen).toEqual(["a:1", "a:2", "b:1", "b:2"]);
		expect(run.attempts).toHaveLength(4);
		expect(run.attempts.find((result) => result.taskId === "b")?.error).toBe("boom");
		expect(run.metrics.bestAtK).toBeCloseTo(0.5, 5);
		expect(reportRun(run)).toContain("1/2 solved");
	});

	it("filters by tag", async () => {
		const run = await runSuite({
			suite,
			config: defaultConfig(),
			tags: ["hard"],
			runner: async (task) => attempt(task.id, "passed", true),
		});
		expect(run.attempts.map((result) => result.taskId)).toEqual(["a"]);
	});

	it("saves and lists runs from disk", async () => {
		const dir = temp();
		const run = await runSuite({
			suite,
			config: defaultConfig(),
			runner: async (task) => attempt(task.id, "passed", true),
		});
		saveRun(dir, run);
		expect(listRuns(dir)[0].runId).toBe(run.runId);
	});
});

describe("evolve", () => {
	it("keeps a Pareto archive and promotes only on held-out evidence", async () => {
		const base = { id: "base", description: "hand-tuned", config: defaultConfig() };
		const better = { id: "better", description: "widen earlier", config: defaultConfig() };
		const worse = { id: "worse", description: "narrow", config: defaultConfig() };
		const runFor = (variant: string, success: number, cost: number) => ({
			runId: `run_${variant}`,
			label: "suite",
			startedAt: "t",
			finishedAt: "t",
			config: defaultConfig(),
			variant,
			attempts: [],
			metrics: {
				passAt1: success,
				bestAtK: success,
				falseCompletionRate: 0,
				costPerSolved: cost,
				wallClockMs: 0,
				tokens: 0,
				solved: 0,
				tasks: 1,
			},
		});
		const result = await evolve({
			base,
			search: async () => [{ id: "a" }],
			evaluate: async (variant) =>
				runFor(
					variant.id,
					variant.id === "better" ? 0.9 : variant.id === "worse" ? 0.2 : 0.5,
					variant.id === "better" ? 2 : 1,
				),
			propose: async () => [better, worse],
			evaluateHoldout: async (variant) => ({ success: variant.id === "better" ? 0.85 : 0.4, costPerSolved: 2 }),
			holdoutThreshold: 0.8,
			rounds: 1,
		});
		expect(result.promoted?.variant.id).toBe("better");
		expect(result.log.join("\n")).toContain("holdout 85.0% (threshold met)");
		const front = paretoFront(result.archive as ArchiveEntry[]);
		expect(front.map((entry) => entry.variant.id)).toContain("better");
		expect(front.map((entry) => entry.variant.id)).not.toContain("worse");
	});

	it("promotes nothing when the holdout is not met", async () => {
		const base = { id: "base", description: "base", config: defaultConfig() };
		const result = await evolve({
			base,
			search: async () => [],
			evaluate: async () => ({
				runId: "r",
				label: "s",
				startedAt: "t",
				finishedAt: "t",
				config: defaultConfig(),
				variant: "base",
				attempts: [],
				metrics: {
					passAt1: 0.2,
					bestAtK: 0.2,
					falseCompletionRate: 0,
					costPerSolved: 1,
					wallClockMs: 0,
					tokens: 0,
					solved: 0,
					tasks: 1,
				},
			}),
			propose: async () => [],
			evaluateHoldout: async () => ({ success: 0.3, costPerSolved: 1 }),
			holdoutThreshold: 0.8,
			rounds: 1,
		});
		expect(result.promoted).toBeUndefined();
		expect(result.log.at(-1)).toContain("nothing promoted");
	});
});
