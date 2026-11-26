// @bedrock/core: the Crafter. One mission, from scout to proof of work.
//
// scout -> gate -> rounds of 1..N workers -> verify each -> select -> apply.
// Each round's workers run distinct approaches in their own git worktrees,
// branched from a snapshot of the user's working tree, so the primary checkout
// is untouched until a verified winner exists. Between rounds the budget policy
// decides from harness-computed signals: refine, branch, widen, escalate, ask
// or stop. The final state comes from gate results, never from a model.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { Ai } from "@bedrock/ai";
import type { ArtifactStore, EventLog } from "@bedrock/context";
import { compileGate, treeHash, validateAcceptanceChecks } from "@bedrock/gate";
import {
	applyCandidate,
	commitAll,
	createWorktree,
	diffBetween,
	diffStatBetween,
	headCommit,
	isGitRepo,
	linkDependencyDirs,
	removeWorktree,
	snapshotCommit,
	type Worktree,
} from "@bedrock/isolation";
import { Kernel } from "@bedrock/kernel";
import { type Playbook, recordFailure, recordProgress, writeChest } from "@bedrock/memory";
import {
	type BedrockEvent,
	type BudgetPolicy,
	type CandidateView,
	createId,
	type Gate,
	type GateResult,
	type Id,
	type LedgerEntry,
	type LedgerSummary,
	type Mission,
	type MissionPhase,
	type ProofOfWork,
	type RefineBrief,
	type StrategyNode,
	type StrategyTree,
	type WorkerSpec,
} from "@bedrock/protocol";
import { Sandbox } from "@bedrock/sandbox";
import { describeToolCall, type EditTool, type LedgerSink } from "@bedrock/tools";
import {
	computeFinalState,
	defaultVerifiers,
	explainFinalState,
	TournamentSelection,
	verifyStack,
} from "@bedrock/verify";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { advise } from "./advisor.ts";
import { DefaultBudgetPolicy, overBudget, signalsFrom } from "./budget-policy.ts";
import type { MissionController } from "./controller.ts";
import { refineBriefText, workerBrief } from "./prompts.ts";
import { writeProof } from "./proof.ts";
import { reflect } from "./reflect.ts";
import { readContextFiles, scout } from "./scout.ts";
import { type Approach, planApproaches } from "./strategist.ts";
import { createChecksTool, createPythonTool } from "./tools.ts";
import { runWorker, type WorkerEvent, type WorkerOutcome } from "./worker.ts";

export type MissionLedger = LedgerSink & {
	refineBrief(missionId: Id<"mission">, failing: Array<{ name: string; reason: string }>): RefineBrief;
	summary?(missionId: Id<"mission">): LedgerSummary;
};

export interface MissionOptions {
	mission: Mission;
	ai: Ai;
	sandbox: Sandbox;
	artifacts: ArtifactStore;
	ledger: MissionLedger;
	eventLog?: EventLog;
	/** Every event the mission emits, for the TUI, JSONL mode and tests. */
	onEvent?: (event: BedrockEvent) => void;
	/** Ask the human; undefined for autonomous runs. */
	ask?: (question: string, options?: string[]) => Promise<string | undefined>;
	onPermission?: Parameters<typeof runWorker>[0]["onPermission"];
	/** Validate acceptance checks against the base tree in a throwaway worktree. */
	validateAcceptance?: boolean;
	/** Total worker budget across all rounds (default 3). */
	maxAttempts?: number;
	/** Per-worker turn cap (default 120). */
	turnCap?: number;
	/** Called when the gate is compiled, so an interactive surface can approve or edit it. */
	approveGate?: (gate: Gate) => Promise<Gate>;
	controller?: MissionController;
	/** Where the Chest and proof files go (`<workspace>/.bedrock` by default in the CLI). */
	stateDir?: string;
	/** Where worktrees go (default `~/.bedrock/worktrees/<repo>`). Kept outside the repo on purpose. */
	worktreeRoot?: string;
	/** `worktree` isolates every worker; `inplace` edits the workspace directly (no parallelism). */
	isolation?: "worktree" | "inplace";
	maxParallel?: number;
	/** Ask the strategist model for distinct approaches instead of fixed stances. */
	modelPlanning?: boolean;
	/** Explicit user-supplied guidance, separate from gate and verification rules. */
	workerGuidance?: string;
	/** Run the advisor model every few turns. */
	advisor?: boolean;
	/** Run the L4 red team (and pass diffs to L3) during verification. */
	redTeam?: boolean;
	/** Propose playbook lessons at the end. Needs `playbook`. */
	reflect?: boolean;
	playbook?: Playbook;
	/** Give workers the persistent Python kernel as a tool. */
	kernel?: boolean;
	contextBudgetTokens?: number;
	policy?: BudgetPolicy;
	/** Edit tools for workers (default hashline). */
	edits?: EditTool[];
}

