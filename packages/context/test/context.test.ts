import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createId, defaultConfig, type Gate, type Mission } from "@bedrock/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactStore, assemblePrompt, EventLog, truncateOutput } from "../src/index.ts";

const dirs: string[] = [];
function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "bedrock-context-"));
	dirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const missionId = createId("mission");

function mission(): Mission {
	return {
		id: missionId,
		spec: { goal: "port the parser to Rust", mode: "run", budget: { usd: 20 }, isolation: "worktree" },
		status: "running",
		phase: "execute",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		workspace: "/work/repo",
		baseTree: "0123456789abcdef",
	};
}

describe("EventLog", () => {
	it("numbers events, persists them and replays them", () => {
		const dir = tempDir();
		const path = join(dir, "events.jsonl");
		const log = new EventLog({ sessionId: createId("session"), path });
		log.append({ type: "mission_start", missionId, goal: "g", workspace: "/w", at: "2026-01-01T00:00:00.000Z" });
		log.append({
			type: "worker_turn",
			missionId,
			workerId: createId("worker"),
			turn: 1,
			at: "2026-01-01T00:00:01.000Z",
		});
		expect(log.length).toBe(2);

		const replayed = new EventLog({ sessionId: createId("session"), path, resume: true });
		expect(replayed.all()).toHaveLength(2);
		expect(replayed.all()[1].event.type).toBe("worker_turn");
		expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(2);
	});

	it("filters by mission and type", () => {
		const log = new EventLog({ sessionId: createId("session") });
		const other = createId("mission");
		log.append({ type: "mission_start", missionId, goal: "g", workspace: "/w", at: "t" });
		log.append({ type: "mission_start", missionId: other, goal: "g", workspace: "/w", at: "t" });
		log.append({
			type: "heartbeat",
			missionId,
			heartbeat: { workerId: createId("worker"), at: "t", lastAction: "read", turns: 1, costUsd: 0 },
			at: "t",
		} as never);
		expect(log.byMission(missionId)).toHaveLength(2);
		expect(log.filter({ types: ["mission_start"] })).toHaveLength(2);
		expect(log.filter({ missionId, types: ["heartbeat"] })).toHaveLength(1);
	});

	it("rewinds without deleting and branches from the leaf", () => {
		const log = new EventLog({ sessionId: createId("session") });
		log.append({ type: "mission_start", missionId, goal: "g", workspace: "/w", at: "t" });
		log.append({ type: "mission_phase", missionId, phase: "execute", at: "t" });
		log.rewindTo(1);
		expect(log.leaf).toBe(1);
		expect(log.length).toBe(2);
		const branch = log.branch(createId("session"), undefined, missionId);
		expect(branch.length).toBe(1);
		expect(branch.all()[0].event.type).toBe("notice");
		expect(() => log.rewindTo(99)).toThrow();
	});

	it("notifies subscribers and unsubscribes", () => {
		const log = new EventLog({ sessionId: createId("session") });
		const seen: string[] = [];
		const unsubscribe = log.subscribe((record) => seen.push(record.event.type));
		log.append({ type: "mission_start", missionId, goal: "g", workspace: "/w", at: "t" });
		unsubscribe();
		log.append({ type: "mission_phase", missionId, phase: "scout", at: "t" });
		expect(seen).toEqual(["mission_start"]);
	});
});

describe("truncateOutput", () => {
	it("passes small output through unchanged", () => {
		const result = truncateOutput("hello\nworld");
		expect(result.truncated).toBe(false);
		expect(result.text).toBe("hello\nworld");
	});

	it("keeps head and tail with an explicit note for large output", () => {
		const lines = Array.from({ length: 1000 }, (_, index) => `line ${index}`);
		const result = truncateOutput(lines.join("\n"), { maxLines: 100, headLines: 10, tailLines: 10 });
		expect(result.truncated).toBe(true);
		expect(result.text).toContain("line 0\n");
		expect(result.text).toContain("line 999");
		expect(result.text).toContain("980 lines");
		expect(result.text).toContain("artifact");
		expect(result.omittedLines).toBe(980);
	});

	it("truncates by bytes even when line count is small", () => {
		const result = truncateOutput("x".repeat(100_000), { maxBytes: 1000, headLines: 1, tailLines: 1 });
		expect(result.truncated).toBe(true);
	});
});

