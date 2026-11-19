// @bedrock/context: the session event log. Append-only, replayable, branchable.
//
// The log is the durable record of a mission. The TUI renders it, the daemon
// replays it after a crash, and the lab scores from it. Each session writes one
// JSONL file; branching stores the sequence number of the fork point rather than
// copying history.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { BedrockEvent, BedrockEventType, EventFilter, Id, LoggedEvent, Timestamp } from "@bedrock/protocol";

export interface EventLogOptions {
	sessionId: Id<"session">;
	/** File to append to. Omit for an in-memory log (tests, subagent scratchpads). */
	path?: string;
	/** Load an existing file into memory on construction (crash recovery). */
	resume?: boolean;
}

export class EventLog {
	readonly sessionId: Id<"session">;
	readonly path?: string;
	#events: LoggedEvent[] = [];
	#listeners = new Set<(event: LoggedEvent) => void>();
	#leaf = 0;

	constructor(options: EventLogOptions) {
		this.sessionId = options.sessionId;
		this.path = options.path;
		if (options.path && options.resume && existsSync(options.path)) {
			for (const line of readFileSync(options.path, "utf8").split("\n")) {
				if (line.trim().length === 0) continue;
				try {
					this.#events.push(JSON.parse(line) as LoggedEvent);
				} catch {
					// A torn last line after a crash is dropped; everything before it replays.
				}
			}
			this.#leaf = this.#events.at(-1)?.seq ?? 0;
		}
	}

	/** Appends one event, persists it, and notifies subscribers. Returns the numbered record. */
	append(event: BedrockEvent, at: Timestamp = new Date().toISOString()): LoggedEvent {
		const record: LoggedEvent = { seq: this.#events.length + 1, sessionId: this.sessionId, event, at };
		this.#events.push(record);
		this.#leaf = record.seq;
		if (this.path) {
			mkdirSync(dirname(this.path), { recursive: true });
			appendFileSync(this.path, `${JSON.stringify(record)}\n`, "utf8");
		}
		for (const listener of this.#listeners) listener(record);
		return record;
	}

	/** Subscribes to new events. Returns an unsubscribe function. */
	subscribe(listener: (event: LoggedEvent) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/** Every record, oldest first. */
	all(): LoggedEvent[] {
		return [...this.#events];
	}

	/** Records matching a filter. */
	filter(filter: EventFilter): LoggedEvent[] {
		const types = filter.types ? new Set<BedrockEventType>(filter.types) : undefined;
		return this.#events.filter((record) => {
			if (filter.missionId && eventMission(record.event) !== filter.missionId) return false;
			if (types && !types.has(record.event.type)) return false;
			return true;
		});
	}

	byMission(missionId: Id<"mission">): LoggedEvent[] {
		return this.filter({ missionId });
	}

	/** The current leaf: the newest event, or the point a branch was taken from. */
	get leaf(): number {
		return this.#leaf;
	}

	/** Rewinds the leaf without deleting history. Events after it stay queryable. */
	rewindTo(seq: number): void {
		if (seq < 0 || seq > this.#events.length)
			throw new Error(`cannot rewind to ${seq}; log has ${this.#events.length} events`);
		this.#leaf = seq;
	}

	/**
	 * Starts a branch at the current leaf in a new session file. The returned log
	 * is empty and carries a `notice` event pointing at the parent sequence, so a
	 * reader can reconstruct the lineage.
	 */
	branch(sessionId: Id<"session">, path?: string, missionId?: Id<"mission">): EventLog {
		const log = new EventLog({ sessionId, path });
		const parent = this.#events[this.#leaf - 1];
		if (parent && missionId) {
			log.append({
				type: "notice",
				missionId,
				level: "info",
				text: `branched from ${this.sessionId} at event ${parent.seq}`,
				at: new Date().toISOString(),
			});
		}
		return log;
	}

	/** Writes the whole log to a new path (used by lab trace export). */
	writeTo(path: string): void {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(
			path,
			this.#events.map((record) => JSON.stringify(record)).join("\n") + (this.#events.length > 0 ? "\n" : ""),
			"utf8",
		);
	}

	get length(): number {
		return this.#events.length;
	}
}

function eventMission(event: BedrockEvent): Id<"mission"> | undefined {
	return "missionId" in event ? event.missionId : undefined;
}
