// @bedrock/context: Hopper. Prompt assembly as a view of state, never a transcript dump.
//
// Sections are emitted in a fixed order so the provider cache prefix stays
// stable across turns: only the tail changes as the mission progresses.

import type { Gate, LedgerEntry, Mission, StrategyTree } from "@bedrock/protocol";
import { summarizeEntry } from "@bedrock/protocol";

export interface PromptSection {
	title: string;
	body: string;
	/** Stable sections come first and are cached; volatile sections follow. */
	stable: boolean;
}

export interface TurnPromptInput {
	system: string;
	mission: Mission;
	gate?: Gate;
	ledger: LedgerEntry[];
	strategy?: StrategyTree;
	playbook?: string[];
	/** Recent conversation, already rendered, oldest first. */
	history?: string[];
	/** The current ask or steer message. */
	instruction: string;
}

/** Renders a prompt with a stable cache prefix followed by volatile state. */
export function assemblePrompt(input: TurnPromptInput): string {
	const sections: PromptSection[] = [
		{ title: "System", body: input.system, stable: true },
		{ title: "Mission", body: missionSummary(input.mission), stable: false },
	];
	if (input.gate) sections.push({ title: "Gate (definition of done)", body: gateSummary(input.gate), stable: false });
	if (input.strategy) sections.push({ title: "Strategy", body: strategySummary(input.strategy), stable: false });
	if (input.playbook?.length)
		sections.push({ title: "Playbook", body: input.playbook.map((line) => `- ${line}`).join("\n"), stable: false });
	sections.push({ title: "Ledger", body: renderLedgerSlice(input.ledger), stable: false });
	if (input.history?.length) sections.push({ title: "Recent turns", body: input.history.join("\n\n"), stable: false });
	sections.push({ title: "Instruction", body: input.instruction, stable: false });

	const ordered = [...sections.filter((section) => section.stable), ...sections.filter((section) => !section.stable)];
	return ordered.map((section) => `## ${section.title}\n${section.body.trim()}`).join("\n\n");
}

export function missionSummary(mission: Mission): string {
	const lines = [
		`Goal: ${mission.spec.goal}`,
		`Mode: ${mission.spec.mode} · Phase: ${mission.phase} · Isolation: ${mission.spec.isolation}`,
		`Workspace: ${mission.workspace} (base tree ${mission.baseTree.slice(0, 12)})`,
	];
	if (mission.spec.constraints?.length)
		lines.push(`Constraints:\n${mission.spec.constraints.map((line) => `- ${line}`).join("\n")}`);
	if (mission.spec.gateCommands?.length)
		lines.push(`User gate commands:\n${mission.spec.gateCommands.map((line) => `- ${line}`).join("\n")}`);
	return lines.join("\n");
}

export function gateSummary(gate: Gate): string {
	const visible = gate.checks.filter((check) => check.visibility === "visible");
	const holdout = gate.checks.filter((check) => check.visibility === "holdout");
	const lines = [
		`${visible.length} visible checks, ${holdout.length} holdout checks, ${gate.invariants.length} invariants.`,
		...visible.map((check) => `- [${check.kind}] ${check.name}: \`${check.command}\``),
	];
	if (holdout.length > 0) lines.push(`- ${holdout.length} holdout checks are hidden; they run only at verification.`);
	if (gate.rubric.length > 0)
		lines.push("Rubric:", ...gate.rubric.map((criterion) => `- (${criterion.severity}) ${criterion.criterion}`));
	return lines.join("\n");
}

export function strategySummary(tree: StrategyTree): string {
	const root = tree.nodes[tree.rootId];
	if (!root) return "No strategy.";
	const lines = [`Approach: ${root.title} — ${root.hypothesis}`, tree.rationale];
	for (const child of root.children) {
		const node = tree.nodes[child];
		if (node) lines.push(`- [${node.status}] ${node.title}: ${node.hypothesis}`);
	}
	return lines.join("\n");
}

/** A bounded ledger slice: the facts and decisions a worker needs, not the whole ledger. */
export function renderLedgerSlice(entries: LedgerEntry[], limit = 30): string {
	if (entries.length === 0) return "(no ledger entries yet)";
	return entries
		.slice(-limit)
		.map((entry) => {
			const marker = entry.evidence ? " [evidenced]" : " [no evidence]";
			return `- ${summarizeEntry(entry)}${marker}`;
		})
		.join("\n");
}
