// @bedrock/cli: the bedrock command.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { Ai } from "@bedrock/ai";
import { MissionController, QuickSession, runMission, scout } from "@bedrock/core";
import { recoverSessions } from "@bedrock/daemon";
import { compileGate, describeResult, runGate } from "@bedrock/gate";
import {
	createMissionRunner,
	listRuns,
	loadSuite,
	loadTerminalBenchTasks,
	reportRun,
	runSuite,
	saveRun,
} from "@bedrock/lab";
import { defaultPlaybookPath, Playbook } from "@bedrock/memory";
import type {
	BedrockConfig,
	BedrockEvent,
	Mission,
	PermissionDecision,
	PermissionRequest,
	Role,
} from "@bedrock/protocol";
import { shortId } from "@bedrock/protocol";
import { MissionApp } from "@bedrock/tui";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { applyOverrides, loadConfig } from "./config.ts";
import { createRuntime, hasProviderCredentials, isInteractive, type Runtime, readLine } from "./runtime.ts";

const VERSION = "0.1.0";

const HELP = `bedrock — agents that stand on verified ground

Usage:
  bedrock                                  Mission Control (TUI): type a goal, watch it get verified
  bedrock run --goal "..." [--gate "cmd"]  autonomous mission (TUI on a terminal, prose/JSONL otherwise)
  bedrock quick [prompt...]                plain agent loop, no gate (chat TUI on a terminal)
  bedrock scout                            print the scout report for this repo
  bedrock gate [--gate "cmd"]              compile and run the gate once, no agent
  bedrock models [query]                   list models from the pi catalog
  bedrock sessions                         list recorded sessions and which were interrupted
  bedrock proof [mission-id]               print the latest (or a given) proof of work
  bedrock lab run [suite.json] [--attempts k] [--tags a,b]
                                           run a benchmark suite with an independent holdout evaluator
  bedrock lab runs                         list recorded lab runs
  bedrock lab tb <tasks-dir>               list Terminal-Bench tasks as Bedrock tasks
  bedrock --version | --help

Options:
  --goal <text>        the mission goal (run)
  --gate <cmd>         a gate command; repeatable, always included, never weakened
  --model <ref>        model for the worker role (provider/model); --role targets another role
  --max-usd <n>        budget in dollars
  --max-attempts <n>   total workers across all rounds (default 3)
  --parallel <n>       maximum parallel workers per round (default from config, 4)
  --turns <n>          per-worker turn cap (default 120)
  --permissions <p>    yolo | standard | strict
  --isolation <i>      worktree | copy | container
  --[no-]advisor       advisor model notes every few turns (default from config)
  --[no-]red-team      adversarial L4 review of passing candidates (default from config)
  --kernel             give workers a persistent Python kernel
  --no-tui             plain output even on a terminal
  --json               JSONL event stream (implies --no-tui)
  --yes                approve the compiled gate without asking

State lives in <workspace>/.bedrock: SQLite ledger, JSONL session logs, artifacts,
audit log, the Chest (recipe/plan/progress/failures) and proof.md per mission.
Workers run in git worktrees under ~/.bedrock/worktrees; your checkout changes only
when a verified candidate is applied.`;

interface Cli {
	command: string;
	positionals: string[];
	values: Record<string, string | string[] | boolean | undefined>;
}

function parseCli(): Cli {
	const { values, positionals } = parseArgs({
		allowPositionals: true,
		allowNegative: true,
		options: {
			goal: { type: "string" },
			gate: { type: "string", multiple: true },
			model: { type: "string" },
			role: { type: "string" },
			"max-usd": { type: "string" },
			"max-attempts": { type: "string" },
			turns: { type: "string" },
			parallel: { type: "string" },
			permissions: { type: "string" },
			isolation: { type: "string" },
			advisor: { type: "boolean" },
			"red-team": { type: "boolean" },
			kernel: { type: "boolean" },
			attempts: { type: "string" },
			tags: { type: "string" },
			tui: { type: "boolean" },
			json: { type: "boolean" },
			yes: { type: "boolean" },
			help: { type: "boolean", short: "h" },
			version: { type: "boolean", short: "v" },
		},
	});
	return { command: positionals[0] ?? "", positionals: positionals.slice(1), values };
}

