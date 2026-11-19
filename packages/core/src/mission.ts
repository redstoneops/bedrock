// @bedrock/core: the Crafter. One mission, from scout to proof of work.
//
// The loop is small on purpose: scout, compile the gate, execute one worker at a
// time (widening only when the budget policy says so), verify, decide, prove.
// Every step emits an event and writes to the ledger; nothing depends on a
// model's self-report for the final state.

import { spawnSync } from "node:child_process";
import type { Ai } from "@bedrock/ai";
import type { ArtifactStore, EventLog } from "@bedrock/context";
import { compileGate, runGate, treeHash, validateAcceptanceChecks } from "@bedrock/gate";
import type {
	BudgetLimits,
	Gate,
	GateResult,
	Id,
	LedgerEntry,
	Mission,
	MissionPhase,
	ProofOfWork,
	RefineBrief,
	StrategyNode,
	StrategyTree,
} from "@bedrock/protocol";
import { createId } from "@bedrock/protocol";
import type { Sandbox } from "@bedrock/sandbox";
import type { LedgerSink } from "@bedrock/tools";
import { computeFinalState, defaultVerifiers, explainFinalState, verifyStack } from "@bedrock/verify";
import { DefaultBudgetPolicy, signalsFrom } from "./budget-policy.ts";
import { refineBriefText, workerBrief } from "./prompts.ts";
import { readContextFiles, scout } from "./scout.ts";
import { runWorker, type WorkerEvent } from "./worker.ts";

export interface MissionOptions {
	mission: Mission;
	ai: Ai;
	sandbox: Sandbox;
	artifacts: ArtifactStore;
	ledger: LedgerSink & {
		refineBrief(missionId: Id<"mission">, failing: Array<{ name: string; reason: string }>): RefineBrief;
	};
	eventLog?: EventLog;
	/** Called for every event the mission emits, for the TUI, JSONL mode and tests. */
	onEvent?: (event: { type: string; [key: string]: unknown }) => void;
	/** Ask the human; undefined for autonomous runs. */
	ask?: (question: string, options?: string[]) => Promise<string | undefined>;
	onPermission?: Parameters<typeof runWorker>[0]["onPermission"];
	/** Validate acceptance checks with a throwaway worktree (needs git). */
	validateAcceptance?: boolean;
	maxAttempts?: number;
	turnCap?: number;
	/** Called when the gate is compiled, so an interactive surface can edit it. */
	approveGate?: (gate: Gate) => Promise<Gate>;
}

export interface MissionResult {
	finalState: ProofOfWork["finalState"];
	proof: ProofOfWork;
	gate: Gate;
	results: GateResult[];
	turns: number;
}

function diffStat(workspace: string, baseCommit?: string): { files: number; additions: number; deletions: number } {
	const result = spawnSync("git", ["diff", "--numstat", baseCommit ?? "HEAD"], { cwd: workspace, encoding: "utf8" });
	if (result.status !== 0) return { files: 0, additions: 0, deletions: 0 };
	let files = 0;
	let additions = 0;
	let deletions = 0;
	for (const line of result.stdout.split("\n")) {
		const [added, removed] = line.split("\t");
		if (added === undefined) continue;
		files += 1;
		additions += Number(added) || 0;
		deletions += Number(removed) || 0;
	}
	const untracked = spawnSync("git", ["ls-files", "--others", "--exclude-standard"], {
		cwd: workspace,
		encoding: "utf8",
	});
	if (untracked.status === 0) files += untracked.stdout.split("\n").filter((line) => line.trim().length > 0).length;
	return { files, additions, deletions };
}

