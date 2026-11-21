// @bedrock/core: the Reflector. Turns a finished mission into guarded playbook deltas.
//
// Only additive deltas are proposed, scoped to the repository, and every lesson
// is attributed to the mission it came from. The reflector cannot touch the gate,
// the verifier or the integrity rules; those are immutable to refinement.

import type { Ai } from "@bedrock/ai";
import type { PlaybookDelta } from "@bedrock/memory";
import type { FinalState, RefineBrief } from "@bedrock/protocol";

const REFLECT_PROMPT = `You extract reusable lessons from a finished software task, for future tasks in the same repository.
A good lesson is concrete, checkable and not obvious: a command that must be run a certain way, a file that owns a behavior, a trap that wasted time.
Do not restate the task. Do not give generic advice ("write tests", "read the code").
Answer with JSON only: {"lessons":[{"trigger":"when this applies, 3-8 words","content":"the lesson, one or two sentences"}]} with at most 3 lessons, or {"lessons":[]}.`;

export interface ReflectInput {
	ai: Ai;
	goal: string;
	finalState: FinalState;
	scope: string;
	missionId: string;
	briefs: RefineBrief[];
	workerSummaries: string[];
}

/** Proposes up to three `add` deltas. Returns [] on any failure. */
export async function reflect(input: ReflectInput): Promise<PlaybookDelta[]> {
	const failures = input.briefs.flatMap((brief) =>
		brief.failingChecks.map((check) => `${check.name}: ${check.reason}`),
	);
	const ruledOut = input.briefs.flatMap((brief) => brief.ruledOut);
	const context = [
		`Task: ${input.goal}`,
		`Outcome: ${input.finalState}`,
		input.workerSummaries.length
			? `Worker reports:\n${input.workerSummaries.map((line) => `- ${line}`).join("\n")}`
			: "",
		failures.length ? `Failing checks seen:\n${failures.map((line) => `- ${line}`).join("\n")}` : "",
		ruledOut.length ? `Ruled out:\n${ruledOut.map((line) => `- ${line}`).join("\n")}` : "",
	]
		.filter((line) => line.length > 0)
		.join("\n\n");
	try {
		const answer = await input.ai.call("reflector", `${REFLECT_PROMPT}\n\n${context}`, { maxTokens: 800 });
		const json = answer.text.slice(answer.text.indexOf("{"), answer.text.lastIndexOf("}") + 1);
		const parsed = JSON.parse(json) as { lessons?: Array<{ trigger?: string; content?: string }> };
		return (parsed.lessons ?? [])
			.filter(
				(lesson) =>
					typeof lesson.trigger === "string" && typeof lesson.content === "string" && lesson.content.length > 10,
			)
			.slice(0, 3)
			.map((lesson) => ({
				kind: "add" as const,
				scope: input.scope,
				trigger: lesson.trigger as string,
				content: lesson.content as string,
				sourceMission: input.missionId,
			}));
	} catch {
		return [];
	}
}
