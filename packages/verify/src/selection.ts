// @bedrock/verify: choosing among passing candidates, and computing the final state.

import type { Ai } from "@bedrock/ai";
import type { CandidateView, FinalState, Gate, GateResult, Id, SelectionStrategy } from "@bedrock/protocol";

export interface SelectionResult {
	winner?: CandidateView;
	rationale: string;
	rootCauseGroup?: string[];
	ranking: Id<"worker">[];
}

/**
 * Recursive Tournament Voting: compare candidates pairwise on compact summaries
 * and rank with a model judge, then break ties deterministically. Falls back to
 * the gate's own numbers when no judge is available, so selection never blocks.
 */
export class TournamentSelection implements SelectionStrategy {
	#ai?: Ai;

	constructor(ai?: Ai) {
		this.#ai = ai;
	}

	async select(candidates: CandidateView[], gate: Gate): Promise<SelectionResult> {
		const eligible = candidates.filter((candidate) => candidate.gate.passed && candidate.gate.integrity.clean);
		if (eligible.length === 0) return { rationale: "no candidate passed the gate", ranking: [] };
		if (eligible.length === 1)
			return { winner: eligible[0], rationale: "the only candidate that passed", ranking: [eligible[0].workerId] };

		const deterministic = [...eligible].sort((a, b) => {
			const byGate = b.gate.passRatio - a.gate.passRatio;
			if (byGate !== 0) return byGate;
			const byRubric = (b.rubricScore ?? 0) - (a.rubricScore ?? 0);
			if (byRubric !== 0) return byRubric;
			return a.diffStat.additions + a.diffStat.deletions - (b.diffStat.additions + b.diffStat.deletions);
		});
		if (!this.#ai) {
			return {
				winner: deterministic[0],
				rationale: "ranked by gate pass ratio, then rubric score, then diff size",
				ranking: deterministic.map((candidate) => candidate.workerId),
			};
		}

		const summaries = eligible
			.map(
				(candidate, index) =>
					`Candidate ${index + 1} (${candidate.workerId})\n${candidate.summary}\nDiffstat: +${candidate.diffStat.additions} -${candidate.diffStat.deletions}\nGate: ${candidate.gate.passRatio * 100}% checks passed`,
			)
			.join("\n\n");
		const prompt = `Several candidates passed the gate for the same task.\n\n${summaries}\n\nWhich single candidate is most likely correct, smallest in blast radius, and easiest to review? Answer with JSON {"winner": <number>, "rationale": "..."} and no other text.`;
		try {
			const answer = await this.#ai.call("judge", prompt, {
				system: "You compare candidate solutions by evidence, not by confidence.",
			});
			const parsed = JSON.parse(answer.text.slice(answer.text.indexOf("{"), answer.text.lastIndexOf("}") + 1)) as {
				winner?: number;
				rationale?: string;
			};
			const index = typeof parsed.winner === "number" ? parsed.winner - 1 : 0;
			const winner = eligible[index] ?? deterministic[0];
			return {
				winner,
				rationale: parsed.rationale ?? "judge selected a candidate",
				ranking: [
					winner.workerId,
					...eligible.filter((candidate) => candidate !== winner).map((candidate) => candidate.workerId),
				],
			};
		} catch {
			return {
				winner: deterministic[0],
				rationale: "judge unavailable; ranked by gate pass ratio, rubric score and diff size",
				ranking: deterministic.map((candidate) => candidate.workerId),
			};
		}
	}
}

/** The harness's verdict. Never taken from model text. */
export function computeFinalState(
	results: GateResult[],
	options: { cancelled?: boolean; exhausted?: boolean } = {},
): FinalState {
	if (options.cancelled) return "cancelled";
	const passed = results.some((result) => result.passed && result.integrity.clean);
	if (passed) return "passed";
	if (results.some((result) => !result.integrity.clean)) return "unverified";
	const best = results.reduce((max, result) => Math.max(max, result.passRatio), 0);
	if (options.exhausted) return "exhausted";
	if (best > 0) return "partial";
	return "failed";
}

/** A short, honest sentence for the proof of work. */
export function explainFinalState(state: FinalState, results: GateResult[]): string {
	const best = results.reduce<GateResult | undefined>(
		(max, result) => (!max || result.passRatio > max.passRatio ? result : max),
		undefined,
	);
	const ratio = best ? `${Math.round(best.passRatio * 100)}% of checks passed` : "no checks ran";
	switch (state) {
		case "passed":
			return "The gate passed on a tree whose hash is recorded, with no integrity findings.";
		case "partial":
			return `Progress was real but incomplete: ${ratio} on the best tree. See the failing checks for what remains.`;
		case "failed":
			return "No candidate passed the gate. The failures are recorded with their output.";
		case "unverified":
			return "The solution could not be verified (integrity findings or verifier unavailability). Treat it as unproven.";
		case "cancelled":
			return "The mission was cancelled before verification completed.";
		case "exhausted":
			return `The budget ran out with the best attempt at ${ratio}. Nothing is claimed as done.`;
	}
}