const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const list = (value: unknown): string[] | undefined => (Array.isArray(value) ? value.map(String) : undefined);

function number(value: unknown): number | undefined {
	if (value === undefined) return undefined;
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed < 0)
		throw new Error(`expected a non-negative number, got "${String(value)}"`);
	return parsed;
}

function wantsTui(cli: Cli): boolean {
	return isInteractive() && cli.values.json !== true && cli.values.tui !== false;
}

/** Prints an event as one JSON line, for `--json` and CI. */
function jsonEmitter(): (event: BedrockEvent) => void {
	return (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
}

/** Human-readable stream of mission events, for pipes and logs. */
function proseEmitter(): (event: BedrockEvent) => void {
	return (event) => {
		switch (event.type) {
			case "mission_phase":
				process.stdout.write(`\n[${event.phase}]\n`);
				break;
			case "gate_compiled":
				process.stdout.write(`gate: ${event.checks} checks\n`);
				break;
			case "assistant_delta":
				process.stdout.write(event.text);
				break;
			case "tool_call":
				if (event.card.status !== "running")
					process.stdout.write(`\n  ${event.card.status === "ok" ? "✓" : "✗"} ${event.card.label}\n`);
				break;
			case "advisor_note":
				process.stdout.write(`\n  advisor ${event.note.tag}: ${event.note.text}\n`);
				break;
			case "verification":
				process.stdout.write(`\n${describeResult(event.result)}\n`);
				break;
			case "budget_decision":
				process.stdout.write(`\nbudget: ${event.decision.action} (${event.decision.reason})\n`);
				break;
			case "notice":
				process.stdout.write(`\n${event.level === "info" ? "" : `${event.level}: `}${event.text}\n`);
				break;
			case "mission_finish":
				process.stdout.write(`\n== ${event.finalState.toUpperCase()} ==\n${event.proof.summary}\n`);
				break;
		}
	};
}

async function main(): Promise<number> {
	let cli: Cli;
	try {
		cli = parseCli();
	} catch (error) {
		process.stderr.write(`${(error as Error).message}\n\n${HELP}\n`);
		return 2;
	}
	if (cli.values.version) {
		process.stdout.write(`bedrock ${VERSION}\n`);
		return 0;
	}
	if (cli.values.help || (cli.command === "" && !isInteractive())) {
		process.stdout.write(`${HELP}\n`);
		return 0;
	}

	const workspace = process.cwd();
	const loaded = loadConfig(workspace);
	const config = applyOverrides(loaded.config, {
		model: str(cli.values.model),
		role: str(cli.values.role) as Role | undefined,
		maxUsd: number(cli.values["max-usd"]),
		permissions: str(cli.values.permissions),
		isolation: str(cli.values.isolation),
		parallel: number(cli.values.parallel),
	});
	if (typeof cli.values.advisor === "boolean") config.loop.advisor = cli.values.advisor;
	if (typeof cli.values["red-team"] === "boolean") config.loop.redTeam = cli.values["red-team"];
	if (cli.values.kernel === true) config.loop.kernel = true;
	for (const warning of loaded.warnings) process.stderr.write(`config: ${warning}\n`);

	switch (cli.command) {
		case "":
			return missionMode(cli, config, workspace, undefined);
		case "run": {
			const goal = str(cli.values.goal) ?? cli.positionals.join(" ");
			if (goal.trim().length === 0) {
				process.stderr.write('run mode needs --goal "..."\n');
				return 2;
			}
			return missionMode(cli, config, workspace, goal);
		}
		case "quick":
			return quickMode(cli, config, workspace);
		case "scout":
			process.stdout.write(`${JSON.stringify(scout({ workspace }), null, 2)}\n`);
			return 0;
		case "gate":
			return gateMode(cli, config, workspace);
		case "models":
			return modelsMode(cli);
		case "sessions":
			return sessionsMode(config);
		case "proof":
			return proofMode(cli, config);
		case "lab":
			return labMode(cli, config, workspace);
		default:
			process.stderr.write(`unknown command "${cli.command}"\n\n${HELP}\n`);
			return 2;
	}
}

function requireCredentials(): boolean {
	if (hasProviderCredentials()) return true;
	process.stderr.write(
		"no provider credentials found. Set an API key (for example ANTHROPIC_API_KEY or OPENAI_API_KEY), then retry.\n",
	);
	return false;
}

function newMission(
	runtime: Runtime,
	config: BedrockConfig,
	workspace: string,
	goal: string,
	gateCommands?: string[],
): Mission {
	const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: workspace, encoding: "utf8" });
	return {
		id: runtime.missionId,
		spec: { goal, mode: "run", budget: config.budget, isolation: config.isolation, gateCommands, constraints: [] },
		status: "running",
		phase: "bootstrap",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		workspace,
		baseTree: head.status === 0 ? head.stdout.trim() : "nogit",
		baseCommit: head.status === 0 ? head.stdout.trim() : undefined,
	};
}