export interface MissionResult {
	finalState: ProofOfWork["finalState"];
	proof: ProofOfWork;
	gate: Gate;
	results: GateResult[];
	candidates: CandidateView[];
	winner?: CandidateView;
	turns: number;
	proofPath?: string;
}

interface RoundWorker {
	approach: Approach;
	node: StrategyNode;
	workerId: Id<"worker">;
	workspace: string;
	worktree?: Worktree;
	outcome?: WorkerOutcome;
	kernel?: Kernel;
}

const MAX_DIFF_CHARS = 60_000;

/** Runs one mission to a verified conclusion, or to an honest stop. */
export async function runMission(options: MissionOptions): Promise<MissionResult> {
	const { mission, ai, artifacts, ledger, controller } = options;
	const startedAt = Date.now();
	const primary = mission.workspace;
	const emit = (event: BedrockEvent) => {
		options.onEvent?.(event);
		options.eventLog?.append(event);
	};
	const now = () => new Date().toISOString();
	const phase = (next: MissionPhase) => {
		mission.phase = next;
		emit({ type: "mission_phase", missionId: mission.id, phase: next, at: now() });
	};
	const notice = (text: string, level: "info" | "warning" | "error" = "info") =>
		emit({ type: "notice", missionId: mission.id, level, text, at: now() });
	const progress = (line: string) => {
		if (options.stateDir) recordProgress(options.stateDir, line);
	};
	const evidenceIds: Id<"entry">[] = [];
	const appendEntry = (entry: LedgerEntry) => {
		ledger.append(entry);
		if (entry.kind === "evidence") evidenceIds.push(entry.id);
		emit({ type: "ledger_entry", missionId: mission.id, entry, at: now() });
	};
	const emitSummary = () => {
		if (ledger.summary)
			emit({ type: "ledger_summary", missionId: mission.id, summary: ledger.summary(mission.id), at: now() });
	};

	emit({
		type: "mission_start",
		missionId: mission.id,
		goal: mission.spec.goal,
		workspace: primary,
		at: mission.createdAt,
	});

	// 1. Scout: cheap, deterministic, no model calls.
	phase("scout");
	const report = scout({ workspace: primary, mission });
	report.missionId = mission.id;
	emit({ type: "scout_report", missionId: mission.id, report, at: report.createdAt });

	// 2. Isolation base: a snapshot of the user's working tree, dirty changes included.
	const git = isGitRepo(primary);
	const useWorktrees =
		(options.isolation ?? (mission.spec.isolation === "worktree" ? "worktree" : "inplace")) === "worktree" && git;
	let base = mission.baseCommit ?? (git ? headCommit(primary) : undefined) ?? "";
	if (useWorktrees) {
		try {
			base = snapshotCommit(primary);
		} catch (error) {
			notice(
				`could not snapshot the working tree (${(error as Error).message}); workers branch from HEAD`,
				"warning",
			);
		}
	} else if (mission.spec.isolation === "worktree") {
		notice("not a git repository: workers edit the workspace in place, one at a time", "warning");
	}

	// 3. Gate: the definition of done, compiled before any solving.
	phase("gate");
	let gate = compileGate(mission, report, { userCommands: mission.spec.gateCommands });
	if (options.validateAcceptance && git && base)
		validateAcceptanceChecks(gate.checks, { workspace: primary, baseCommit: base });
	gate = options.approveGate ? await options.approveGate(gate) : { ...gate, approved: true, approvedBy: "policy" };
	emit({
		type: "gate_compiled",
		missionId: mission.id,
		gateId: gate.id,
		version: gate.version,
		checks: gate.checks.length,
		checkList: gate.checks.map((check) => ({
			name: check.name,
			command: check.visibility === "holdout" ? "(hidden)" : check.command,
			holdout: check.visibility === "holdout",
		})),
		at: now(),
	});
	if (gate.checks.length === 0)
		notice(
			"the gate has no checks: nothing can be verified, so the best possible outcome is UNVERIFIED. Pass --gate.",
			"warning",
		);

	// 4. Plan: one root; each round adds distinct approaches as children.
	phase("plan");
	const rootId = createId("strategy");
	const root: StrategyNode = {
		id: rootId,
		title: "mission",
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
		createdAt: now(),
		rationale:
			"start with one worker; widen to parallel, distinct approaches only when the budget policy says diversity is the missing resource",
	};
	emit({ type: "strategy_tree", missionId: mission.id, tree, at: tree.createdAt });
	if (options.stateDir) writeChest(options.stateDir, { mission, gate, strategy: tree });
	progress(`gate compiled with ${gate.checks.length} checks`);

	const workerModel = ai.resolve("worker").model;
	const contextBudget =
		options.contextBudgetTokens ??
		(workerModel.contextWindow ? Math.floor(workerModel.contextWindow * 0.6) : 120_000);
	const playbookNotes =
		options.playbook
			?.recall({ text: mission.spec.goal, limit: 6 })
			.map((entry) => `${entry.trigger}: ${entry.content}`) ?? [];
	const contextFiles = readContextFiles(primary, report.contextFiles);
	const policy =
		options.policy ??
		new DefaultBudgetPolicy({
			turnCap: options.turnCap ?? 120,
			maxParallelWorkers: options.maxParallel ?? mission.spec.budget.maxParallelWorkers ?? 4,
		});
	const maxWorkers = Math.max(1, options.maxAttempts ?? 3);
	const maxParallel = useWorktrees
		? Math.max(1, options.maxParallel ?? mission.spec.budget.maxParallelWorkers ?? 4)
		: 1;
	const worktreeRoot =
		options.worktreeRoot ??
		join(
			homedir(),
			".bedrock",
			"worktrees",
			`${basename(primary)}-${createHash("sha1").update(primary).digest("hex").slice(0, 8)}`,
		);

	const results: GateResult[] = [];
	const candidates: CandidateView[] = [];
	const briefs: RefineBrief[] = [];
	const summaries: string[] = [];
	const unverifiedByWorker = new Map<string, string[]>();
	const allWorktrees: Array<{ worktree: Worktree; candidate?: CandidateView }> = [];
	let winner: CandidateView | undefined;
	let refine: RefineBrief | undefined;
	let parallelism = 1;
	let workersUsed = 0;
	let turns = 0;
	let round = 0;
	let bestPrevious = 0;
	let exhausted = false;
	let appliedRisk: string | undefined;

	while (!winner && workersUsed < maxWorkers && !controller?.cancelled) {
		round += 1;
		const count = Math.max(1, Math.min(parallelism, maxWorkers - workersUsed, maxParallel));
		phase("execute");
		const plan = await planApproaches({
			ai: options.modelPlanning ? ai : undefined,
			mission,
			gate,
			scout: report,
			count,
			round,
			brief: refine,
		});

		const workers: RoundWorker[] = plan.approaches.map((approach, index) => {
			const node: StrategyNode = {
				id: createId("strategy"),
				parentId: rootId,
				title: `${round}.${index + 1} ${approach.title}`,
				hypothesis: approach.hypothesis,
				risks: approach.risks,
				status: "running",
				children: [],
			};
			root.children.push(node.id);
			tree.nodes[node.id] = node;
			emit({ type: "strategy_node", missionId: mission.id, node, at: now() });
			let workspace = primary;
			let worktree: Worktree | undefined;
			if (useWorktrees) {
				worktree = createWorktree({
					repo: primary,
					root: worktreeRoot,
					label: `${mission.id.slice(4, 12)}-r${round}-w${index + 1}`,
					base,
				});
				linkDependencyDirs(primary, worktree.path);
				workspace = worktree.path;
				allWorktrees.push({ worktree });
			}
			return { approach, node, workerId: createId("worker"), workspace, worktree };
		});

		const outcomes = await Promise.all(
			workers.map(async (worker) => {
				const sandbox =
					worker.workspace === primary
						? options.sandbox
						: new Sandbox({
								...options.sandbox.config,
								workspace: worker.workspace,
								hostWorkspace: worker.workspace,
							});
				const spec: WorkerSpec = {
					missionId: mission.id,
					strategyId: worker.node.id,
					role: "worker",
					brief: workerBrief({
						mission,
						gate,
						title: worker.approach.title,
						hypothesis: worker.approach.hypothesis,
						risks: worker.approach.risks,
					}),
					workspace: worker.workspace,
					branch: worker.worktree?.branch,
					baseCommit: base,
					turnCap: options.turnCap ?? 120,
					kernel: options.kernel ?? false,
				};
				emit({ type: "worker_spawned", missionId: mission.id, workerId: worker.workerId, spec, at: now() });
				emit({
					type: "worker_status",
					missionId: mission.id,
					workerId: worker.workerId,
					status: "running",
					at: now(),
				});
				const extraTools: AgentTool[] = [
					createChecksTool({
						gate,
						workspace: worker.workspace,
						missionId: mission.id,
						ledger,
						artifacts,
						baseCommit: base,
						onEvidence: (entry) => {
							evidenceIds.push(entry.id);
							emit({ type: "ledger_entry", missionId: mission.id, entry, at: now() });
						},
					}) as AgentTool,
				];
				if (options.kernel) {
					worker.kernel = new Kernel({
						workspace: worker.workspace,
						stateDir: options.stateDir ? join(options.stateDir, "kernel", worker.workerId) : undefined,
					});
					extraTools.push(createPythonTool(worker.kernel) as AgentTool);
				}
				const pendingArgs = new Map<string, unknown>();
				const outcome = await runWorker({
					spec,
					workerId: worker.workerId,
					mission,
					gate,
					ai,
					workspace: worker.workspace,
					sandbox,
					artifacts,
					ledger,
					briefExtra: [
						refine ? refineBriefText(refine) : "",
						contextFiles ? `## Repository instructions\n${contextFiles}` : "",
						options.workerGuidance ?? "",
					]
						.filter((part) => part.length > 0)
						.join("\n\n"),
					systemNotes: playbookNotes,
					extraTools,
					ask: options.ask,
					onPermission: options.onPermission,
					controller,
					contextBudgetTokens: contextBudget,
					edits: options.edits,
					advise: options.advisor
						? (messages) => advise({ ai, goal: mission.spec.goal, gate, messages })
						: undefined,
					shouldStop: (stats) => {
						if (
							overBudget({
								mission,
								signals: signalsFrom({
									turns: 0,
									turnsSinceNewFact: 0,
									gatePassRatio: 0,
									costUsd: ai.cost.usd,
									tokens: ai.cost.tokens,
									wallClockMs: Date.now() - startedAt,
									attempts: 0,
								}),
								workers: [],
								limits: { ...mission.spec.budget, turns: undefined, maxParallelWorkers: maxParallel },
							})
						) {
							return "the mission budget is exhausted";
						}
						if (stats.turns >= 12 && stats.turnsSinceNewFact >= 15)
							return `${stats.turnsSinceNewFact} turns without progress (no edit, check run or new fact)`;
						if (stats.toolCalls >= 10 && stats.repeatedActionRatio >= 0.5)
							return "the worker is repeating the same tool calls";
						return undefined;
					},
					onLedgerEntry: (entry) => emit({ type: "ledger_entry", missionId: mission.id, entry, at: now() }),
					onEvent: (event) => {
						if (event.type === "tool_start") pendingArgs.set(event.toolCallId, event.args);
						if (event.type === "turn") turns += 1;
						forwardWorkerEvent(event, worker.workerId, pendingArgs, emit, mission.id);
						if (event.type === "tool_end" && event.name === "bash") {
							const args = pendingArgs.get(event.toolCallId) as { command?: string } | undefined;
							const details = event.details as { exitCode?: number; durationMs?: number } | undefined;
							appendEntry({
								id: createId("entry"),
								missionId: mission.id,
								kind: "evidence",
								author: "harness",
								createdAt: now(),
								command: args?.command,
								exitCode: details?.exitCode,
								durationMs: details?.durationMs,
								outputHash: createHash("sha256").update(event.head).digest("hex"),
								summary: event.head.split("\n").slice(0, 2).join(" ").slice(0, 200) || "(no output)",
								tags: ["bash"],
							});
						}
					},
				});
				await worker.kernel?.stop();
				worker.outcome = outcome;
				unverifiedByWorker.set(worker.workerId, outcome.report.unverified);
				return outcome;
			}),
		);
		workersUsed += workers.length;
		for (const outcome of outcomes) summaries.push(outcome.report.summary);
		if (controller?.cancelled) break;

		// 5. Verify each candidate in its own tree, sequentially (suites share ports and caches).
		phase("verify");
		const roundCandidates: CandidateView[] = [];
		for (const worker of workers) {
			const commit = worker.worktree
				? commitAll(worker.worktree.path, `bedrock candidate ${worker.workerId}: ${worker.approach.title}`)
				: (headCommit(primary) ?? "");
			const diff = worker.worktree ? diffBetween(primary, base, commit) : workingTreeDiff(primary, base);
			const candidate: CandidateView = {
				id: createId("entry"),
				missionId: mission.id,
				kind: "candidate",
				author: "harness",
				createdAt: now(),
				workerId: worker.workerId,
				branch: worker.worktree?.branch ?? "workspace",
				commit,
				treeHash: treeHash(worker.workspace),
				diffStat: worker.worktree ? diffStatBetween(primary, base, commit) : diffStatOf(diff),
				summary: worker.outcome?.report.summary ?? "",
				diff: diff.length > MAX_DIFF_CHARS ? `${diff.slice(0, MAX_DIFF_CHARS)}\n... [diff truncated] ...` : diff,
				gate: placeholderResult(gate),
			};
			const stack = await verifyStack(candidate, gate, defaultVerifiers(options.redTeam ? ai : undefined), {
				workspace: worker.workspace,
				baseCommit: base || undefined,
				artifacts,
				ai,
				signal: controller?.signal,
			});
			candidate.gate = stack.result;
			candidate.rubricScore = stack.result.rubricScore;
			roundCandidates.push(candidate);
			candidates.push(candidate);
			results.push(stack.result);
			const entry = allWorktrees.find((item) => item.worktree === worker.worktree);
			if (entry) entry.candidate = candidate;
			const passed = stack.result.passed && stack.result.integrity.clean;
			worker.node.status = passed ? "passed" : "failed";
			emit({ type: "strategy_node", missionId: mission.id, node: worker.node, at: now() });
			emit({
				type: "verification",
				missionId: mission.id,
				workerId: worker.workerId,
				level: 2,
				result: stack.result,
				at: now(),
			});
			for (const suspicion of stack.result.integrity.suspicious)
				emit({ type: "suspicion", missionId: mission.id, workerId: worker.workerId, suspicion, at: now() });
			emit({
				type: "worker_status",
				missionId: mission.id,
				workerId: worker.workerId,
				status: passed ? "passed" : "failed",
				at: now(),
			});
			appendEntry({
				id: createId("entry"),
				missionId: mission.id,
				kind: "evidence",
				author: "verifier",
				createdAt: now(),
				command: "gate (visible + holdout)",
				exitCode: passed ? 0 : 1,
				treeHash: stack.result.treeHash,
				summary: `${worker.approach.title}: ${Math.round(stack.result.passRatio * 100)}% of checks passed${stack.result.integrity.clean ? "" : ", integrity findings"}`,
				tags: ["verification"],
			});
		}
		emitSummary();

		// 6. Select among passing candidates.
		const passing = roundCandidates.filter((candidate) => candidate.gate.passed && candidate.gate.integrity.clean);
		if (passing.length > 0) {
			phase("select");
			const selection = await new TournamentSelection(
				passing.length > 1 && options.modelPlanning ? ai : undefined,
			).select(passing, gate);
			winner = selection.winner;
			if (passing.length > 1)
				notice(`selected ${winner?.branch ?? "a candidate"} of ${passing.length} passing: ${selection.rationale}`);
			break;
		}

		// 7. Decide what to buy next.
		const best = roundCandidates.reduce((max, candidate) => Math.max(max, candidate.gate.passRatio), 0);
		const bestCandidate =
			roundCandidates.find((candidate) => candidate.gate.passRatio === best) ?? roundCandidates[0];
		const failing = bestCandidate
			? [
					...bestCandidate.gate.visible,
					...bestCandidate.gate.holdout.map((run) => ({ ...run, name: "a holdout check" })),
				]
					.filter((run) => run.status !== "passed")
					.map((run) => ({ name: run.name, reason: run.failureReason ?? run.status }))
			: [];
		phase("refine");
		refine = ledger.refineBrief(mission.id, failing);
		refine.ruledOut.push(
			...workers.map(
				(worker) => `approach "${worker.approach.title}" (${worker.outcome?.report.summary ?? "no report"})`,
			),
		);
		briefs.push(refine);
		if (options.stateDir) recordFailure(options.stateDir, refine);
		progress(`round ${round}: ${workers.length} worker(s), best ${Math.round(best * 100)}% of checks`);
		const diffHashes = new Set(
			roundCandidates.map((candidate) =>
				createHash("sha1")
					.update(candidate.diff ?? "")
					.digest("hex"),
			),
		);
		const snapshot = {
			mission,
			signals: signalsFrom({
				turns,
				turnsSinceNewFact: Math.min(...outcomes.map((outcome) => outcome.stats.turnsSinceNewFact)),
				gatePassRatio: best,
				gateTrend: best - bestPrevious,
				verifierDisagreement:
					roundCandidates.filter((candidate) => candidate.gate.passed && !candidate.gate.integrity.clean).length /
					roundCandidates.length,
				repeatedActionRatio: Math.max(...outcomes.map((outcome) => outcome.stats.repeatedActionRatio)),
				candidateCount: roundCandidates.length,
				candidateDiversity: roundCandidates.length > 1 ? diffHashes.size / roundCandidates.length : 1,
				blockerCount: outcomes.reduce((sum, outcome) => sum + outcome.stats.blockers, 0),
				costUsd: ai.cost.usd,
				tokens: ai.cost.tokens,
				wallClockMs: Date.now() - startedAt,
				attempts: workersUsed,
			}),
			workers: [],
			limits: { ...mission.spec.budget, maxParallelWorkers: maxParallel },
		};
		bestPrevious = Math.max(bestPrevious, best);
		const decision = await policy.decide(snapshot);
		emit({
			type: "budget_decision",
			missionId: mission.id,
			decision: {
				id: createId("entry"),
				action: decision.action,
				reason: decision.reason,
				signals: { ...snapshot.signals },
				createdAt: now(),
			},
			at: now(),
		});
		if (decision.action === "stop") {
			exhausted = overBudget(snapshot);
			break;
		}
		if (decision.action === "ask_human") {
			const answer = options.ask
				? await options.ask(decision.question ?? "Continue?", ["continue", "stop"])
				: undefined;
			if (!answer || answer.toLowerCase().startsWith("stop")) break;
		}
		if (decision.action === "widen")
			parallelism = Math.max(1, Math.min(maxParallel, decision.parallelism ?? parallelism + 1));
		if (decision.action === "escalate") notice(`escalated worker effort to ${ai.escalateEffort("worker")}`);
	}

	// 8. Apply the verified winner to the user's working tree.
	if (winner && useWorktrees) {
		const applied = applyCandidate(primary, base, winner.commit);
		if (applied.ok) {
			notice(`applied the verified candidate to the workspace (${applied.files.length} files, ${applied.detail})`);
			const same =
				spawnSync("git", ["diff", "--quiet", winner.commit, "--", ...applied.files], { cwd: primary }).status === 0;
			appendEntry({
				id: createId("entry"),
				missionId: mission.id,
				kind: "evidence",
				author: "harness",
				createdAt: now(),
				command: `git diff --quiet ${winner.commit.slice(0, 12)} -- <changed files>`,
				exitCode: same ? 0 : 1,
				summary: same
					? "the workspace matches the verified candidate for every changed file"
					: "the workspace differs from the verified candidate after applying",
				tags: ["apply"],
			});
			if (!same) appliedRisk = "the applied workspace differs from the verified candidate; re-run the gate";
		} else {
			appliedRisk = `the verified result is on branch ${winner.branch}; applying it to your working tree failed: ${applied.detail}`;
			notice(appliedRisk, "error");
		}
	}

	// 9. Clean up worktrees. Keep the winner's branch when it could not be applied,
	// and the best failed candidate's branch so a human can inspect it.
	const bestFailed = !winner
		? candidates.reduce<CandidateView | undefined>(
				(max, candidate) => (!max || candidate.gate.passRatio > max.gate.passRatio ? candidate : max),
				undefined,
			)
		: undefined;
	const kept: Array<{ label: string; commit: string }> = [];
	for (const { worktree, candidate } of allWorktrees) {
		const keep =
			(candidate && candidate === bestFailed && candidate.diffStat.files > 0) ||
			(candidate === winner && appliedRisk !== undefined);
		removeWorktree(worktree, true, keep);
		if (keep && candidate) kept.push({ label: worktree.branch, commit: candidate.commit });
	}

	// 10. Reflect, then prove.
	phase("reflect");
	const finalState = computeFinalState(winner ? [winner.gate] : results, {
		cancelled: controller?.cancelled,
		exhausted: exhausted && !winner,
	});
	if (options.reflect && options.playbook && !controller?.cancelled) {
		const deltas = await reflect({
			ai,
			goal: mission.spec.goal,
			finalState,
			scope: basename(primary),
			missionId: mission.id,
			briefs,
			workerSummaries: summaries,
		});
		options.playbook.applyAll(deltas);
		if (deltas.length > 0) notice(`playbook: ${deltas.length} lesson(s) recorded for future missions`);
	}
	const shown =
		winner?.gate ??
		results.reduce<GateResult | undefined>(
			(max, result) => (!max || result.passRatio > max.passRatio ? result : max),
			undefined,
		);
	const proof: ProofOfWork = {
		missionId: mission.id,
		finalState,
		summary: explainFinalState(finalState, winner ? [winner.gate] : results),
		diffStat: winner?.diffStat ?? { files: 0, additions: 0, deletions: 0 },
		gate: shown,
		evidence: [...evidenceIds].reverse(),
		unverified: [
			...new Set(winner ? (unverifiedByWorker.get(winner.workerId) ?? []) : [...unverifiedByWorker.values()].flat()),
		],
		risks: [
			...(shown?.integrity.suspicious.map((finding) => finding.detail) ?? []),
			...(appliedRisk ? [appliedRisk] : []),
			...(gate.checks.length === 0 ? ["no checks were run"] : []),
			...(gate.checks.every((check) => check.visibility === "visible")
				? ["no holdout checks: the pass rests on checks the worker could see"]
				: []),
		],
		checkpoints: kept,
		cost: { usd: ai.cost.usd, tokens: ai.cost.tokens, wallClockMs: Date.now() - startedAt },
		createdAt: now(),
	};
	mission.finalState = finalState;
	mission.proof = proof;
	mission.status = "finished";
	mission.updatedAt = proof.createdAt;
	mission.finishedAt = proof.createdAt;
	const proofPath = options.stateDir ? writeProof(options.stateDir, proof, mission.spec.goal) : undefined;
	progress(`finished: ${finalState}`);
	phase("done");
	emit({ type: "mission_finish", missionId: mission.id, finalState, proof, at: proof.createdAt });
	return { finalState, proof, gate, results, candidates, winner, turns, proofPath };
}

