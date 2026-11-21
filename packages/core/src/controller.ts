// @bedrock/core: live control of a running mission (steering and interrupts).
//
// Surfaces (TUI, daemon, RPC) hold a controller; the mission loop attaches each
// worker's agent to it. Steering typed before a worker exists is queued and
// delivered at the next turn boundary of the next worker, so nothing a human
// says is silently dropped.

import type { Agent } from "@earendil-works/pi-agent-core";

export class MissionController {
	#agents = new Set<Agent>();
	#queued: string[] = [];
	#cancelled = false;
	#abort = new AbortController();
	#listeners = new Set<(event: { type: "steer" | "cancel"; text?: string }) => void>();

	/** True once `cancel()` was called; the mission stops at the next safe point. */
	get cancelled(): boolean {
		return this.#cancelled;
	}

	/** Queues a steering message for every active worker (or the next one). */
	steer(text: string): void {
		const trimmed = text.trim();
		if (trimmed.length === 0) return;
		if (this.#agents.size > 0) for (const agent of this.#agents) this.#deliver(agent, trimmed);
		else this.#queued.push(trimmed);
		for (const listener of this.#listeners) listener({ type: "steer", text: trimmed });
	}

	/** Interrupts the active worker and stops the mission after the current step. */
	cancel(): void {
		this.#cancelled = true;
		this.#abort.abort();
		for (const agent of this.#agents) agent.abort();
		for (const listener of this.#listeners) listener({ type: "cancel" });
	}

	/** Called by the mission loop when a worker's agent starts. */
	attach(agent: Agent): void {
		this.#agents.add(agent);
		for (const text of this.#queued.splice(0)) this.#deliver(agent, text);
		if (this.#cancelled) agent.abort();
	}

	/** Called by the mission loop when a worker's agent finishes. */
	detach(agent: Agent): void {
		this.#agents.delete(agent);
	}

	/** Aborted on `cancel()`; pass it to long-running checks so Esc stops them too. */
	get signal(): AbortSignal {
		return this.#abort.signal;
	}

	/** Messages still waiting for a worker. */
	pending(): string[] {
		return [...this.#queued];
	}

	onChange(listener: (event: { type: "steer" | "cancel"; text?: string }) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	#deliver(agent: Agent, text: string): void {
		// Steering lands at the next turn boundary; pi-agent-core queues it for us.
		agent.steer({ role: "user", content: `[steer from the human] ${text}`, timestamp: Date.now() });
	}
}
