// @bedrock/core: the Strategist. Distinct approaches, so parallel attempts are diverse.
//
// Diversity beats persistence: N copies of the same idea fail together. When a
// model is available the strategist asks it for genuinely different approaches;
// otherwise it falls back to a fixed set of problem-solving stances that differ
// in method, not wording.

import type { Ai } from "@bedrock/ai";
import type { Gate, Mission, RefineBrief, ScoutReport } from "@bedrock/protocol";

export interface Approach {
	title: string;
	hypothesis: string;
	risks: string[];
}

/** Method-level stances. Each one changes how the worker spends its first turns. */
export const STANCES: Approach[] = [
	{
		title: "direct fix",
		hypothesis:
			"The failure has a local cause; read the failing check's output, find the code it exercises, make the smallest change that fixes it.",
		risks: ["fixing a symptom instead of the cause"],
	},
	{
		title: "reproduce first",
		hypothesis:
			"Write or isolate a minimal reproduction of the failure before touching the implementation, then fix against the reproduction.",
		risks: ["the reproduction does not match the real failure"],
	},
	{
		title: "root cause",
		hypothesis:
			"Trace the data flow end to end (logs, prints, git history of the touched code) and fix the earliest point where behavior diverges from the spec.",
		risks: ["spending the budget on investigation"],
	},
	{
		title: "alternative design",
		hypothesis:
			"The current structure makes the fix awkward; restructure the smallest unit that owns the behavior so the fix becomes obvious.",
		risks: ["a larger diff touching unrelated callers"],
	},
];

/** Picks `count` approaches without asking a model. Refined rounds rotate stances. */
export function heuristicApproaches(count: number, round: number): Approach[] {
	const out: Approach[] = [];
	for (let index = 0; index < count; index++) out.push(STANCES[(round - 1 + index) % STANCES.length]);
	return out;
}

const PLAN_PROMPT = `You plan approaches for a software task. Propose genuinely different approaches: different methods or designs, not rephrasings.
Answer with JSON only: {"approaches":[{"title":"<=6 words","hypothesis":"one or two sentences: what to do and why it should work","risks":["..."]}]}`;

/**
 * Asks the strategist role for `count` approaches; falls back to heuristics on
 * any failure so planning never blocks a mission.
 */
export async function planApproaches(input: {
	ai?: Ai;
	mission: Mission;
	gate: Gate;
	scout?: ScoutReport;
	count: number;
	round: number;
	brief?: RefineBrief;
}): Promise<{ approaches: Approach[]; source: "model" | "heuristic" }> {
	if (!input.ai) return { approaches: heuristicApproaches(input.count, input.round), source: "heuristic" };
	const context = [
		`Task: ${input.mission.spec.goal}`,
		`Checks that must pass: ${
			input.gate.checks
				.filter((check) => check.visibility === "visible")
				.map((check) => check.command)
				.join("; ") || "none detected"
		}`,
		input.scout
			? `Repository: ${input.scout.languages.map((language) => language.name).join(", ")}; build: ${input.scout.buildSystem ?? "unknown"}`
			: "",
		input.brief?.ruledOut.length ? `Already ruled out: ${input.brief.ruledOut.join("; ")}` : "",
		input.brief?.failingChecks.length
			? `Still failing: ${input.brief.failingChecks.map((check) => `${check.name} (${check.reason})`).join("; ")}`
			: "",
		`Return exactly ${input.count} approaches.`,
	]
		.filter((line) => line.length > 0)
		.join("\n");
	try {
		const answer = await input.ai.call("strategist", `${PLAN_PROMPT}\n\n${context}`);
		const json = answer.text.slice(answer.text.indexOf("{"), answer.text.lastIndexOf("}") + 1);
		const parsed = JSON.parse(json) as { approaches?: Array<Partial<Approach>> };
		const approaches = (parsed.approaches ?? [])
			.filter(
				(approach): approach is Approach =>
					typeof approach.title === "string" && typeof approach.hypothesis === "string",
			)
			.map((approach) => ({
				title: approach.title,
				hypothesis: approach.hypothesis,
				risks: Array.isArray(approach.risks) ? approach.risks.slice(0, 4) : [],
			}))
			.slice(0, input.count);
		if (approaches.length === 0) throw new Error("no approaches");
		while (approaches.length < input.count)
			approaches.push(heuristicApproaches(1, input.round + approaches.length)[0]);
		return { approaches, source: "model" };
	} catch {
		return { approaches: heuristicApproaches(input.count, input.round), source: "heuristic" };
	}
}
