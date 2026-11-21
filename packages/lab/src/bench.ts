// @bedrock/lab: Beacon. Benchmarks, metrics and ablations.
//
// A run is only meaningful if it records what configuration produced it and
// whether the *holdout* passed. False completion — a run that claims success
// while the holdout fails — is a first-class metric, not an afterthought.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type { BedrockConfig, FinalState, GateResult } from "@bedrock/protocol";

export interface BenchTask {
	id: string;
	/** What the agent is told to do. */
	goal: string;
	/** Repository fixture or setup command the harness runs before starting. */
	setup?: string;
	/** Visible checks the worker sees. */
	gate: string[];
	/** Checks only the evaluator runs; a pass without these is a false completion. */
	holdout?: string[];
	/** Optional per-task budget override, in dollars. */
	maxUsd?: number;
	/** Tags used by ablations and splits (e.g. "hard", "long"). */
	tags?: string[];
	/** Directory copied into a fresh git repository as the task's starting state (relative to the suite file). */
	fixture?: string;
	/** Where the task came from, for adapters (e.g. a Terminal-Bench task directory). */
	source?: { kind: "local" | "terminal-bench"; dir: string };
}

export interface AttemptResult {
	taskId: string;
	finalState: FinalState;
	/** The holdout verdict, computed by the evaluator, not the agent. */
	holdoutPassed: boolean;
	costUsd: number;
	wallClockMs: number;
	tokens: number;
	turns: number;
	/** Verifier output, for failure classification. */
	gate?: GateResult;
	error?: string;
}

export interface RunRecord {
	runId: string;
	label: string;
	startedAt: string;
	finishedAt: string;
	config: BedrockConfig;
	/** The harness/policy variant under test. */
	variant: string;
	attempts: AttemptResult[];
	metrics: SuiteMetrics;
}

export interface SuiteMetrics {
	/** Fraction of tasks whose first attempt passed the holdout. */
	passAt1: number;
	/** Fraction of tasks where at least one attempt passed (k = attempts per task). */
	bestAtK: number;
	/** Runs that reported passed but failed the holdout. */
	falseCompletionRate: number;
	/** USD per solved task, or undefined when nothing was solved. */
	costPerSolved: number | undefined;
	wallClockMs: number;
	tokens: number;
	solved: number;
	tasks: number;
}

/** Computes the suite metrics. Pure, so the dashboard and tests agree. */
export function computeMetrics(attempts: AttemptResult[]): SuiteMetrics {
	const byTask = new Map<string, AttemptResult[]>();
	for (const attempt of attempts) byTask.set(attempt.taskId, [...(byTask.get(attempt.taskId) ?? []), attempt]);
	const tasks = byTask.size;
	let passAt1 = 0;
	let bestAtK = 0;
	let falseCompletions = 0;
	let claimed = 0;
	let solved = 0;
	let cost = 0;
	let wallClockMs = 0;
	let tokens = 0;
	for (const taskAttempts of byTask.values()) {
		const first = taskAttempts[0];
		if (first?.finalState === "passed" && first.holdoutPassed) passAt1 += 1;
		if (taskAttempts.some((attempt) => attempt.finalState === "passed" && attempt.holdoutPassed)) {
			bestAtK += 1;
			solved += 1;
		}
		for (const attempt of taskAttempts) {
			if (attempt.finalState === "passed") {
				claimed += 1;
				if (!attempt.holdoutPassed) falseCompletions += 1;
			}
			cost += attempt.costUsd;
			wallClockMs += attempt.wallClockMs;
			tokens += attempt.tokens;
		}
	}
	return {
		passAt1: tasks === 0 ? 0 : passAt1 / tasks,
		bestAtK: tasks === 0 ? 0 : bestAtK / tasks,
		falseCompletionRate: claimed === 0 ? 0 : falseCompletions / claimed,
		costPerSolved: solved === 0 ? undefined : cost / solved,
		wallClockMs,
		tokens,
		solved,
		tasks,
	};
}

/** A suite manifest, stored next to the tasks in `evals/`. */
export interface SuiteManifest {
	name: string;
	description: string;
	tasks: BenchTask[];
	/** Tasks reserved for promotion decisions; never used to tune. */
	holdoutTasks?: string[];
}

