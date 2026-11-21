// @bedrock/core: the Proof of Work as files a reviewer can read without Bedrock.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProofOfWork } from "@bedrock/protocol";

/** Renders the proof as markdown: verdict first, then evidence, then what is not proven. */
export function renderProofMarkdown(proof: ProofOfWork, goal: string): string {
	const lines = [
		`# Proof of work: ${proof.finalState.toUpperCase()}`,
		"",
		`**Goal:** ${goal}`,
		"",
		proof.summary,
		"",
		"## Change",
		`${proof.diffStat.files} files, +${proof.diffStat.additions} -${proof.diffStat.deletions}`,
	];
	if (proof.gate) {
		lines.push("", `## Gate (tree ${proof.gate.treeHash.slice(0, 12)})`);
		for (const run of proof.gate.visible)
			lines.push(
				`- ${run.status === "passed" ? "PASS" : "FAIL"} ${run.name}${run.failureReason ? ` (${run.failureReason})` : ""}`,
			);
		for (const run of proof.gate.holdout)
			lines.push(`- ${run.status === "passed" ? "PASS" : "FAIL"} ${run.name} (holdout)`);
		for (const violation of proof.gate.invariantViolations) lines.push(`- INVARIANT ${violation.detail}`);
		for (const finding of proof.gate.integrity.suspicious)
			lines.push(`- INTEGRITY ${finding.severity}: ${finding.detail}`);
	}
	if (proof.unverified.length > 0) lines.push("", "## Not verified", ...proof.unverified.map((item) => `- ${item}`));
	if (proof.risks.length > 0) lines.push("", "## Risks", ...proof.risks.map((item) => `- ${item}`));
	if (proof.checkpoints.length > 0)
		lines.push("", "## Branches", ...proof.checkpoints.map((item) => `- ${item.label}: ${item.commit}`));
	lines.push(
		"",
		"## Cost",
		`$${proof.cost.usd.toFixed(4)} · ${proof.cost.tokens} tokens · ${Math.round(proof.cost.wallClockMs / 1000)}s`,
	);
	if (proof.evidence.length > 0)
		lines.push("", "## Evidence entries", ...proof.evidence.slice(0, 30).map((id) => `- ${id}`));
	return `${lines.join("\n")}\n`;
}

/** Writes proof.md and proof.json under `<stateDir>/missions/<missionId>/`. */
export function writeProof(stateDir: string, proof: ProofOfWork, goal: string): string {
	const dir = join(stateDir, "missions", proof.missionId);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "proof.json"), JSON.stringify(proof, null, 2), "utf8");
	writeFileSync(join(dir, "proof.md"), renderProofMarkdown(proof, goal), "utf8");
	return join(dir, "proof.md");
}
