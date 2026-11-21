// @bedrock/core: the Advisor. A second model with a fresh context reads each turn
// and injects short notes: an aside, a concern, or a blocker.
//
// The advisor never acts; it only speaks into the worker's next turn. It sees a
// compact digest of recent turns rather than the whole transcript, which keeps it
// cheap and keeps its judgment independent of the worker's framing.

import type { Ai } from "@bedrock/ai";
import type { AdvisorTag, Gate } from "@bedrock/protocol";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

export interface AdvisorVerdict {
	tag: AdvisorTag;
	text: string;
}

const ADVISOR_PROMPT = `You watch another engineer work on a task and give at most one short note.
Flag only things that matter: a misread error, a test being edited or skipped to pass, a repeated failing approach, a claim with no evidence, a change outside the task's scope, an easier path being missed.
Answer with JSON only: {"tag":"none"|"aside"|"concern"|"blocker","text":"one or two sentences"}.
Use "blocker" only when continuing would very likely waste the attempt or game the checks. Use "none" when the work looks sound.`;

/** Renders the last few messages as a compact digest the advisor can read quickly. */
export function digestMessages(messages: AgentMessage[], limit = 8, maxChars = 6000): string {
	const parts: string[] = [];
	for (const message of messages.slice(-limit)) {
		if (!("role" in message)) continue;
		if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type === "text" && block.text.trim()) parts.push(`worker: ${block.text.trim()}`);
				if (block.type === "toolCall")
					parts.push(`worker calls ${block.name} ${JSON.stringify(block.arguments).slice(0, 400)}`);
			}
		} else if (message.role === "toolResult") {
			const text = message.content
				.filter((part) => part.type === "text")
				.map((part) => (part as { text: string }).text)
				.join("\n");
			parts.push(`${message.isError ? "tool error" : "tool result"} (${message.toolName}): ${text.slice(0, 800)}`);
		} else if (message.role === "user") {
			const text =
				typeof message.content === "string"
					? message.content
					: message.content.map((part) => ("text" in part ? part.text : "")).join("");
			parts.push(`user: ${text.slice(0, 600)}`);
		}
	}
	const digest = parts.join("\n");
	return digest.length > maxChars ? digest.slice(-maxChars) : digest;
}

/** Asks the advisor role about recent turns. Returns undefined for "none" or any failure. */
export async function advise(input: {
	ai: Ai;
	goal: string;
	gate: Gate;
	messages: AgentMessage[];
}): Promise<AdvisorVerdict | undefined> {
	const checks = input.gate.checks.filter((check) => check.visibility === "visible").map((check) => check.command);
	const prompt = `${ADVISOR_PROMPT}\n\nTask: ${input.goal}\nChecks: ${checks.join("; ") || "none"}\n\nRecent work:\n${digestMessages(input.messages)}`;
	try {
		const answer = await input.ai.call("advisor", prompt, { maxTokens: 400 });
		const json = answer.text.slice(answer.text.indexOf("{"), answer.text.lastIndexOf("}") + 1);
		const parsed = JSON.parse(json) as { tag?: string; text?: string };
		if (parsed.tag !== "aside" && parsed.tag !== "concern" && parsed.tag !== "blocker") return undefined;
		const text = (parsed.text ?? "").trim();
		return text.length > 0 ? { tag: parsed.tag, text } : undefined;
	} catch {
		return undefined;
	}
}
