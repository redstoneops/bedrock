// @bedrock/cli: the bedrock command.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { Ai } from "@bedrock/ai";
import { runMission, scout } from "@bedrock/core";
import { compileGate, describeResult, runGate } from "@bedrock/gate";
import { type Mission, type Role, shortId } from "@bedrock/protocol";
import { createFinishTool, createTools, type FinishReport } from "@bedrock/tools";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { Agent } from "@earendil-works/pi-agent-core";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { applyOverrides, loadConfig } from "./config.ts";
import { createRuntime, hasProviderCredentials, isInteractive, type Runtime, readLine } from "./runtime.ts";

const VERSION = "0.1.0";

const HELP = `bedrock — agents that stand on verified ground

Usage:
  bedrock                          interactive session (TUI when attached, plain otherwise)
  bedrock quick [prompt...]        one plain agent loop, no gate
  bedrock run --goal "..." [--gate "cmd"]   autonomous mission with a compiled gate
  bedrock scout                    print the scout report for this repo
  bedrock gate [--gate "cmd"]      compile and run the gate once, no agent
  bedrock models [query]           list models from the pi catalog
  bedrock --version | --help

Options:
  --goal <text>        the mission goal (run)
  --gate <cmd>         a gate command; repeatable, always included, never weakened
  --model <ref>        model for the worker role (provider/model)
  --role <role>        role to apply --model to (default: worker)
  --max-usd <n>        budget in dollars
  --max-attempts <n>   how many attempts before stopping (default 3)
  --turns <n>          per-attempt turn cap (default 120)
  --parallel <n>       maximum parallel workers (default from config)
  --permissions <p>    yolo | standard | strict
  --isolation <i>      worktree | copy | container
  --json               emit a JSONL event stream instead of prose
  --yes                approve the compiled gate without asking
  --config <path>      config file (default: .bedrock/config.yml, then ~/.bedrock/config.yml)

Commands that run a mission write state to <workspace>/.bedrock: the SQLite ledger,
a JSONL event log per session, content-addressed artifacts and an audit log.`;

interface Cli {
	command: string;
	positionals: string[];
	values: {
		goal?: string;
		gate?: string[];
		model?: string;
		role?: string;
		"max-usd"?: string;
		"max-attempts"?: string;
		turns?: string;
		parallel?: string;
		permissions?: string;
		isolation?: string;
		json?: boolean;
		yes?: boolean;
		help?: boolean;
		version?: boolean;
		config?: string;
	};
}

function parseCli(): Cli {
	const { values, positionals } = parseArgs({
		allowPositionals: true,
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
			json: { type: "boolean" },
			yes: { type: "boolean" },
			help: { type: "boolean", short: "h" },
			version: { type: "boolean", short: "v" },
			config: { type: "string" },
		},
	});
	return { command: positionals[0] ?? "", positionals: positionals.slice(1), values };
}

function number(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`expected a non-negative number, got "${value}"`);
	return parsed;
}

/** Prints an event as one JSON line, for `--json` and CI. */
function jsonEmitter(): (event: { type: string; [key: string]: unknown }) => void {
	return (event) => {
		process.stdout.write(`${JSON.stringify(event)}\n`);
	};
}

