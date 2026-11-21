// @bedrock/core: keeping long worker contexts usable without losing the record.
//
// Observation masking: old tool results are the bulk of a long context and the
// least useful part of it. Once the transcript passes a budget, results older
// than the last few turns are replaced with a one-line stub that says what was
// elided and how to get it back. Reasoning and tool calls stay intact, and the
// full outputs remain in the event log and artifact store, so nothing is lost:
// the prompt holds a view of state, not all of it.

import type { AgentMessage } from "@earendil-works/pi-agent-core";

export interface MaskOptions {
	/** Approximate token budget for the whole transcript. */
	maxTokens: number;
	/** Tool results from this many most recent tool-result messages are never masked. */
	keepRecent?: number;
}

/** Cheap token estimate: four characters per token, close enough to budget with. */
export function estimateTokens(messages: AgentMessage[]): number {
	let chars = 0;
	for (const message of messages) chars += JSON.stringify(message).length;
	return Math.ceil(chars / 4);
}

/**
 * Masks the oldest tool results until the estimate fits the budget. Returns the
 * original array when nothing needs masking, so callers can detect a no-op.
 */
export function maskOldObservations(messages: AgentMessage[], options: MaskOptions): AgentMessage[] {
	if (estimateTokens(messages) <= options.maxTokens) return messages;
	const keepRecent = options.keepRecent ?? 6;
	const resultIndexes: number[] = [];
	messages.forEach((message, index) => {
		if ("role" in message && message.role === "toolResult") resultIndexes.push(index);
	});
	const maskable = resultIndexes.slice(0, Math.max(0, resultIndexes.length - keepRecent));
	const next = [...messages];
	for (const index of maskable) {
		const message = next[index];
		if (!("role" in message) || message.role !== "toolResult") continue;
		const text = message.content
			.filter((part) => part.type === "text")
			.map((part) => (part as { text: string }).text)
			.join("\n");
		if (text.length < 400) continue;
		const firstLine = text.split("\n")[0]?.slice(0, 160) ?? "";
		next[index] = {
			...message,
			content: [
				{
					type: "text",
					text: `[output elided to save context: ${text.length} chars. First line: ${firstLine}. Re-run the command or re-read the file if you need it again.]`,
				},
			],
		};
		if (estimateTokens(next) <= options.maxTokens) break;
	}
	return next;
}
