import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ai } from "@bedrock/ai";
import { compileGate, runGate } from "@bedrock/gate";
import {
	type CandidateView,
	createId,
	defaultConfig,
	type Gate,
	type GateResult,
	type Mission,
} from "@bedrock/protocol";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	computeFinalState,
	defaultVerifiers,
	explainFinalState,
	GateVerifier,
	RedTeamVerifier,
	RubricVerifier,
	TournamentSelection,
	verifyStack,
} from "../src/index.ts";

const dirs: string[] = [];
function gitWorkspace(): string {
	const dir = mkdtempSync(join(tmpdir(), "bedrock-verify-"));
	dirs.push(dir);
	writeFileSync(join(dir, "answer.txt"), "42\n");
	execFileSync("git", ["init", "-q"], { cwd: dir });
	execFileSync("git", ["config", "user.email", "t@e.com"], { cwd: dir });
	execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
	execFileSync("git", ["add", "-A"], { cwd: dir });
	execFileSync("git", ["commit", "-qm", "init"], { cwd: dir });
	return dir;
}
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function mission(root: string, gateCommands: string[] = ["true"]): Mission {
	return {
		id: createId("mission"),
		spec: { goal: "g", mode: "run", budget: {}, isolation: "worktree", gateCommands },
		status: "running",
		phase: "verify",
		createdAt: "t",
		updatedAt: "t",
		workspace: root,
		baseTree: "abc",
	};
}

function testAi(responses: string[]): Ai {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	faux.setResponses(responses.map((text) => fauxAssistantMessage(text)));
	return new Ai({ config: defaultConfig(), models });
}

function candidate(root: string, overrides: Partial<CandidateView> = {}): CandidateView {
	const gate = compileGate(mission(root));
	return {
		id: createId("entry"),
		missionId: gate.missionId,
		kind: "candidate",
		author: "harness",
		createdAt: "t",
		branch: "b",
		commit: "c",
		diffStat: { files: 1, additions: 3, deletions: 1 },
		summary: "changed answer.txt",
		diff: "--- a/answer.txt\n+++ b/answer.txt\n-41\n+42",
		gate: {
			gateId: createId("gate"),
			gateVersion: 1,
			treeHash: "tree",
			startedAt: "t",
			finishedAt: "t",
			visible: [],
			holdout: [],
			invariantViolations: [],
			integrity: { changedPaths: [], protectedTouched: [], unjustified: [], suspicious: [], clean: true },
			passed: true,
			passRatio: 1,
		},
		...overrides,
		workerId: overrides.workerId ?? createId("worker"),
	};
}

function gateWith(root: string, extra: Partial<Gate> = {}): Gate {
	return { ...compileGate(mission(root)), ...extra };
}

describe("GateVerifier", () => {
	it("runs the gate including holdout and binds the result to a tree hash", async () => {
		const root = gitWorkspace();
		const gate = gateWith(root);
		gate.checks.push({
			id: createId("check"),
			name: "holdout",
			kind: "test",
			origin: "holdout",
			visibility: "holdout",
			command: "true",
			expect: { kind: "exit_code", code: 0 },
		});
		const verifier = new GateVerifier();
		const result = await verifier.verify(candidate(root), gate, { workspace: root });
		expect(result.holdout).toHaveLength(1);
		expect(result.treeHash).toMatch(/^[0-9a-f]{40}$/);
		expect(result.passed).toBe(true);
	});

	it("fails when a check fails", async () => {
		const root = gitWorkspace();
		const gate = gateWith(root, {
			checks: [
				{
					id: createId("check"),
					name: "no",
					kind: "command",
					origin: "existing",
					visibility: "visible",
					command: "false",
					expect: { kind: "exit_code", code: 0 },
				},
			],
		});
		const result = await new GateVerifier().verify(candidate(root), gate, { workspace: root });
		expect(result.passed).toBe(false);
	});
});

describe("RubricVerifier", () => {
	it("scores criteria and blocks on a failed blocker", async () => {
		const root = gitWorkspace();
		const gate = gateWith(root, {
			checks: [],
			rubric: [
				{ id: "api", criterion: "public API unchanged", weight: 2, severity: "blocker" },
				{ id: "docs", criterion: "docs updated", weight: 1, severity: "minor" },
			],
		});
		const ai = testAi([
			JSON.stringify({
				verdicts: [
					{ criterionId: "api", score: 2, justification: "diff shows no signature change" },
					{ criterionId: "docs", score: 0, justification: "no docs change" },
				],
			}),
		]);
		const result = await new RubricVerifier(ai).verify(candidate(root), gate, { workspace: root });
		expect(result.rubricScore).toBeCloseTo(4 / 6, 5);
		expect(result.passed).toBe(true);
		const blocked = await new RubricVerifier(
			testAi([JSON.stringify({ verdicts: [{ criterionId: "api", score: 0, justification: "signature changed" }] })]),
		).verify(candidate(root), gate, { workspace: root });
		expect(blocked.passed).toBe(false);
	});

	it("marks unverified when the model answer is unusable", async () => {
		const root = gitWorkspace();
		const gate = gateWith(root, {
			checks: [],
			rubric: [{ id: "api", criterion: "api", weight: 1, severity: "blocker" }],
		});
		const result = await new RubricVerifier(testAi(["I cannot answer"])).verify(candidate(root), gate, {
			workspace: root,
		});
		expect(result.rubricVerdicts?.[0].unverified).toBe(true);
		expect(result.passed).toBe(false);
	});
});

