// @bedrock/core: prompts for workers, briefs and refinement.

import type { Gate, Mission, RefineBrief } from "@bedrock/protocol";

/** Renders the gate the way a worker should see it: visible checks only. */
export function gateText(gate: Gate): string {
	const visible = gate.checks.filter((check) => check.visibility === "visible");
	const holdout = gate.checks.length - visible.length;
	const lines = visible.map((check) => `- [${check.kind}] ${check.name}: \`${check.command}\``);
	if (holdout > 0) lines.push(`- ${holdout} additional checks are held out; they run only at verification.`);
	if (gate.invariants.length > 0) {
		lines.push("Invariants:", ...gate.invariants.map((invariant) => `- ${describeInvariant(invariant)}`));
	}
	if (gate.rubric.length > 0)
		lines.push("Criteria:", ...gate.rubric.map((criterion) => `- (${criterion.severity}) ${criterion.criterion}`));
	return lines.join("\n");
}

function describeInvariant(invariant: Gate["invariants"][number]): string {
	switch (invariant.kind) {
		case "files_unchanged":
			return `do not modify: ${invariant.paths.join(", ")} (${invariant.reason})`;
		case "paths_untouched":
			return `do not modify paths matching: ${invariant.globs.join(", ")} (${invariant.reason})`;
		case "command_passes":
			return `\`${invariant.command}\` must keep passing (${invariant.reason})`;
		case "no_new_dependencies":
			return `do not add dependencies (${invariant.reason})`;
		case "public_api_unchanged":
			return `keep the public API of ${invariant.entrypoints.join(", ")} unchanged (${invariant.reason})`;
	}
}

/** The brief a worker receives. It is a task description, not a transcript. */
export function workerBrief(input: {
	mission: Mission;
	gate: Gate;
	title: string;
	hypothesis: string;
	risks: string[];
}): string {
	const { mission, gate, title, hypothesis } = input;
	const constraints = mission.spec.constraints?.length
		? `\nConstraints:\n${mission.spec.constraints.map((line) => `- ${line}`).join("\n")}`
		: "";
	const lines = [
		`# Task: ${mission.spec.goal}`,
		"",
		`Approach: ${title}`,
		`Hypothesis: ${hypothesis}`,
		input.risks.length > 0 ? `Risks to watch:\n${input.risks.map((risk) => `- ${risk}`).join("\n")}` : "",
		constraints,
		"",
		`## Definition of done\n${gateText(gate)}`,
		"",
		"Start by reading the files the task points at. Then make the smallest change that makes the checks pass, run them, and call finish with the commands you ran.",
	];
	return lines.filter((line, index, all) => !(line === "" && all[index - 1] === "")).join("\n");
}

/** The brief for a refined (PDR) attempt: distilled failures, not the old transcript. */
export function refineBriefText(brief: RefineBrief): string {
	const lines = ["## What previous attempts established", ""];
	if (brief.failingChecks.length > 0) {
		lines.push("Failing checks:");
		for (const check of brief.failingChecks) lines.push(`- ${check.name}: ${check.reason}`);
		lines.push("");
	}
	if (brief.ruledOut.length > 0) {
		lines.push("Ruled out (do not repeat):");
		for (const item of brief.ruledOut) lines.push(`- ${item}`);
		lines.push("");
	}
	if (brief.useful.length > 0) {
		lines.push("Established:");
		for (const item of brief.useful) lines.push(`- ${item}`);
		lines.push("");
	}
	if (brief.nextSteps.length > 0) {
		lines.push("Open questions:");
		for (const item of brief.nextSteps) lines.push(`- ${item}`);
	}
	lines.push(
		"",
		"Use this as a starting point, but verify anything you rely on; previous attempts may have been wrong.",
	);
	return lines.join("\n");
}
