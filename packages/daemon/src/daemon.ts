// @bedrock/daemon: bedrockd. Session ownership over a local socket.
//
// Clients (the TUI, the CLI, CI) attach to a daemon rather than owning a mission
// directly, so a terminal can close without killing the work and a crashed
// client reconnects to the live stream. Messages are newline-delimited JSON.

import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { EventLog } from "@bedrock/context";
import type { BedrockEvent, Id } from "@bedrock/protocol";
import { type RecoveredSession, reconcileRegistry, type SessionRecord, SessionRegistry } from "./recovery.ts";

export type DaemonCommand =
	| { type: "status" }
	| { type: "list" }
	| { type: "attach"; sessionId: string }
	| { type: "detach"; sessionId: string }
	| { type: "steer"; sessionId: string; text: string }
	| { type: "pause"; sessionId: string }
	| { type: "resume"; sessionId: string }
	| { type: "kill"; sessionId: string }
	| { type: "replay"; sessionId: string; fromSeq?: number };

export type DaemonMessage =
	| { type: "status"; ok: true; sessions: number; recovered: RecoveredSession[]; pid: number }
	| { type: "list"; ok: true; sessions: SessionRecord[] }
	| { type: "attached"; ok: true; sessionId: string; events: number }
	| { type: "ack"; ok: true; command: DaemonCommand["type"] }
	| { type: "replay"; ok: true; sessionId: string; events: Array<{ seq: number; event: BedrockEvent; at: string }> }
	| { type: "event"; sessionId: string; event: BedrockEvent; seq: number; at: string }
	| { type: "error"; ok: false; message: string };

interface Client {
	socket: Socket;
	attached: Set<string>;
	buffer: string;
}

export interface DaemonOptions {
	/** Directory holding session logs, ledger and registry. */
	stateDir: string;
	/** Socket path. Defaults to `<stateDir>/bedrockd.sock`. */
	socketPath?: string;
	/** Heartbeat period; 0 disables it (tests use a short period). */
	heartbeatMs?: number;
}

/**
 * The daemon. It owns the live event fan-out and the on-disk session state; it
 * does not run missions itself in this build (the CLI does), which keeps crash
 * recovery honest: whatever the log says is what happened.
 */
export class Daemon extends EventEmitter {
	readonly stateDir: string;
	readonly socketPath: string;
	readonly registry: SessionRegistry;
	readonly recovered: RecoveredSession[];
	#server?: Server;
	#clients = new Set<Client>();
	#logs = new Map<string, EventLog>();
	#heartbeat?: ReturnType<typeof setInterval>;

	constructor(options: DaemonOptions) {
		super();
		this.stateDir = options.stateDir;
		this.socketPath = options.socketPath ?? join(options.stateDir, "bedrockd.sock");
		this.registry = new SessionRegistry(this.stateDir);
		this.recovered = reconcileRegistry(this.registry, this.stateDir);
	}

	/** Starts listening. Removes a stale socket file left by a crash. */
	async start(): Promise<void> {
		if (this.#server) return;
		mkdirSync(dirname(this.socketPath), { recursive: true });
		if (existsSync(this.socketPath)) unlinkSync(this.socketPath);
		const server = createServer((socket) => this.#accept(socket));
		this.#server = server;
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(this.socketPath, () => {
				server.off("error", reject);
				resolve();
			});
		});
	}