export function loadSuite(path: string): SuiteManifest {
	const manifest = JSON.parse(readFileSync(path, "utf8")) as SuiteManifest;
	const base = dirname(path);
	for (const task of manifest.tasks ?? [])
		if (task.fixture && !isAbsolute(task.fixture)) task.fixture = join(base, task.fixture);
	if (!Array.isArray(manifest.tasks) || manifest.tasks.length === 0) throw new Error(`${path} has no tasks`);
	for (const task of manifest.tasks) {
		if (!task.id || !task.goal || task.gate.length === 0)
			throw new Error(`task ${task.id ?? "<unnamed>"} in ${path} needs id, goal and gate`);
	}
	return manifest;
}

export type TaskRunner = (task: BenchTask, config: BedrockConfig, attempt: number) => Promise<AttemptResult>;

export interface RunSuiteOptions {
	suite: SuiteManifest;
	config: BedrockConfig;
	runner: TaskRunner;
	/** Attempts per task, for best@k. Default 1. */
	attempts?: number;
	/** Only tasks with these tags. */
	tags?: string[];
	/** Called after each task, for progress output. */
	onAttempt?: (result: AttemptResult) => void;
}

/** Runs every task in the suite and computes metrics. Failures are data, not crashes. */
export async function runSuite(options: RunSuiteOptions): Promise<RunRecord> {
	const startedAt = new Date().toISOString();
	const tasks = options.tags?.length
		? options.suite.tasks.filter((task) => task.tags?.some((tag) => options.tags?.includes(tag)))
		: options.suite.tasks;
	const attemptsPerTask = options.attempts ?? 1;
	const results: AttemptResult[] = [];
	for (const task of tasks) {
		for (let attempt = 1; attempt <= attemptsPerTask; attempt++) {
			try {
				const result = await options.runner(task, options.config, attempt);
				results.push(result);
				options.onAttempt?.(result);
			} catch (error) {
				const failure: AttemptResult = {
					taskId: task.id,
					finalState: "failed",
					holdoutPassed: false,
					costUsd: 0,
					wallClockMs: 0,
					tokens: 0,
					turns: 0,
					error: (error as Error).message,
				};
				results.push(failure);
				options.onAttempt?.(failure);
			}
		}
	}
	return {
		runId: `run_${Date.now().toString(36)}`,
		label: options.suite.name,
		startedAt,
		finishedAt: new Date().toISOString(),
		config: options.config,
		variant: "default",
		attempts: results,
		metrics: computeMetrics(results),
	};
}

/** Writes a run to the lab directory the way the meta-harness reads it back. */
export function saveRun(runsDir: string, run: RunRecord): string {
	const dir = join(runsDir, run.runId);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "run.json"), JSON.stringify(run, null, 2), "utf8");
	// One line per attempt keeps traces greppable.
	writeFileSync(
		join(dir, "attempts.jsonl"),
		`${run.attempts.map((attempt) => JSON.stringify(attempt)).join("\n")}\n`,
		"utf8",
	);
	return dir;
}

export function loadRun(dir: string): RunRecord | undefined {
	const path = join(dir, "run.json");
	return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as RunRecord) : undefined;
}

/** Every run under `runsDir`, newest first. */
export function listRuns(runsDir: string): RunRecord[] {
	if (!existsSync(runsDir)) return [];
	return readdirSync(runsDir)
		.map((name) => loadRun(join(runsDir, name)))
		.filter((run): run is RunRecord => run !== undefined)
		.sort((a, b) => b.finishedAt.localeCompare(a.finishedAt));
}

/** A short text report, for the CLI and for commit messages. */
export function reportRun(run: RunRecord): string {
	const m = run.metrics;
	const lines = [
		`${run.label} (${run.variant}) — ${m.solved}/${m.tasks} solved`,
		`pass@1 ${(m.passAt1 * 100).toFixed(1)}% · best@k ${(m.bestAtK * 100).toFixed(1)}% · false completion ${(m.falseCompletionRate * 100).toFixed(1)}%`,
		`cost/solved ${m.costPerSolved === undefined ? "n/a" : `$${m.costPerSolved.toFixed(2)}`} · ${(m.wallClockMs / 1000).toFixed(0)}s · ${m.tokens} tokens`,
	];
	const failures = run.attempts.filter((attempt) => attempt.error);
	if (failures.length > 0) lines.push(`errors: ${failures.length} (${failures[0].error})`);
	return lines.join("\n");
}