/** Human-readable stream of mission events. */
function proseEmitter(): (event: { type: string; [key: string]: unknown }) => void {
	return (event) => {
		switch (event.type) {
			case "mission_phase":
				process.stdout.write(`\n[${String(event.phase)}]\n`);
				break;
			case "gate_compiled": {
				process.stdout.write(`gate: ${String(event.checks)} checks\n`);
				break;
			}
			case "worker_event": {
				const inner = event.event as { type: string; text?: string; name?: string; ok?: boolean; turn?: number };
				if (inner.type === "text" && inner.text) process.stdout.write(inner.text);
				else if (inner.type === "turn") process.stdout.write(`\n(turn ${inner.turn})\n`);
				else if (inner.type === "tool_start") process.stdout.write(`\n  → ${inner.name}\n`);
				else if (inner.type === "tool_end") process.stdout.write(`    ${inner.ok ? "ok" : "failed"}\n`);
				break;
			}
			case "verification": {
				const result = event.result as Parameters<typeof describeResult>[0];
				process.stdout.write(`\n${describeResult(result)}\n`);
				break;
			}
			case "budget_decision": {
				const decision = event.decision as { action: string; reason: string };
				process.stdout.write(`\nbudget: ${decision.action} (${decision.reason})\n`);
				break;
			}
			case "mission_finish": {
				const proof = event.proof as { finalState: string; summary: string };
				process.stdout.write(`\n== ${proof.finalState.toUpperCase()} ==\n${proof.summary}\n`);
				break;
			}
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
	if (cli.values.help || (cli.command === "" && cli.values.goal === undefined && !isInteractive())) {
		process.stdout.write(`${HELP}\n`);
		return cli.command === "" && !cli.values.help ? 0 : 0;
	}

	const workspace = process.cwd();
	const loaded = loadConfig(workspace);
	const config = applyOverrides(loaded.config, {
		model: cli.values.model,
		role: cli.values.role as Role | undefined,
		maxUsd: number(cli.values["max-usd"]),
		permissions: cli.values.permissions,
		isolation: cli.values.isolation,
		parallel: number(cli.values.parallel),
	});
	for (const warning of loaded.warnings) process.stderr.write(`config: ${warning}\n`);

	switch (cli.command) {
		case "":
			process.stdout.write(
				'Bedrock is not attached to a TUI in this build. Use `bedrock quick "..."` or `bedrock run --goal "..."`.\n',
			);
			return 0;
		case "quick":
			return quickMode(cli, config, workspace);
		case "run":
			return runMode(cli, config, workspace);
		case "scout":
			return scoutMode(workspace);
		case "gate":
			return gateMode(cli, config, workspace);
		case "models":
			return modelsMode(cli);
		default:
			process.stderr.write(`unknown command "${cli.command}"\n\n${HELP}\n`);
			return 2;
	}
}

async function quickMode(
	cli: Cli,
	config: Parameters<typeof createRuntime>[0]["config"],
	workspace: string,
): Promise<number> {
	const prompt = [cli.positionals.join(" "), cli.values.goal ?? ""].join(" ").trim();
	if (prompt.length === 0) {
		process.stderr.write('quick mode needs a prompt: bedrock quick "fix the failing test"\n');
		return 2;
	}
	if (!hasProviderCredentials()) {
		process.stderr.write(
			"no provider credentials found. Set an API key (for example ANTHROPIC_API_KEY or OPENAI_API_KEY) or log in with pi, then retry.\n",
		);
		return 1;
	}
	const runtime = createRuntime({ config, workspace, autonomous: !isInteractive() });
	let resolved: ReturnType<Runtime["ai"]["resolve"]>;
	try {
		resolved = runtime.ai.resolve("worker");
	} catch (error) {
		process.stderr.write(
			`${(error as Error).message}\nSet a provider API key and a model in .bedrock/config.yml, or pass --model.\n`,
		);
		runtime.close();
		return 1;
	}
	const tools = createTools({
		workspace,
		sandbox: runtime.sandbox,
		artifacts: runtime.artifacts,
		todos: [],
		ask: async (question) => readLine(`\n[ask] ${question} > `),
		onPermission: async (request, decision) => {
			const answer = await readLine(
				`\n[permission] ${decision.reason}: ${request.command ?? request.tool}? [y/N] > `,
			);
			return answer?.toLowerCase().startsWith("y") ?? false;
		},
	});
	let report: FinishReport | undefined;
	tools.push(
		createFinishTool({
			onReport: (value) => {
				report = value;
			},
		}) as (typeof tools)[number],
	);
	const agent = new Agent({
		initialState: {
			systemPrompt: [
				"You are Bedrock in quick mode: a fast, careful coding agent in the current workspace.",
				"Make the smallest change that solves the task. Read before you edit; hashline reads return tags and edit patches must carry them.",
				"Run the check that proves the work, then call finish with the commands you ran. Never claim a command passed unless you ran it.",
			].join("\n"),
			model: resolved.model,
			thinkingLevel: resolved.effort === "off" ? "off" : (resolved.effort as "low" | "medium" | "high"),
			tools,
		},
		streamFn: runtime.ai.models.streamSimple.bind(runtime.ai.models),
		afterToolCall: async (context) => {
			if (context.toolCall.name === "finish") return undefined;
			return undefined;
		},
	});
	agent.subscribe((event: AgentEvent) => {
		if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
			process.stdout.write(event.assistantMessageEvent.delta);
		} else if (event.type === "tool_execution_start") {
			process.stdout.write(`\n  → ${event.toolName}\n`);
		} else if (event.type === "tool_execution_end") {
			process.stdout.write(`    ${event.isError ? "failed" : "ok"}\n`);
		}
	});
	try {
		await agent.prompt(prompt);
	} catch (error) {
		process.stderr.write(`\n${(error as Error).message}\n`);
		return 1;
	} finally {
		runtime.close();
	}
	process.stdout.write(
		`\n${report ? `finished: ${(report as FinishReport).summary}` : "finished without a report"}\n`,
	);
	return 0;
}

async function runMode(
	cli: Cli,
	config: Parameters<typeof createRuntime>[0]["config"],
	workspace: string,
): Promise<number> {
	const goal = cli.values.goal ?? cli.positionals.join(" ");
	if (goal.trim().length === 0) {
		process.stderr.write('run mode needs --goal "..."\n');
		return 2;
	}
	if (!hasProviderCredentials()) {
		process.stderr.write(
			"no provider credentials found. Set an API key (for example ANTHROPIC_API_KEY or OPENAI_API_KEY) or log in with pi, then retry.\n",
		);
		return 1;
	}
	const runtime = createRuntime({ config, workspace, autonomous: true });
	if (!existsSync(join(workspace, ".git"))) {
		process.stderr.write("warning: no git repository here; the gate cannot bind results to a commit\n");
	}
	const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: workspace, encoding: "utf8" });
	const mission: Mission = {
		id: runtime.missionId,
		spec: {
			goal,
			mode: "run",
			budget: config.budget,
			isolation: config.isolation,
			gateCommands: cli.values.gate,
			constraints: [],
		},
		status: "running",
		phase: "bootstrap",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		workspace,
		baseTree: head.status === 0 ? head.stdout.trim() : "nogit",
		baseCommit: head.status === 0 ? head.stdout.trim() : undefined,
	};
	const emit = cli.values.json ? jsonEmitter() : proseEmitter();
	let result: Awaited<ReturnType<typeof runMission>>;
	try {
		result = await runMission({
			mission,
			ai: runtime.ai,
			sandbox: runtime.sandbox,
			artifacts: runtime.artifacts,
			ledger: runtime.ledger as never,
			eventLog: runtime.eventLog,
			onEvent: emit,
			maxAttempts: number(cli.values["max-attempts"]) ?? 3,
			turnCap: number(cli.values.turns) ?? config.loop.workerTurnCap,
			validateAcceptance: false,
			approveGate: async (gate) => {
				if (cli.values.yes || !isInteractive()) return gate;
				process.stdout.write(
					`\nGate: ${gate.rationale}\n${gate.checks.map((check) => `- ${check.name}: ${check.command}`).join("\n")}\n`,
				);
				const answer = await readLine("Run this gate? [Y/n] > ");
				return answer?.toLowerCase().startsWith("n")
					? { ...gate, checks: gate.checks, rationale: "user declined; running without approval" }
					: { ...gate, approved: true, approvedBy: "user" as const };
			},
		});
	} catch (error) {
		process.stderr.write(`bedrock: ${(error as Error).message}\n`);
		runtime.close();
		return 1;
	}
	runtime.close();
	if (cli.values.json)
		process.stdout.write(
			`${JSON.stringify({ type: "result", finalState: result.finalState, cost: result.proof.cost })}\n`,
		);
	return result.finalState === "passed" ? 0 : 1;
}

