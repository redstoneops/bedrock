// @bedrock/memory: Chest. On-disk task state a fresh context can bootstrap from.
//
// The Chest is intentionally plain files. A new session (or a human) can read
// them with `cat`; a crashed daemon can rebuild its view from them; and a mission
// that outlives its context leaves something behind that is not a transcript.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Gate, Mission, RefineBrief, StrategyTree } from "@bedrock/protocol";

export interface ChestPaths {
	root: string;
	recipe: string;
	plan: string;
	progress: string;
	decisions: string;
	failures: string;
}

export function chestPaths(stateDir: string): ChestPaths {
	const root = join(stateDir, "chest");
	return {
		root,
		recipe: join(root, "recipe.json"),
		plan: join(root, "plan.md"),
		progress: join(root, "progress.md"),
		decisions: join(root, "decisions.md"),
		failures: join(root, "failures.md"),
	};
}

function write(path: string, content: string): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, content.endsWith("\n") ? content : `${content}\n`, "utf8");
}

function append(path: string, content: string): void {
	const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
	write(path, `${existing}${existing.length > 0 && !existing.endsWith("\n") ? "\n" : ""}${content}`);
}

/**
 * Writes the mission's recipe (the gate) and plan. Called as soon as the gate is
 * approved, so the definition of done survives any later crash.
 */
export function writeChest(
	stateDir: string,
	input: { mission: Mission; gate: Gate; strategy?: StrategyTree },
): ChestPaths {
	const paths = chestPaths(stateDir);
	write(paths.recipe, JSON.stringify({ mission: input.mission, gate: input.gate }, null, 2));
	if (input.strategy) {
		const root = input.strategy.nodes[input.strategy.rootId];
		const lines = [
			`# Plan: ${input.mission.spec.goal}`,
			"",
			input.strategy.rationale,
			"",
			`## ${root?.title ?? "mission"}`,
			root?.hypothesis ?? "",
			"",
			"## Approaches",
			...(root?.children ?? []).map((id) => {
				const node = input.strategy?.nodes[id];
				return node ? `- [${node.status}] **${node.title}** — ${node.hypothesis}` : "";
			}),
		];
		write(paths.plan, lines.join("\n"));
	}
	if (!existsSync(paths.progress))
		write(paths.progress, `# Progress\n\n- ${new Date().toISOString()} mission started: ${input.mission.spec.goal}`);
	if (!existsSync(paths.decisions)) write(paths.decisions, "# Decisions\n");
	if (!existsSync(paths.failures)) write(paths.failures, "# Failures\n");
	return paths;
}

export function recordProgress(stateDir: string, line: string): void {
	append(chestPaths(stateDir).progress, `- ${new Date().toISOString()} ${line}`);
}

export function recordDecision(stateDir: string, decision: string, rationale: string): void {
	append(chestPaths(stateDir).decisions, `\n## ${new Date().toISOString()} ${decision}\n\n${rationale}`);
}

export function recordFailure(stateDir: string, brief: RefineBrief): void {
	const lines = ["", `## ${new Date().toISOString()} attempt failed`];
	if (brief.failingChecks.length > 0) {
		lines.push("Failing checks:", ...brief.failingChecks.map((check) => `- ${check.name}: ${check.reason}`));
	}
	if (brief.ruledOut.length > 0) lines.push("Ruled out:", ...brief.ruledOut.map((item) => `- ${item}`));
	if (brief.useful.length > 0) lines.push("Useful:", ...brief.useful.map((item) => `- ${item}`));
	append(chestPaths(stateDir).failures, lines.join("\n"));
}

/** Reads the Chest back, for a resumed session or a human. */
export function readChest(stateDir: string): {
	recipe?: { mission: Mission; gate: Gate };
	plan?: string;
	progress?: string;
	decisions?: string;
	failures?: string;
} {
	const paths = chestPaths(stateDir);
	const read = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : undefined);
	const recipeText = read(paths.recipe);
	return {
		recipe: recipeText ? (JSON.parse(recipeText) as { mission: Mission; gate: Gate }) : undefined,
		plan: read(paths.plan),
		progress: read(paths.progress),
		decisions: read(paths.decisions),
		failures: read(paths.failures),
	};
}