interface MissionHooks {
	emit: (event: BedrockEvent) => void;
	controller: MissionController;
	ask?: (question: string, options?: string[]) => Promise<string | undefined>;
	onPermission?: (request: PermissionRequest, decision: PermissionDecision) => Promise<boolean>;
	approveGate?: Parameters<typeof runMission>[0]["approveGate"];
	/** Called with the running cost before each event is emitted. */
	onCost?: (usd: number) => void;
}

/** Runs one mission with the configured harness features. */
async function executeMission(cli: Cli, config: BedrockConfig, workspace: string, goal: string, hooks: MissionHooks) {
	const runtime = createRuntime({ config, workspace, autonomous: true });
	if (runtime.scripted)
		hooks.emit({
			type: "notice",
			missionId: runtime.missionId,
			level: "warning",
			text: `scripted model from ${runtime.scripted} (no real provider)`,
			at: new Date().toISOString(),
		});
	const playbook = config.memory.playbook ? new Playbook({ path: defaultPlaybookPath(config.stateDir) }) : undefined;
	try {
		return await runMission({
			mission: newMission(runtime, config, workspace, goal, list(cli.values.gate)),
			ai: runtime.ai,
			sandbox: runtime.sandbox,
			artifacts: runtime.artifacts,
			ledger: runtime.ledger,
			eventLog: runtime.eventLog,
			onEvent: (event) => {
				hooks.onCost?.(runtime.ai.cost.usd);
				hooks.emit(event);
			},
			controller: hooks.controller,
			ask: hooks.ask,
			onPermission: hooks.onPermission,
			approveGate: hooks.approveGate,
			stateDir: config.stateDir,
			maxAttempts: number(cli.values["max-attempts"]) ?? 3,
			maxParallel: config.loop.maxParallelWorkers,
			turnCap: number(cli.values.turns) ?? config.loop.workerTurnCap,
			modelPlanning: !runtime.scripted,
			advisor: config.loop.advisor && !runtime.scripted,
			redTeam: config.loop.redTeam && !runtime.scripted,
			reflect: config.memory.playbook && !runtime.scripted,
			playbook,
			kernel: config.loop.kernel,
			isolation: config.isolation === "worktree" ? "worktree" : "inplace",
			edits: [config.edits.default],
		});
	} finally {
		runtime.close();
	}
}