/** Runs one mission to a verified conclusion, or to an honest stop. */
export async function runMission(options: MissionOptions): Promise<MissionResult> {
	const { mission, ai, sandbox, artifacts, ledger } = options;
	const eventLog = options.eventLog;
	const startedAt = Date.now();
	const emit = (event: { type: string; [key: string]: unknown }) => {
		options.onEvent?.(event);
		eventLog?.append(event as never);
	};
	const phase = (next: MissionPhase) => {
		mission.phase = next;
		emit({ type: "mission_phase", missionId: mission.id, phase: next, at: new Date().toISOString() });
	};

	emit({
		type: "mission_start",
		missionId: mission.id,
		goal: mission.spec.goal,
		workspace: mission.workspace,
		at: mission.createdAt,
	});

	// 1. Scout.
	phase("scout");
	const report = scout({ workspace: mission.workspace, mission });
	emit({ type: "scout_report", missionId: mission.id, report, at: report.createdAt });

	// 2. Gate.
	phase("gate");
	const gate = compileGate(mission, report, { userCommands: mission.spec.gateCommands });
	if (options.validateAcceptance && report.vcs) {
		validateAcceptanceChecks(gate.checks, {
			workspace: mission.workspace,
			baseCommit: mission.baseCommit ?? report.vcs.commit,
		});
	}
	const approved = options.approveGate ? await options.approveGate(gate) : gate;
	approved.approved = approved.approved || !options.approveGate;
	emit({
		type: "gate_compiled",
		missionId: mission.id,
		gateId: approved.id,
		version: approved.version,
		checks: approved.checks.length,
		at: new Date().toISOString(),
	});

	// 3. Strategy: one root plus one branch per attempt. Distinctness comes from the
	// refine brief; a second attempt is never a copy of the first.
	phase("plan");
	const rootId = createId("strategy");
	const root: StrategyNode = {
		id: rootId,
		title: "mission root",
		hypothesis: mission.spec.goal,
		risks: [],
		status: "running",
		children: [],
	};
	const tree: StrategyTree = {
		id: rootId,
		missionId: mission.id,
		rootId,
		nodes: { [rootId]: root },
		createdAt: new Date().toISOString(),
		rationale: "sequential attempt first; widen only when the policy says diversity is the missing resource",
	};
	emit({ type: "strategy_tree", missionId: mission.id, tree, at: tree.createdAt });

	const results: GateResult[] = [];
	const policy = new DefaultBudgetPolicy({
		turnCap: options.turnCap ?? 120,
		maxParallelWorkers: mission.spec.budget.maxParallelWorkers ?? 4,
	});
	let lastPassed = false;
	policy.onAttemptResult(() => lastPassed);
	const maxAttempts = options.maxAttempts ?? 3;
	let turns = 0;
	let refine: RefineBrief | undefined;
	let costUsd = 0;
	const allUnverified: string[] = [];

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		phase("execute");
		const strategyId = createId("strategy");
		const node: StrategyNode = {
			id: strategyId,
			parentId: rootId,
			title: refine ? `attempt ${attempt}: refined` : `attempt ${attempt}: direct`,
			hypothesis: refine
				? "a distilled restart reaches the checks faster than extending a failed context"
				: "the goal is achievable with the repository's own checks as the target",
			risks: refine?.ruledOut.slice(0, 3) ?? [],
			status: "running",
			children: [],
		};
		root.children.push(strategyId);
		tree.nodes[strategyId] = node;
		emit({ type: "strategy_node", missionId: mission.id, node, at: new Date().toISOString() });

		const workerId = createId("worker");
		emit({ type: "worker_spawned", missionId: mission.id, workerId, at: new Date().toISOString() });

		const brief = workerBrief({
			mission,
			gate: approved,
			title: node.title,
			hypothesis: node.hypothesis,
			risks: node.risks,
		});
		const extra = [refine ? refineBriefText(refine) : "", readContextFiles(mission.workspace, report.contextFiles)]
			.filter((part) => part.length > 0)
			.join("\n\n");
		const workerResult = await runWorker({
			spec: {
				missionId: mission.id,
				strategyId,
				role: "worker",
				brief,
				workspace: mission.workspace,
				baseCommit: mission.baseCommit ?? report.vcs?.commit ?? "",
				turnCap: options.turnCap ?? 120,
				kernel: false,
			},
			mission,
			gate: approved,
			ai,
			workspace: mission.workspace,
			sandbox,
			artifacts,
			ledger,
			briefExtra: extra,
			ask: options.ask,
			onPermission: options.onPermission,
			onEvent: (event: WorkerEvent) => {
				if (event.type === "turn") turns += 1;
				emit({ type: "worker_event", missionId: mission.id, workerId, event, at: new Date().toISOString() });
			},
		});
		costUsd = ai.cost.usd;
		allUnverified.push(...workerResult.report.unverified);
		node.status = "failed";

		phase("verify");
		const candidate = {
			id: createId("entry"),
			missionId: mission.id,
			kind: "candidate" as const,
			author: "harness" as const,
			createdAt: new Date().toISOString(),
			workerId,
			strategyId,
			branch: "workspace",
			commit: report.vcs?.commit ?? "",
			treeHash: treeHash(mission.workspace),
			diffStat: diffStat(mission.workspace, mission.baseCommit ?? report.vcs?.commit),
			summary: workerResult.report.summary,
			gate: { passed: false } as GateResult,
			diff: undefined as string | undefined,
		};
		const stack = await verifyStack(candidate, approved, defaultVerifiers(ai), {
			workspace: mission.workspace,
			baseCommit: mission.baseCommit ?? report.vcs?.commit,
			artifacts,
			ai,
		});
		results.push(stack.result);
		lastPassed = stack.result.passed && stack.result.integrity.clean;
		emit({
			type: "verification",
			missionId: mission.id,
			workerId,
			result: stack.result,
			layers: stack.layers,
			at: new Date().toISOString(),
		});

		if (lastPassed) {
			node.status = "passed";
			break;
		}
		node.status = "failed";
		const failing = [...stack.result.visible, ...stack.result.holdout]
			.filter((run) => run.status !== "passed")
			.map((run) => ({ name: run.name, reason: run.failureReason ?? run.status }));
		refine = ledger.refineBrief(mission.id, failing);
		const decision = await policy.decide({
			mission,
			signals: signalsFrom({
				turns,
				turnsSinceNewFact: 0,
				gatePassRatio: stack.result.passRatio,
				costUsd,
				tokens: ai.cost.tokens,
				wallClockMs: Date.now() - startedAt,
				attempts: attempt,
				candidateCount: results.length,
				candidateDiversity: results.length > 1 ? 0.5 : 0,
			}),
			workers: [],
			limits: limitsOf(mission.spec.budget),
		});
		emit({ type: "budget_decision", missionId: mission.id, decision, at: new Date().toISOString() });
		if (decision.action === "stop") break;
		if (decision.action === "ask_human" && !options.ask) break;
		if (decision.action === "ask_human" && options.ask) {
			const answer = await options.ask(decision.question ?? "Continue?", ["continue", "stop"]);
			if (!answer || answer.startsWith("stop")) break;
		}
	}

	// 4. Proof of work.
	phase("reflect");
	const finalState = computeFinalState(results, {
		exhausted: !lastPassed && Date.now() - startedAt >= (mission.spec.budget.wallClockMs ?? Number.POSITIVE_INFINITY),
	});
	const best = results.reduce<GateResult | undefined>(
		(max, result) => (!max || result.passRatio > max.passRatio ? result : max),
		undefined,
	);
	const diff = diffStat(mission.workspace, mission.baseCommit ?? report.vcs?.commit);
	const proof: ProofOfWork = {
		missionId: mission.id,
		finalState,
		summary: explainFinalState(finalState, results),
		diffStat: diff,
		gate: best,
		evidence: [],
		unverified: [...new Set(allUnverified)],
		risks: [...(best?.integrity.suspicious.map((finding) => finding.detail) ?? [])],
		checkpoints: [],
		cost: { usd: ai.cost.usd, tokens: ai.cost.tokens, wallClockMs: Date.now() - startedAt },
		createdAt: new Date().toISOString(),
	};
	mission.finalState = finalState;
	mission.proof = proof;
	mission.status = "finished";
	mission.updatedAt = proof.createdAt;
	mission.finishedAt = proof.createdAt;
	phase("done");
	emit({ type: "mission_finish", missionId: mission.id, finalState, proof, at: proof.createdAt });

	return { finalState, proof, gate: approved, results, turns };
}

function limitsOf(budget: BudgetLimits): {
	usd?: number;
	tokens?: number;
	wallClockMs?: number;
	turns?: number;
	maxParallelWorkers: number;
} {
	return {
		usd: budget.usd,
		tokens: budget.tokens,
		wallClockMs: budget.wallClockMs,
		turns: budget.turns,
		maxParallelWorkers: budget.maxParallelWorkers ?? 4,
	};
}

/** Convenience: a minimal gate check appended by callers (evals, tests). */
export function appendCheck(gate: Gate, name: string, command: string): Gate {
	return {
		...gate,
		checks: [
			...gate.checks,
			{
				id: createId("check"),
				name,
				kind: "command",
				command,
				expect: { kind: "exit_code", code: 0 },
				origin: "acceptance",
				visibility: "visible",
			},
		],
	};
}

export type { LedgerEntry };
