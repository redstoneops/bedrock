// @bedrock/daemon: the session registry and crash recovery.
//
// A session is durable once its event log exists on disk. The registry records
// what was running so that a restarted daemon can say precisely what was
// interrupted, rather than pretending the mission never happened.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BedrockEvent, Id, LoggedEvent, MissionPhase } from "@bedrock/protocol";

export type SessionState = "running" | "paused" | "finished" | "interrupted" | "crashed";

export interface SessionRecord {
	sessionId: Id<"session">;
	missionId?: Id<"mission">;
	goal?: string;
	workspace: string;
	state: SessionState;
	phase?: MissionPhase;
	startedAt: string;
	updatedAt: string;
	lastEventSeq: number;
	costUsd: number;
	pid?: number;
}

/**
 * File-backed registry of sessions under `<stateDir>/sessions/registry.json`.
 * Writes are atomic (write a temporary file, then rename) so a crash cannot
 * leave a half-written registry.
 */
export class SessionRegistry {
	readonly path: string;
	#sessions = new Map<string, SessionRecord>();

	constructor(stateDir: string) {
		this.path = join(stateDir, "sessions", "registry.json");
		if (existsSync(this.path)) {
			try {
				const parsed = JSON.parse(readFileSync(this.path, "utf8")) as SessionRecord[];
				for (const record of parsed) this.#sessions.set(record.sessionId, record);
			} catch {
				// A corrupted registry is rebuilt from event logs by `recover`.
			}
		}
	}

	upsert(record: SessionRecord): SessionRecord {
		this.#sessions.set(record.sessionId, { ...record, updatedAt: new Date().toISOString() });
		this.#flush();
		return record;
	}

	update(sessionId: string, patch: Partial<SessionRecord>): SessionRecord | undefined {
		const current = this.#sessions.get(sessionId);
		if (!current) return undefined;
		const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
		this.#sessions.set(sessionId, next);
		this.#flush();
		return next;
	}

	get(sessionId: string): SessionRecord | undefined {
		return this.#sessions.get(sessionId);
	}

	list(): SessionRecord[] {
		return [...this.#sessions.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	}

	remove(sessionId: string): void {
		this.#sessions.delete(sessionId);
		this.#flush();
	}

	#flush(): void {
		mkdirSync(join(this.path, ".."), { recursive: true });
		const temporary = `${this.path}.tmp`;
		writeFileSync(temporary, JSON.stringify(this.list(), null, 2), "utf8");
		writeFileSync(this.path, readFileSync(temporary, "utf8"), "utf8");
	}
}

export interface RecoveredSession {
	sessionId: Id<"session">;
	missionId?: Id<"mission">;
	events: number;
	lastPhase?: MissionPhase;
	lastEvent?: BedrockEvent["type"];
	/** True when the log says the mission was running and never finished. */
	interrupted: boolean;
	/** True when a kernel snapshot exists for the session. */
	hasKernelSnapshot: boolean;
}

/** Reads a session's JSONL log, tolerating a torn final line after a crash. */
export function readSessionLog(path: string): LoggedEvent[] {
	if (!existsSync(path)) return [];
	const records: LoggedEvent[] = [];
	for (const line of readFileSync(path, "utf8").split("\n")) {
		if (line.trim().length === 0) continue;
		try {
			records.push(JSON.parse(line) as LoggedEvent);
		} catch {
			// Torn last line: everything before it is still valid.
		}
	}
	return records;
}

/**
 * Rebuilds the state of every session from its event log. A session with a
 * `mission_start` and no `mission_finish` is interrupted: its verified progress
 * is exactly the events it recorded, and nothing more should be claimed.
 */
export function recoverSessions(stateDir: string): RecoveredSession[] {
	const sessionsDir = join(stateDir, "sessions");
	if (!existsSync(sessionsDir)) return [];
	const recovered: RecoveredSession[] = [];
	for (const name of readdirSync(sessionsDir)) {
		if (!name.endsWith(".jsonl")) continue;
		const sessionId = name.slice(0, -".jsonl".length) as Id<"session">;
		const records = readSessionLog(join(sessionsDir, name));
		if (records.length === 0) continue;
		let missionId: Id<"mission"> | undefined;
		let lastPhase: MissionPhase | undefined;
		let started = false;
		let finished = false;
		for (const record of records) {
			const event = record.event;
			if (event.type === "mission_start") {
				started = true;
				missionId = event.missionId;
			}
			if (event.type === "mission_phase") lastPhase = event.phase;
			if (event.type === "mission_finish") finished = true;
		}
		recovered.push({
			sessionId,
			missionId,
			events: records.length,
			lastPhase,
			lastEvent: records.at(-1)?.event.type,
			interrupted: started && !finished,
			hasKernelSnapshot: existsSync(join(stateDir, "sessions", `${sessionId}.kernel.pkl`)),
		});
	}
	return recovered;
}

/** Applies recovery to the registry: running sessions become interrupted. */
export function reconcileRegistry(registry: SessionRegistry, stateDir: string): RecoveredSession[] {
	const recovered = recoverSessions(stateDir);
	for (const session of recovered) {
		const record = registry.get(session.sessionId) ?? {
			sessionId: session.sessionId,
			missionId: session.missionId,
			workspace: "",
			state: "crashed" as SessionState,
			startedAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			lastEventSeq: 0,
			costUsd: 0,
		};
		const state: SessionState = session.interrupted
			? "interrupted"
			: record.state === "running"
				? "finished"
				: record.state;
		registry.upsert({
			...record,
			state,
			lastEventSeq: session.events,
			phase: session.lastPhase ?? record.phase,
			missionId: session.missionId ?? record.missionId,
		});
	}
	return recovered;
}
