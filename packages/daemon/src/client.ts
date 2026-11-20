// @bedrock/daemon: a client for bedrockd.

import { connect, type Socket } from "node:net";
import type { BedrockEvent } from "@bedrock/protocol";
import type { DaemonCommand, DaemonMessage } from "./daemon.ts";

/** Connects to a daemon socket, sends commands, and delivers messages. */
export class DaemonClient {
	readonly socketPath: string;
	#socket?: Socket;
	#buffer = "";
	#listeners = new Set<(message: DaemonMessage) => void>();
	#events = new Set<(event: BedrockEvent, sessionId: string) => void>();

	constructor(socketPath: string) {
		this.socketPath = socketPath;
	}

	async connect(): Promise<void> {
		if (this.#socket) return;
		const socket = connect(this.socketPath);
		this.#socket = socket;
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => {
			this.#buffer += chunk;
			let newline = this.#buffer.indexOf("\n");
			while (newline >= 0) {
				const line = this.#buffer.slice(0, newline).trim();
				this.#buffer = this.#buffer.slice(newline + 1);
				if (line.length > 0) this.#dispatch(line);
				newline = this.#buffer.indexOf("\n");
			}
		});
		await new Promise<void>((resolve, reject) => {
			socket.once("connect", () => resolve());
			socket.once("error", reject);
		});
	}

	#dispatch(line: string): void {
		let message: DaemonMessage;
		try {
			message = JSON.parse(line) as DaemonMessage;
		} catch {
			return;
		}
		for (const listener of this.#listeners) listener(message);
		if (message.type === "event") for (const listener of this.#events) listener(message.event, message.sessionId);
	}

	send(command: DaemonCommand): void {
		if (!this.#socket) throw new Error("client is not connected");
		this.#socket.write(`${JSON.stringify(command)}\n`);
	}

	onMessage(listener: (message: DaemonMessage) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	onEvent(listener: (event: BedrockEvent, sessionId: string) => void): () => void {
		this.#events.add(listener);
		return () => this.#events.delete(listener);
	}

	/** Sends a status request and resolves with the reply. */
	async status(timeoutMs = 5000): Promise<DaemonMessage> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				unsubscribe();
				reject(new Error("daemon did not answer status"));
			}, timeoutMs);
			const unsubscribe = this.onMessage((message) => {
				if (message.type !== "status") return;
				clearTimeout(timer);
				unsubscribe();
				resolve(message);
			});
			this.send({ type: "status" });
		});
	}

	close(): void {
		this.#socket?.destroy();
		this.#socket = undefined;
	}
}