async function missionMode(
	cli: Cli,
	config: BedrockConfig,
	workspace: string,
	goal: string | undefined,
): Promise<number> {
	if (!requireCredentials()) return 1;
	if (!wantsTui(cli)) {
		if (!goal) return 2;
		const emit = cli.values.json ? jsonEmitter() : proseEmitter();
		const controller = new MissionController();
		process.once("SIGINT", () => controller.cancel());
		try {
			const result = await executeMission(cli, config, workspace, goal, {
				emit,
				controller,
				approveGate: async (gate) => {
					if (cli.values.yes || !isInteractive()) return { ...gate, approved: true, approvedBy: "policy" };
					process.stdout.write(
						`\nGate: ${gate.rationale}\n${gate.checks.map((check) => `- ${check.name}: ${check.command}`).join("\n")}\n`,
					);
					const answer = await readLine("Run this gate? [Y/n] > ");
					return { ...gate, approved: !answer?.toLowerCase().startsWith("n"), approvedBy: "user" };
				},
			});
			if (cli.values.json)
				process.stdout.write(
					`${JSON.stringify({ type: "result", finalState: result.finalState, cost: result.proof.cost, proof: result.proofPath })}\n`,
				);
			else if (result.proofPath) process.stdout.write(`proof: ${result.proofPath}\n`);
			return result.finalState === "passed" ? 0 : 1;
		} catch (error) {
			process.stderr.write(`bedrock: ${(error as Error).message}\n`);
			return 1;
		}
	}

	// Mission Control.
	let controller: MissionController | undefined;
	let lastProof: string | undefined;
	let finished: (code: number) => void = () => {};
	const done = new Promise<number>((resolve) => {
		finished = resolve;
	});
	let exitCode = 0;
	const app: MissionApp = new MissionApp({
		onSubmit: (text) => {
			if (controller && app.view.busy) {
				controller.steer(text);
				return;
			}
			void start(text);
		},
		onInterrupt: () => controller?.cancel(),
		onQuit: () => {
			controller?.cancel();
			finished(exitCode);
		},
		onCommand: (command) => {
			if (command === "proof") {
				app.note(lastProof ? `proof of work: ${lastProof}` : "no mission has finished yet");
				return true;
			}
			return false;
		},
	});
	const start = async (missionGoal: string) => {
		controller = new MissionController();
		app.setBusy(true, `working on: ${missionGoal}`);
		app.setCost(0, config.budget.usd);
		try {
			const result = await executeMission(cli, config, workspace, missionGoal, {
				controller,
				onCost: (usd) => app.setCost(usd, config.budget.usd),
				emit: (event) => app.apply(event),
				ask: (question, options) => app.ask(question, options),
				onPermission: async (request, decision) => {
					const answer = await app.ask(`allow ${request.command ?? request.tool}? (${decision.reason})`, [
						"y",
						"n",
					]);
					return answer?.toLowerCase().startsWith("y") ?? false;
				},
			});
			lastProof = result.proofPath;
			app.setCost(result.proof.cost.usd);
			exitCode = result.finalState === "passed" ? 0 : 1;
			if (result.proofPath) app.note(`proof of work written to ${result.proofPath}`);
			if (goal) app.note("mission finished · type another goal, or /quit");
		} catch (error) {
			app.setBusy(false, `error: ${(error as Error).message}`);
			app.note(`mission failed to run: ${(error as Error).message}`);
			exitCode = 1;
		}
	};
	app.start();
	if (goal) void start(goal);
	const code = await done;
	app.stop();
	return code;
}

