import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createId, defaultConfig } from "@bedrock/protocol";
import { afterEach, describe, expect, it } from "vitest";
import {
	chestPaths,
	HarnessState,
	Playbook,
	readChest,
	recordDecision,
	recordFailure,
	recordProgress,
	writeChest,
} from "../src/index.ts";

const dirs: string[] = [];
function temp(): string {
	const dir = mkdtempSync(join(tmpdir(), "bedrock-memory-"));
	dirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Chest", () => {
	it("writes the recipe and plan, then appends progress, decisions and failures", () => {
		const dir = temp();
		const mission = {
			id: createId("mission"),
			spec: { goal: "fix the bug", mode: "run" as const, budget: {}, isolation: "worktree" as const },
			status: "running" as const,
			phase: "gate" as const,
			createdAt: "t",
			updatedAt: "t",
			workspace: dir,
			baseTree: "a",
		};
		const gate = {
			id: createId("gate"),
			missionId: mission.id,
			version: 1,
			origin: "compiled" as const,
			createdAt: "t",
			checks: [],
			invariants: [],
			rubric: [],
			integrity: {
				protectedPaths: [],
				justifyPaths: [],
				forbidHistoryMining: false,
				networkAllowlist: [],
				testGlobs: [],
			},
			userSupplied: [],
			approved: true,
		};
		const strategy = {
			id: createId("strategy"),
			missionId: mission.id,
			rootId: createId("strategy"),
			createdAt: "t",
			rationale: "one approach",
			nodes: {} as Record<string, never>,
		};
		strategy.nodes[strategy.rootId] = {
			id: strategy.rootId,
			title: "root",
			hypothesis: "h",
			risks: [],
			status: "running",
			children: [],
		} as never;
		writeChest(dir, { mission, gate, strategy });
		recordProgress(dir, "scouted the repo");
		recordDecision(dir, "keep the worktree", "isolation makes crashes cheap");
		recordFailure(dir, {
			failingChecks: [{ name: "test", reason: "exit 1" }],
			ruledOut: ["cache"],
			useful: ["esbuild"],
			nextSteps: [],
			sourceEntries: [],
		});
		const chest = readChest(dir);
		expect(chest.recipe?.mission.spec.goal).toBe("fix the bug");
		expect(chest.plan).toContain("## Approaches");
		expect(chest.progress).toContain("scouted the repo");
		expect(chest.decisions).toContain("isolation makes crashes cheap");
		expect(chest.failures).toContain("cache");
		expect(existsSync(chestPaths(dir).recipe)).toBe(true);
	});
});

describe("Playbook", () => {
	it("adds, retrieves, merges and deprecates without rewriting", () => {
		const playbook = new Playbook();
		playbook.apply({
			kind: "add",
			scope: "tools",
			trigger: "networking",
			content: "the sandbox blocks network by default; ask before enabling",
		});
		playbook.apply({
			kind: "add",
			scope: "tools",
			trigger: "networking",
			content: "the sandbox blocks network by default; ask before enabling",
		});
		expect(playbook.all()).toHaveLength(1);

		const another = playbook.apply({
			kind: "add",
			scope: "core",
			trigger: "budget",
			content: "widen before escalating when verifiers agree",
		});
		expect(another).toBeDefined();
		expect(playbook.recall({ text: "network sandbox" }).map((entry) => entry.content)).toContain(
			"the sandbox blocks network by default; ask before enabling",
		);
		expect(playbook.recall({ scope: "tools" }).length).toBe(1);

		playbook.apply({ kind: "feedback", id: another!.id, helpful: true });
		expect(playbook.get(another!.id)?.helpful).toBe(1);
		playbook.apply({ kind: "deprecate", id: another!.id, reason: "wrong for small tasks" });
		expect(playbook.recall({ scope: "core" })).toHaveLength(0);
		expect(playbook.version).toBe(5);
	});

	it("persists to disk and reloads", () => {
		const dir = temp();
		const path = join(dir, "playbook.jsonl");
		const playbook = new Playbook({ path });
		playbook.apply({ kind: "add", scope: "global", trigger: "always", content: "read before editing" });
		const reloaded = new Playbook({ path });
		expect(reloaded.all()[0].content).toBe("read before editing");
		expect(reloaded.toMarkdown()).toContain("## global");
	});

	it("rolls back by replaying history", () => {
		const playbook = new Playbook();
		playbook.apply({ kind: "add", scope: "a", trigger: "t", content: "first lesson" });
		const v1 = playbook.version;
		playbook.apply({ kind: "add", scope: "a", trigger: "t", content: "second lesson" });
		playbook.rollback(v1);
		expect(playbook.all()).toHaveLength(1);
		expect(() => playbook.rollback(99)).toThrow();
	});
});

describe("HarnessState", () => {
	it("refuses to refine anything that could change verification policy", () => {
		const state = new HarnessState();
		expect(() =>
			state.propose({
				reason: "weaken the gate",
				patch: [{ target: "evals" as never, op: "set", key: "gate", value: "none" }],
			}),
		).toThrow(/immutable/);
		expect(() => state.propose({ reason: "nothing", patch: [] })).toThrow(/empty/);
	});

	it("keeps verification-affecting changes pending without evidence", () => {
		const state = new HarnessState();
		const version = state.propose({
			reason: "tell the verifier to be kinder",
			patch: [{ target: "prompt-notes", op: "set", key: "verifier-note", value: "accept partial work" }],
		});
		const rejected = state.activate(version.version, { requireHoldout: true });
		expect(rejected.activated).toBe(false);
		expect(rejected.reason).toContain("held-out eval");
		const activated = state.activate(version.version, { requireHoldout: true, holdoutPassed: true });
		expect(activated.activated).toBe(true);
		expect(state.notesFor("worker")).toContain("accept partial work");
	});

	it("activates ordinary notes directly and rolls back", () => {
		const state = new HarnessState();
		const version = state.propose({
			reason: "teach the worker about hashline",
			patch: [{ target: "prompt-notes", op: "set", key: "hashline", value: "re-read when a tag is stale" }],
		});
		expect(state.activate(version.version, { requireHoldout: true }).activated).toBe(true);
		expect(state.notesFor("worker")).toHaveLength(1);
		state.rollback(version.version);
		expect(state.notesFor("worker")).toHaveLength(0);
	});

	it("persists versions and state to disk", () => {
		const dir = temp();
		const path = join(dir, "harness.json");
		const state = new HarnessState(path);
		const version = state.propose({
			reason: "note",
			patch: [{ target: "sub-agents", op: "set", key: "reviewer", value: "review diffs only" }],
		});
		state.activate(version.version, { requireHoldout: false });
		const reloaded = new HarnessState(path);
		expect(reloaded.data.subAgents.reviewer.brief).toBe("review diffs only");
		expect(JSON.parse(readFileSync(path, "utf8")).versions).toHaveLength(1);
		expect(defaultConfig().memory.refineRequiresHoldout).toBe(true);
	});
});