	/** Stops the server and closes every client. */
	async stop(): Promise<void> {
		if (this.#heartbeat) clearInterval(this.#heartbeat);
		this.#heartbeat = undefined;
		for (const client of this.#clients) client.socket.destroy();
		this.#clients.clear();
		const server = this.#server;
		this.#server = undefined;
		if (server) {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
		if (existsSync(this.socketPath)) unlinkSync(this.socketPath);
	}

	/** Starts periodic heartbeats that clients can use to detect a stalled mission. */
	startHeartbeats(fn: () => BedrockEvent, intervalMs = 15_000): void {
		if (this.#heartbeat) clearInterval(this.#heartbeat);
		this.#heartbeat = setInterval(() => this.broadcast(fn()), intervalMs);
		this.#heartbeat.unref?.();
	}

	/** Records a session in the registry (called when a mission starts). */
	register(record: SessionRecord): SessionRecord {
		return this.registry.upsert(record);
	}

	/** The event log for a session, creating it if needed. */
	logFor(sessionId: string, workspace = ""): EventLog {
		const existing = this.#logs.get(sessionId);
		if (existing) return existing;
		const path = join(this.stateDir, "sessions", `${sessionId}.jsonl`);
		const log = new EventLog({ sessionId: sessionId as Id<"session">, path, resume: true });
		this.#logs.set(sessionId, log);
		this.registry.update(sessionId, { workspace, lastEventSeq: log.length });
		return log;
	}

	/** Appends an event to a session log and fans it out to attached clients. */
	emitEvent(sessionId: string, event: BedrockEvent): void {
		const log = this.logFor(sessionId);
		const record = log.append(event);
		this.registry.update(sessionId, { lastEventSeq: record.seq });
		this.broadcast(event, sessionId);
	}

	/** Sends an event to every client attached to `sessionId`, or to all clients. */
	broadcast(event: BedrockEvent, sessionId?: string): void {
		const message = sessionId
			? ({ type: "event", sessionId, event, seq: 0, at: new Date().toISOString() } satisfies DaemonMessage)
			: ({ type: "event", sessionId: "", event, seq: 0, at: new Date().toISOString() } satisfies DaemonMessage);
		for (const client of this.#clients) {
			if (sessionId && !client.attached.has(sessionId)) continue;
			this.#write(client, message);
		}
		this.emit("event", event);
	}

	#accept(socket: Socket): void {
		const client: Client = { socket, attached: new Set(), buffer: "" };
		this.#clients.add(client);
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => {
			client.buffer += chunk;
			let newline = client.buffer.indexOf("\n");
			while (newline >= 0) {
				const line = client.buffer.slice(0, newline).trim();
				client.buffer = client.buffer.slice(newline + 1);
				if (line.length > 0) this.#handle(client, line);
				newline = client.buffer.indexOf("\n");
			}
		});
		socket.on("close", () => this.#clients.delete(client));
		socket.on("error", () => this.#clients.delete(client));
	}

	#handle(client: Client, line: string): void {
		let command: DaemonCommand;
		try {
			command = JSON.parse(line) as DaemonCommand;
		} catch {
			this.#write(client, { type: "error", ok: false, message: "invalid JSON" });
			return;
		}
		switch (command.type) {
			case "status":
				this.#write(client, {
					type: "status",
					ok: true,
					sessions: this.registry.list().length,
					recovered: this.recovered,
					pid: process.pid,
				});
				break;
			case "list":
				this.#write(client, { type: "list", ok: true, sessions: this.registry.list() });
				break;
			case "attach": {
				client.attached.add(command.sessionId);
				const log = this.logFor(command.sessionId);
				this.#write(client, { type: "attached", ok: true, sessionId: command.sessionId, events: log.length });
				break;
			}
			case "detach":
				client.attached.delete(command.sessionId);
				this.#write(client, { type: "ack", ok: true, command: "detach" });
				break;
			case "replay": {
				const log = this.logFor(command.sessionId);
				const events = log
					.all()
					.filter((record) => record.seq > (command.fromSeq ?? 0))
					.map((record) => ({ seq: record.seq, event: record.event, at: record.at }));
				this.#write(client, { type: "replay", ok: true, sessionId: command.sessionId, events });
				break;
			}
			case "steer":
				this.registry.update(command.sessionId, { updatedAt: new Date().toISOString() });
				this.emit("steer", command.sessionId, command.text);
				this.#write(client, { type: "ack", ok: true, command: "steer" });
				break;
			case "pause":
			case "resume":
			case "kill": {
				const state = command.type === "pause" ? "paused" : command.type === "resume" ? "running" : "crashed";
				if (!this.registry.update(command.sessionId, { state })) {
					this.#write(client, { type: "error", ok: false, message: `unknown session ${command.sessionId}` });
					break;
				}
				this.emit(command.type, command.sessionId);
				this.#write(client, { type: "ack", ok: true, command: command.type });
				break;
			}
			default:
				this.#write(client, {
					type: "error",
					ok: false,
					message: `unknown command ${(command as { type: string }).type}`,
				});
		}
	}

	#write(client: Client, message: DaemonMessage): void {
		if (client.socket.destroyed) return;
		client.socket.write(`${JSON.stringify(message)}\n`);
	}
}