async function quickMode(cli: Cli, config: BedrockConfig, workspace: string): Promise<number> {
	const prompt = [cli.positionals.join(" "), str(cli.values.goal) ?? ""].join(" ").trim();
	if (!requireCredentials()) return 1;
	const runtime = createRuntime({ config, workspace, autonomous: !wantsTui(cli) });
	try {
		if (!wantsTui(cli)) {
			if (prompt.length === 0) {
				process.stderr.write('quick mode needs a prompt: bedrock quick "fix the failing test"\n');
				return 2;
			}
			const emit = cli.values.json ? jsonEmitter() : proseEmitter();
			const session = new QuickSession({
				ai: runtime.ai,
				workspace,
				sandbox: runtime.sandbox,
				artifacts: runtime.artifacts,
				edits: [config.edits.default],
				onEvent: emit,
			});
			await session.send(prompt);
			process.stdout.write("\n");
			return 0;
		}
		let finished: () => void = () => {};
		const done = new Promise<void>((resolve) => {
			finished = resolve;
		});
		let session: QuickSession | undefined;
		const app: MissionApp = new MissionApp({
			layout: "chat",
			onSubmit: (text) => {
				if (!session) return;
				const wasBusy = session.busy;
				if (!wasBusy) app.setBusy(true, "thinking…");
				void session.send(text).finally(() => {
					if (!wasBusy) app.setBusy(false, `ready · ${runtime.ai.cost.usd.toFixed(4)} USD so far`);
				});
			},
			onInterrupt: () => session?.abort(),
			onQuit: () => finished(),
		});
		session = new QuickSession({
			ai: runtime.ai,
			workspace,
			sandbox: runtime.sandbox,
			artifacts: runtime.artifacts,
			edits: [config.edits.default],
			onEvent: (event) => {
				app.setCost(runtime.ai.cost.usd, config.budget.usd);
				app.apply(event);
			},
			ask: (question, options) => app.ask(question, options),
			onPermission: async (request, decision) => {
				const answer = await app.ask(`allow ${request.command ?? request.tool}? (${decision.reason})`, ["y", "n"]);
				return answer?.toLowerCase().startsWith("y") ?? false;
			},
		});
		app.view.goal = "quick";
		app.start();
		if (runtime.scripted) app.note(`scripted model from ${runtime.scripted} (no real provider)`);
		if (prompt.length > 0) app.editor.onSubmit?.(prompt);
		await done;
		app.stop();
		return 0;
	} finally {
		runtime.close();
	}
}

async function gateMode(cli: Cli, config: BedrockConfig, workspace: string): Promise<number> {
	const runtime = createRuntime({ config, workspace, autonomous: true });
	const mission = newMission(runtime, config, workspace, str(cli.values.goal) ?? "gate check", list(cli.values.gate));
	const report = scout({ workspace, mission });
	const gate = compileGate(mission, report, { userCommands: list(cli.values.gate) });
	process.stdout.write(`Gate ${shortId(gate.id)}: ${gate.rationale}\n`);
	for (const check of gate.checks) process.stdout.write(`- [${check.kind}] ${check.name}: ${check.command}\n`);
	const result = runGate({
		gate,
		workspace,
		includeHoldout: true,
		artifacts: runtime.artifacts,
		baseCommit: mission.baseCommit,
	});
	process.stdout.write(`\n${describeResult(result)}\n`);
	runtime.close();
	return result.passed ? 0 : 1;
}

async function modelsMode(cli: Cli): Promise<number> {
	const ai = new Ai({ config: loadConfig(process.cwd()).config, models: builtinModels() });
	const query = cli.positionals.join(" ").toLowerCase();
	const models = ai.models
		.getModels()
		.filter((model) => query.length === 0 || `${model.provider}/${model.id}`.toLowerCase().includes(query))
		.sort((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id));
	if (models.length === 0) {
		process.stdout.write(`no models matched "${query}"\n`);
		return 1;
	}
	for (const model of models) {
		const cost = model.cost ? `$${model.cost.input}/$${model.cost.output} per Mtok` : "";
		process.stdout.write(
			`${model.provider}/${model.id}  ${model.contextWindow ? `${Math.round(model.contextWindow / 1000)}k ctx` : ""} ${cost}\n`,
		);
	}
	return 0;
}

function sessionsMode(config: BedrockConfig): number {
	const sessions = recoverSessions(config.stateDir);
	if (sessions.length === 0) {
		process.stdout.write("no recorded sessions\n");
		return 0;
	}
	for (const session of sessions) {
		const state = session.interrupted ? "INTERRUPTED" : "finished";
		process.stdout.write(
			`${session.sessionId}  ${state.padEnd(11)}  ${String(session.events).padStart(5)} events  last phase: ${session.lastPhase ?? "-"}\n`,
		);
	}
	return 0;
}