describe("ArtifactStore", () => {
	it("stores content by hash and deduplicates", () => {
		const dir = tempDir();
		const store = new ArtifactStore({ kind: "file", root: dir });
		const first = store.put("test output\n");
		const second = store.put("test output\n");
		expect(first.id).toBe(second.id);
		expect(first.path).toBe(second.path);
		expect(store.get(first.hash)).toBe("test output\n");
	});

	it("works in memory", () => {
		const store = new ArtifactStore({ kind: "memory" });
		const stored = store.put('{"a":1}', "application/json");
		expect(store.get(stored.hash)).toBe('{"a":1}');
	});
});

describe("assemblePrompt", () => {
	it("puts the system prompt first and omits absent sections", () => {
		const prompt = assemblePrompt({
			system: "You are Bedrock.",
			mission: mission(),
			ledger: [],
			instruction: "start",
		});
		expect(prompt.startsWith("## System\nYou are Bedrock.")).toBe(true);
		expect(prompt).toContain("## Mission");
		expect(prompt).not.toContain("## Gate");
		expect(prompt.endsWith("## Instruction\nstart")).toBe(true);
	});

	it("summarizes the gate, hiding holdout details but not their existence", () => {
		const gate: Gate = {
			id: createId("gate"),
			missionId,
			version: 1,
			origin: "compiled",
			createdAt: "t",
			checks: [
				{
					id: createId("check"),
					name: "build",
					kind: "build",
					command: "npm run build",
					expect: { kind: "exit_code", code: 0 },
					origin: "existing",
					visibility: "visible",
				},
				{
					id: createId("check"),
					name: "holdout-1",
					kind: "test",
					command: "npm test -- holdout",
					expect: { kind: "exit_code", code: 0 },
					origin: "holdout",
					visibility: "holdout",
				},
			],
			invariants: [],
			rubric: [{ id: "r1", criterion: "no public API change", weight: 1, severity: "blocker" }],
			integrity: {
				protectedPaths: [],
				justifyPaths: [],
				forbidHistoryMining: true,
				networkAllowlist: [],
				testGlobs: ["**/*.test.ts"],
			},
			userSupplied: [],
			approved: true,
		};
		const prompt = assemblePrompt({ system: "s", mission: mission(), gate, ledger: [], instruction: "go" });
		expect(prompt).toContain("npm run build");
		expect(prompt).not.toContain("npm test -- holdout");
		expect(prompt).toContain("1 holdout checks are hidden");
		expect(prompt).toContain("no public API change");
	});

	it("renders ledger entries with an evidence marker", () => {
		const entries = [
			{
				id: createId("entry"),
				missionId,
				kind: "fact" as const,
				author: "worker" as const,
				createdAt: "t",
				statement: "uses esbuild",
				confidence: "certain" as const,
				evidence: createId("entry"),
			},
			{
				id: createId("entry"),
				missionId,
				kind: "fact" as const,
				author: "worker" as const,
				createdAt: "t",
				statement: "cache is stale",
				confidence: "likely" as const,
			},
		];
		const prompt = assemblePrompt({ system: "s", mission: mission(), ledger: entries, instruction: "go" });
		expect(prompt).toContain("uses esbuild [evidenced]");
		expect(prompt).toContain("cache is stale [no evidence]");
	});

	it("is stable for the same input (prompt caching)", () => {
		const input = { system: "s", mission: mission(), ledger: [], instruction: "go" };
		expect(assemblePrompt(input)).toBe(assemblePrompt(input));
	});
});
