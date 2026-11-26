// @bedrock/core: quick mode. A plain, persistent agent loop with Bedrock's tools.
//
// No gate, no rounds: one conversation the human keeps typing into. It still
// uses hashline edits, the sandbox, evidence-friendly tools and the same event
// stream as missions, so the TUI renders both the same way.

import type { Ai } from "@bedrock/ai";
import type { ArtifactStore } from "@bedrock/context";
import { type BedrockEvent, createId, type Id } from "@bedrock/protocol";
import type { Sandbox } from "@bedrock/sandbox";
import { createTools, type EditTool, type ToolContext } from "@bedrock/tools";
import { Agent } from "@earendil-works/pi-agent-core";
import { forwardWorkerEvent } from "./mission.ts";
import { toWorkerEvent } from "./worker.ts";

export const QUICK_SYSTEM_PROMPT = [
	"You are Bedrock in quick mode: a careful coding agent working directly in the user's workspace.",
	"Make the smallest change that solves the request. Read before you edit: reads return tagged lines and edit patches must carry the tag; a stale tag is rejected, so re-read and retry.",
	"After changing code, run the command that proves it (tests, build, or the reproduction) and report its exit code. Never claim a command passed unless you ran it.",
	"Keep answers short. When you are done, say what changed, what you ran, and anything you could not verify.",
].join("\n");

export interface QuickSessionOptions {
	ai: Ai;
	workspace: string;
	sandbox: Sandbox;
	artifacts: ArtifactStore;
	onEvent: (event: BedrockEvent) => void;
	ask?: ToolContext["ask"];
	onPermission?: ToolContext["onPermission"];
	systemPrompt?: string;
	edits?: EditTool[];
}

/** A multi-turn quick-mode conversation. */
export class QuickSession {
	readonly agent: Agent;
	readonly missionId: Id<"mission"> = createId("mission");
	readonly workerId: Id<"worker"> = createId("worker");
	#args = new Map<string, unknown>();
	#options: QuickSessionOptions;

	constructor(options: QuickSessionOptions) {
		this.#options = options;
		const resolved = options.ai.resolve("worker");
		const tools = createTools(
			{
				workspace: options.workspace,
				sandbox: options.sandbox,
				artifacts: options.artifacts,
				todos: [],
				ask: options.ask,
				onPermission: options.onPermission,
			},
			{ edits: options.edits },
		);
		this.agent = new Agent({
			initialState: {
				systemPrompt: options.systemPrompt ?? QUICK_SYSTEM_PROMPT,
				model: resolved.model,
				thinkingLevel: resolved.effort === "off" ? "off" : (resolved.effort as "low" | "medium" | "high"),
				tools,
			},
			streamFn: options.ai.models.streamSimple.bind(options.ai.models),
		});
		this.agent.subscribe((event) => {
			if (event.type === "message_end" && event.message.role === "assistant")
				options.ai.cost.add("worker", event.message.usage);
			const mapped = toWorkerEvent(event);
			if (!mapped) return;
			if (mapped.type === "tool_start") this.#args.set(mapped.toolCallId, mapped.args);
			forwardWorkerEvent(mapped, this.workerId, this.#args, options.onEvent, this.missionId);
		});
	}

	get busy(): boolean {
		return this.agent.state.isStreaming;
	}

	/** Sends a message: a new prompt when idle, steering when a turn is running. */
	async send(text: string): Promise<void> {
		if (this.busy) {
			this.agent.steer({ role: "user", content: text, timestamp: Date.now() });
			return;
		}
		this.#options.onEvent({
			type: "notice",
			missionId: this.missionId,
			level: "info",
			text: `you: ${text}`,
			at: new Date().toISOString(),
		});
		await this.agent.prompt(text);
	}

	abort(): void {
		this.agent.abort();
	}
}