function proofMode(cli: Cli, config: BedrockConfig): number {
	const missions = join(config.stateDir, "missions");
	if (!existsSync(missions)) {
		process.stderr.write("no proofs yet\n");
		return 1;
	}
	const wanted = cli.positionals[0];
	const dirs = readdirSync(missions)
		.filter((name) => existsSync(join(missions, name, "proof.md")))
		.sort(
			(a, b) => statSync(join(missions, b, "proof.md")).mtimeMs - statSync(join(missions, a, "proof.md")).mtimeMs,
		);
	const chosen = wanted ? dirs.find((name) => name.startsWith(wanted)) : dirs[0];
	if (!chosen) {
		process.stderr.write(wanted ? `no proof for ${wanted}\n` : "no proofs yet\n");
		return 1;
	}
	process.stdout.write(readFileSync(join(missions, chosen, "proof.md"), "utf8"));
	return 0;
}

async function labMode(cli: Cli, config: BedrockConfig, workspace: string): Promise<number> {
	const [sub, target] = cli.positionals;
	const runsDir = join(config.stateDir, "lab", "runs");
	if (sub === "runs") {
		const runs = listRuns(runsDir);
		if (runs.length === 0) process.stdout.write("no lab runs yet\n");
		for (const run of runs) process.stdout.write(`${run.runId}  ${run.finishedAt}\n${reportRun(run)}\n\n`);
		return 0;
	}
	if (sub === "tb") {
		if (!target) {
			process.stderr.write("usage: bedrock lab tb <terminal-bench tasks dir>\n");
			return 2;
		}
		const tasks = loadTerminalBenchTasks(target, { tags: str(cli.values.tags)?.split(",") });
		for (const task of tasks) process.stdout.write(`${task.id.padEnd(40)} ${(task.tags ?? []).join(",")}\n`);
		process.stdout.write(`${tasks.length} tasks (they run inside their Docker images; use --isolation container)\n`);
		return 0;
	}
	if (sub !== "run") {
		process.stderr.write("usage: bedrock lab run [suite.json] | bedrock lab runs | bedrock lab tb <dir>\n");
		return 2;
	}
	if (!requireCredentials()) return 1;
	const suitePath = target ?? join(workspace, "evals", "bedrock-hard", "suite.json");
	if (!existsSync(suitePath)) {
		process.stderr.write(`no suite at ${suitePath}\n`);
		return 2;
	}
	const suite = loadSuite(suitePath);
	const probe = createRuntime({ config, workspace, autonomous: true });
	const models = probe.ai.models;
	probe.close();
	const run = await runSuite({
		suite,
		config,
		attempts: number(cli.values.attempts) ?? 1,
		tags: str(cli.values.tags)?.split(","),
		runner: createMissionRunner({
			makeAi: (taskConfig) => new Ai({ config: taskConfig, models }),
			maxAttempts: number(cli.values["max-attempts"]) ?? 3,
		}),
		onAttempt: (attempt) =>
			process.stdout.write(
				`${attempt.taskId.padEnd(28)} ${attempt.finalState.padEnd(10)} holdout ${attempt.holdoutPassed ? "pass" : "FAIL"}  $${attempt.costUsd.toFixed(3)}${attempt.error ? `  error: ${attempt.error}` : ""}\n`,
			),
	});
	const dir = saveRun(runsDir, run);
	process.stdout.write(`\n${reportRun(run)}\nsaved: ${dir}\n`);
	return run.metrics.falseCompletionRate === 0 ? 0 : 1;
}

main()
	.then((code) => process.exit(code))
	.catch((error: unknown) => {
		process.stderr.write(`bedrock: ${(error as Error).message}\n`);
		process.exit(1);
	});