/** Maps worker events onto the protocol stream every surface understands. */
export function forwardWorkerEvent(
	event: WorkerEvent,
	workerId: Id<"worker">,
	args: Map<string, unknown>,
	emit: (event: BedrockEvent) => void,
	missionId: Id<"mission">,
): void {
	const at = new Date().toISOString();
	switch (event.type) {
		case "turn":
			emit({ type: "worker_turn", missionId, workerId, turn: event.turn, at });
			break;
		case "text":
			emit({ type: "assistant_delta", missionId, workerId, text: event.text, append: !event.start, at });
			break;
		case "tool_start":
			emit({
				type: "tool_call",
				missionId,
				at,
				card: {
					toolCallId: event.toolCallId,
					workerId,
					name: event.name,
					args: (event.args ?? {}) as Record<string, unknown>,
					label: describeToolCall(event.name, event.args),
					status: "running",
					startedAt: at,
				},
			});
			break;
		case "tool_end": {
			const details = (event.details ?? {}) as { exitCode?: number; additions?: number; deletions?: number };
			const callArgs = args.get(event.toolCallId);
			emit({
				type: "tool_call",
				missionId,
				at,
				card: {
					toolCallId: event.toolCallId,
					workerId,
					name: event.name,
					args: (callArgs ?? {}) as Record<string, unknown>,
					label: describeToolCall(event.name, callArgs),
					status: event.ok ? "ok" : "error",
					startedAt: at,
					finishedAt: at,
					durationMs: event.durationMs,
					exitCode: details.exitCode,
					diffStat:
						details.additions !== undefined
							? { additions: details.additions, deletions: details.deletions ?? 0 }
							: undefined,
					head: event.head,
				},
			});
			break;
		}
		case "advisor":
			emit({
				type: "advisor_note",
				missionId,
				at,
				note: { id: createId("entry"), workerId, tag: event.tag, text: event.text, createdAt: at },
			});
			break;
		case "stopped":
			emit({ type: "notice", missionId, level: "warning", text: `worker stopped early: ${event.reason}`, at });
			break;
		case "error":
			emit({ type: "notice", missionId, level: "error", text: event.message, at });
			break;
		default:
			break;
	}
}

function workingTreeDiff(workspace: string, base: string): string {
	if (!base) return "";
	const result = spawnSync("git", ["diff", base], { cwd: workspace, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
	return result.status === 0 ? result.stdout : "";
}

function diffStatOf(diff: string): { files: number; additions: number; deletions: number } {
	let files = 0;
	let additions = 0;
	let deletions = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("diff --git")) files += 1;
		else if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
		else if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
	}
	return { files, additions, deletions };
}

function placeholderResult(gate: Gate): GateResult {
	return {
		gateId: gate.id,
		gateVersion: gate.version,
		treeHash: "",
		startedAt: "",
		finishedAt: "",
		visible: [],
		holdout: [],
		invariantViolations: [],
		integrity: { changedPaths: [], protectedTouched: [], unjustified: [], suspicious: [], clean: true },
		passed: false,
		passRatio: 0,
	};
}

/** Convenience: a gate check appended by callers (evals, tests). */
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