describe("RedTeamVerifier", () => {
	it("treats a 'gamed' verdict as critical and blocking", async () => {
		const root = gitWorkspace();
		const gate = gateWith(root, { checks: [] });
		const result = await new RedTeamVerifier(
			testAi([JSON.stringify({ verdict: "gamed", findings: ["tests were skipped in src/a.test.ts"] })]),
		).verify(candidate(root), gate, { workspace: root });
		expect(result.integrity.clean).toBe(false);
		expect(result.integrity.suspicious[0].severity).toBe("critical");
		expect(result.passed).toBe(false);
	});

	it("does not run without a model", () => {
		expect(new RedTeamVerifier().applies(candidate("/tmp"))).toBe(false);
	});
});

describe("verifyStack", () => {
	it("runs cheapest first and stops on failure", async () => {
		const root = gitWorkspace();
		const gate = gateWith(root, {
			checks: [
				{
					id: createId("check"),
					name: "no",
					kind: "command",
					origin: "existing",
					visibility: "visible",
					command: "false",
					expect: { kind: "exit_code", code: 0 },
				},
			],
		});
		const { layers } = await verifyStack(candidate(root), gate, defaultVerifiers(), { workspace: root });
		expect(layers[0].name).toBe("static");
		expect(layers.map((layer) => layer.name)).toContain("gate");
		expect(layers.at(-1)?.passed).toBe(false);
		expect(layers.map((layer) => layer.name)).not.toContain("rubric");
	});

	it("needs at least one applicable verifier", async () => {
		const gate = gateWith("/tmp", { checks: [] });
		await expect(verifyStack(candidate("/tmp"), gate, [], { workspace: "/tmp" })).rejects.toThrow(/no verifier/);
	});
});

describe("TournamentSelection", () => {
	it("returns no winner when nobody passed", async () => {
		const result = await new TournamentSelection().select(
			[
				candidate("/tmp", {
					gate: {
						...(gateWith("/tmp") && {}),
						passed: false,
						passRatio: 0,
						gateId: createId("gate"),
						gateVersion: 1,
						treeHash: "t",
						startedAt: "t",
						finishedAt: "t",
						visible: [],
						holdout: [],
						invariantViolations: [],
						integrity: { changedPaths: [], protectedTouched: [], unjustified: [], suspicious: [], clean: true },
					} as GateResult,
				}),
			],
			gateWith("/tmp"),
		);
		expect(result.winner).toBeUndefined();
		expect(result.rationale).toContain("no candidate");
	});

	it("prefers gate ratio, then rubric, then smaller diff without a judge", async () => {
		const a = candidate("/tmp", { summary: "a" });
		const b = candidate("/tmp", { summary: "b", diffStat: { files: 1, additions: 1, deletions: 0 } });
		const result = await new TournamentSelection().select([a, b], gateWith("/tmp"));
		expect(result.winner?.workerId).toBe(b.workerId);
	});

	it("uses the judge when available", async () => {
		const ai = testAi([JSON.stringify({ winner: 1, rationale: "candidate 1 is the smaller correct change" })]);
		const a = candidate("/tmp", { summary: "a" });
		const b = candidate("/tmp", { summary: "b" });
		const result = await new TournamentSelection(ai).select([a, b], gateWith("/tmp"));
		expect(result.winner?.workerId).toBe(a.workerId);
		expect(result.rationale).toContain("smaller");
	});
});

describe("final state", () => {
	const passed = { passed: true, integrity: { clean: true }, passRatio: 1 } as GateResult;
	const failed = { passed: false, integrity: { clean: true }, passRatio: 0 } as GateResult;
	const partial = { passed: false, integrity: { clean: true }, passRatio: 0.5 } as GateResult;
	const dirty = { passed: true, integrity: { clean: false }, passRatio: 1 } as GateResult;

	it("is computed from gate results, never from claims", () => {
		expect(computeFinalState([passed])).toBe("passed");
		expect(computeFinalState([failed])).toBe("failed");
		expect(computeFinalState([partial])).toBe("partial");
		expect(computeFinalState([dirty])).toBe("unverified");
		expect(computeFinalState([partial], { exhausted: true })).toBe("exhausted");
		expect(computeFinalState([passed], { cancelled: true })).toBe("cancelled");
	});

	it("explains itself plainly", () => {
		expect(explainFinalState("partial", [partial])).toContain("50%");
		expect(explainFinalState("passed", [passed])).toContain("integrity");
	});
});