async function scoutMode(workspace: string): Promise<number> {
	const report = scout({ workspace });
	process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
	return 0;
}

async function gateMode(
	cli: Cli,
	config: Parameters<typeof createRuntime>[0]["config"],
	workspace: string,
): Promise<number> {
	const runtime = createRuntime({ config, workspace, autonomous: true });
	const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: workspace, encoding: "utf8" });
	const mission: Mission = {
		id: runtime.missionId,
		spec: {
			goal: cli.values.goal ?? "gate check",
			mode: "run",
			budget: config.budget,
			isolation: config.isolation,
			gateCommands: cli.values.gate,
		},
		status: "running",
		phase: "gate",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		workspace,
		baseTree: head.status === 0 ? head.stdout.trim() : "nogit",
		baseCommit: head.status === 0 ? head.stdout.trim() : undefined,
	};
	const report = scout({ workspace, mission });
	const gate = compileGate(mission, report, { userCommands: cli.values.gate });
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
	const runtimeConfig = loadConfig(process.cwd()).config;
	const ai = new Ai({ config: runtimeConfig, models: builtinModels() });
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

main()
	.then((code) => process.exit(code))
	.catch((error: unknown) => {
		process.stderr.write(`bedrock: ${(error as Error).message}\n`);
		process.exit(1);
	});
