import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BedrockEvent, createId } from "@bedrock/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { Daemon, DaemonClient, readSessionLog, recoverSessions, SessionRegistry } from "../src/index.ts";

const dirs: string[] = [];
function temp(): string {
	const dir = mkdtempSync(join(tmpdir(), "bedrock-daemon-"));
	dirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const missionId = createId("mission");

function startEvent(): BedrockEvent {
	return { type: "mission_start", missionId, goal: "g", workspace: "/w", at: "2026-01-01T00:00:00.000Z" };
}

describe("SessionRegistry", () => {
	it("persists sessions atomically and reloads them", () => {
		const dir = temp();
		const registry = new SessionRegistry(dir);
		const sessionId = createId("session");
		registry.upsert({
			sessionId,
			missionId,
			workspace: "/w",
			state: "running",
			startedAt: "t",
			updatedAt: "t",
			lastEventSeq: 0,
			costUsd: 0,
		});
		const reloaded = new SessionRegistry(dir);
		expect(reloaded.get(sessionId)?.state).toBe("running");
		expect(reloaded.list()).toHaveLength(1);
	});
});

describe("recovery", () => {
	it("detects an interrupted session and counts its events", () => {
		const dir = temp();
		const sessionId = createId("session");
		mkdirSync(join(dir, "sessions"), { recursive: true });
		const lines = [
			{ seq: 1, sessionId, at: "t", event: startEvent() },
			{ seq: 2, sessionId, at: "t", event: { type: "mission_phase", missionId, phase: "execute", at: "t" } },
		];
		writeFileSync(
			join(dir, "sessions", `${sessionId}.jsonl`),
			`${lines.map((line) => JSON.stringify(line)).join("\n")}\n{ torn`,
		);
		const recovered = recoverSessions(dir);
		expect(recovered).toHaveLength(1);
		expect(recovered[0].interrupted).toBe(true);
		expect(recovered[0].events).toBe(2);
		expect(recovered[0].lastPhase).toBe("execute");
	});

	it("treats a finished session as not interrupted", () => {
		const dir = temp();
		const sessionId = createId("session");
		mkdirSync(join(dir, "sessions"), { recursive: true });
		const proof = {
			missionId,
			finalState: "passed",
			summary: "ok",
			diffStat: { files: 0, additions: 0, deletions: 0 },
			evidence: [],
			unverified: [],
			risks: [],
			checkpoints: [],
			cost: { usd: 0, tokens: 0, wallClockMs: 0 },
			createdAt: "t",
		};
		const events = [startEvent(), { type: "mission_finish", missionId, finalState: "passed", proof, at: "t" }];
		writeFileSync(
			join(dir, "sessions", `${sessionId}.jsonl`),
			`${events.map((event, index) => JSON.stringify({ seq: index + 1, sessionId, at: "t", event })).join("\n")}\n`,
		);
		expect(recoverSessions(dir)[0].interrupted).toBe(false);
		expect(readSessionLog(join(dir, "sessions", `${sessionId}.jsonl`))).toHaveLength(2);
	});
});

describe("Daemon over a socket", () => {
	it("answers status, attaches, replays and fans out events", async () => {
		const dir = temp();
		const daemon = new Daemon({ stateDir: dir, socketPath: join(dir, "d.sock") });
		await daemon.start();
		const client = new DaemonClient(join(dir, "d.sock"));
		try {
			await client.connect();
			const status = await client.status();
			expect(status).toMatchObject({ type: "status", ok: true, sessions: 0 });

			const sessionId = createId("session");
			const received: string[] = [];
			const messages: string[] = [];
			client.onEvent((event) => received.push(event.type));
			client.onMessage((message) => messages.push(message.type));
			client.send({ type: "attach", sessionId });
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(messages).toContain("attached");

			daemon.emitEvent(sessionId, startEvent());
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(received).toContain("mission_start");

			client.send({ type: "replay", sessionId });
			await new Promise((resolve) => setTimeout(resolve, 50));
			const replay = messages.includes("replay");
			expect(replay).toBe(true);

			const steered: string[] = [];
			daemon.on("steer", (_session: string, text: string) => steered.push(text));
			client.send({ type: "steer", sessionId, text: "try the other approach" });
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(steered).toEqual(["try the other approach"]);
		} finally {
			client.close();
			await daemon.stop();
		}
	});

	it("reports unknown sessions instead of pretending", async () => {
		const dir = temp();
		const daemon = new Daemon({ stateDir: dir, socketPath: join(dir, "d.sock") });
		await daemon.start();
		const client = new DaemonClient(join(dir, "d.sock"));
		try {
			await client.connect();
			const seen: string[] = [];
			client.onMessage((message) => {
				if (message.type === "error") seen.push(message.message);
			});
			client.send({ type: "kill", sessionId: "ses_missing" });
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(seen[0]).toContain("unknown session");
		} finally {
			client.close();
			await daemon.stop();
		}
	});
});
