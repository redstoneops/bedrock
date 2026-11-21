// @bedrock/lab: running a benchmark task as a real mission, then judging it independently.
//
// The mission never sees the task's holdout commands. After it ends, the
// evaluator runs them itself on the final workspace. A mission that reports
// PASSED while the holdout fails is a false completion, the metric Bedrock
// exists to drive toward zero.

import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Ai } from "@bedrock/ai";
import { ArtifactStore } from "@bedrock/context";
import { runMission } from "@bedrock/core";
import { Ledger } from "@bedrock/ledger";
import { type BedrockConfig, createId, type Mission } from "@bedrock/protocol";
import { Sandbox } from "@bedrock/sandbox";
import type { AttemptResult, BenchTask, TaskRunner } from "./bench.ts";

export interface MissionRunnerOptions {
	/** A fresh Ai per attempt, so costs are attributed per task. */
	makeAi: (config: BedrockConfig) => Ai;
	/** Keep task workspaces for inspection instead of deleting them. */
	keep?: boolean;
	maxAttempts?: number;
	turnCap?: number;
	/** Called with each mission event, for progress output. */
	onEvent?: Parameters<typeof runMission>[0]["onEvent"];
}

/** Runs the evaluator's holdout commands; true only when every one exits 0. */
export function runHoldout(workspace: string, commands: string[]): boolean {
	return commands.every(
		(command) =>
			spawnSync("bash", ["-lc", command], { cwd: workspace, timeout: 600_000, stdio: "ignore" }).status === 0,
	);
}

/** A TaskRunner that executes local-fixture tasks as full missions. */
export function createMissionRunner(options: MissionRunnerOptions): TaskRunner {
	return async (task: BenchTask, config: BedrockConfig): Promise<AttemptResult> => {
		if (task.source?.kind === "terminal-bench") {
			throw new Error(
				`${task.id}: Terminal-Bench tasks run inside their Docker image; use the container isolation mode`,
			);
		}
		const workspace = mkdtempSync(join(tmpdir(), `bedrock-lab-${task.id}-`));
		const worktrees = mkdtempSync(join(tmpdir(), "bedrock-lab-wt-"));
		const ledger = new Ledger({ path: ":memory:" });
		try {
			if (task.fixture) cpSync(task.fixture, workspace, { recursive: true });
			if (task.setup) execFileSync("bash", ["-lc", task.setup], { cwd: workspace, stdio: "ignore" });
			for (const args of [
				["init", "-q"],
				["add", "-A"],
				["-c", "user.email=lab@bedrock", "-c", "user.name=lab", "commit", "-qm", "task", "--allow-empty"],
			]) {
				execFileSync("git", args, { cwd: workspace });
			}
			const ai = options.makeAi(config);
			const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: workspace, encoding: "utf8" }).trim();
			const mission: Mission = {
				id: createId("mission"),
				spec: {
					goal: task.goal,
					mode: "run",
					budget: { ...config.budget, usd: task.maxUsd ?? config.budget.usd },
					isolation: "worktree",
					gateCommands: task.gate,
				},
				status: "running",
				phase: "bootstrap",
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				workspace,
				baseTree: head,
				baseCommit: head,
			};
			const started = Date.now();
			const result = await runMission({
				mission,
				ai,
				sandbox: new Sandbox({ workspace, preset: "yolo", autonomous: true }),
				artifacts: new ArtifactStore({ kind: "memory" }),
				ledger,
				worktreeRoot: worktrees,
				maxAttempts: options.maxAttempts ?? 3,
				maxParallel: config.loop.maxParallelWorkers,
				turnCap: options.turnCap ?? config.loop.workerTurnCap,
				onEvent: options.onEvent,
			});
			return {
				taskId: task.id,
				finalState: result.finalState,
				holdoutPassed: runHoldout(workspace, task.holdout ?? task.gate),
				costUsd: result.proof.cost.usd,
				wallClockMs: Date.now() - started,
				tokens: result.proof.cost.tokens,
				turns: result.turns,
				gate: result.winner?.gate ?? result.results.at(-1),
			};
		} finally {
			ledger.close();
			rmSync(worktrees, { recursive: true, force: true });
			if (!options.keep) rmSync(workspace, { recursive: true, force: true });
		}
	};
}
