import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactStore } from "@bedrock/context";
import { createId, type Mission, type ScoutReport } from "@bedrock/protocol";
import { afterEach, describe, expect, it } from "vitest";
import {
	compileGate,
	describeResult,
	detectChecks,
	monitorIntegrity,
	runCheck,
	runGate,
	treeHash,
	validateAcceptanceChecks,
} from "../src/index.ts";

const dirs: string[] = [];
function workspace(files: Record<string, string> = {}, git = false): string {
	const dir = mkdtempSync(join(tmpdir(), "bedrock-gate-"));
	dirs.push(dir);
	for (const [name, content] of Object.entries(files)) {
		const path = join(dir, name);
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, content, "utf8");
	}
	if (git) {
		execFileSync("git", ["init", "-q"], { cwd: dir });
		execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
		execFileSync("git", ["config", "user.name", "test"], { cwd: dir });
		execFileSync("git", ["add", "-A"], { cwd: dir });
		execFileSync("git", ["commit", "-qm", "init"], { cwd: dir });
	}
	return dir;
}
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function mission(root: string, gateCommands?: string[]): Mission {
	return {
		id: createId("mission"),
		spec: { goal: "add tests", mode: "run", budget: { usd: 5 }, isolation: "worktree", gateCommands },
		status: "running",
		phase: "gate",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		workspace: root,
		baseTree: "abc",
	};
}

describe("detectChecks", () => {
	it("prefers the scout's commands", () => {
		const checks = detectChecks("/nowhere", {
			commands: { build: "npm run build", test: "vitest run", lint: "biome check ." },
		} as ScoutReport);
		expect(checks.map((check) => check.command)).toEqual(["npm run build", "vitest run", "biome check ."]);
	});

	it("falls back to package.json scripts, then to language defaults", () => {
		const node = workspace({ "package.json": JSON.stringify({ scripts: { test: "vitest run", build: "tsc" } }) });
		expect(detectChecks(node).map((check) => check.command)).toEqual(["npm run build", "npm test"]);
		const rust = workspace({ "Cargo.toml": "[package]" });
		expect(detectChecks(rust).map((check) => check.command)).toEqual(["cargo build", "cargo test"]);
		expect(detectChecks(workspace())).toEqual([]);
	});
});

describe("compileGate", () => {
	it("includes the repository's checks, user commands and a rationale", () => {
		const root = workspace({ "package.json": JSON.stringify({ scripts: { test: "true" } }) });
		const gate = compileGate(mission(root, ["npm test -- --run"]));
		expect(gate.checks.map((check) => check.name)).toEqual(["test", "user-gate-1"]);
		expect(gate.checks.every((check) => check.visibility === "visible")).toBe(true);
		expect(gate.userSupplied).toEqual(["npm test -- --run"]);
		expect(gate.rationale).toContain("repository's own commands");
		expect(gate.approved).toBe(false);
	});

	it("says plainly when no command was detected", () => {
		const gate = compileGate(mission(workspace()));
		expect(gate.checks).toEqual([]);
		expect(gate.rationale).toContain("Pass --gate");
	});

	it("turns constraints into rubric criteria", () => {
		const root = workspace();
		const m = mission(root);
		m.spec.constraints = ["public API unchanged"];
		const gate = compileGate(m);
		expect(gate.rubric[0]).toMatchObject({ criterion: "public API unchanged", severity: "major" });
	});
});

describe("runCheck and runGate", () => {
	it("scores exit codes, stdout and patterns", () => {
		const root = workspace();
		const base = {
			id: createId("check"),
			name: "x",
			kind: "command" as const,
			origin: "existing" as const,
			visibility: "visible" as const,
		};
		expect(runCheck({ ...base, command: "true", expect: { kind: "exit_code", code: 0 } }, root).status).toBe(
			"passed",
		);
		const failed = runCheck({ ...base, command: "exit 3", expect: { kind: "exit_code", code: 0 } }, root);
		expect(failed.status).toBe("failed");
		expect(failed.failureReason).toContain("expected exit 0");
		expect(
			runCheck({ ...base, command: "echo hello", expect: { kind: "stdout_contains", text: "hello" } }, root).status,
		).toBe("passed");
		expect(
			runCheck(
				{ ...base, command: "printf 'a\\na\\n'", expect: { kind: "min_count", pattern: "a", count: 3 } },
				root,
			).status,
		).toBe("failed");
	});

	it("truncates large check output and stores it as an artifact", () => {
		const root = workspace();
		const check = {
			id: createId("check"),
			name: "noisy",
			kind: "command" as const,
			origin: "existing" as const,
			visibility: "visible" as const,
			command: "seq 1 5000",
			expect: { kind: "exit_code" as const, code: 0 },
		};
		const artifacts = new ArtifactStore({ kind: "memory" });
		const run = runCheck(check, root, { artifacts, truncation: { maxLines: 50, maxBytes: 1000 } });
		expect(run.status).toBe("passed");
		expect(run.truncated).toBe(true);
		expect(run.artifact).toBeDefined();
	});

	it("runs visible checks and hides holdout checks unless asked", () => {
		const root = workspace();
		const gate = compileGate(mission(root, ["true"]));
		gate.checks.push({
			id: createId("check"),
			name: "holdout",
			kind: "test",
			origin: "holdout",
			visibility: "holdout",
			command: "true",
			expect: { kind: "exit_code", code: 0 },
		});
		const visibleOnly = runGate({ gate, workspace: root, includeHoldout: false });
		expect(visibleOnly.holdout).toEqual([]);
		expect(visibleOnly.passed).toBe(true);
		const withHoldout = runGate({ gate, workspace: root, includeHoldout: true });
		expect(withHoldout.holdout).toHaveLength(1);
		expect(withHoldout.passRatio).toBe(1);
	});

	it("fails the gate when a check fails or an invariant is violated", () => {
		const root = workspace();
		const gate = compileGate(mission(root, ["exit 1"]));
		const result = runGate({ gate, workspace: root, includeHoldout: false });
		expect(result.passed).toBe(false);
		expect(describeResult(result)).toContain("FAILED");
	});

	it("can rerun a single check by name", () => {
		const root = workspace();
		const gate = compileGate(mission(root, ["true"]));
		gate.checks.push({
			id: createId("check"),
			name: "second",
			kind: "command",
			origin: "existing",
			visibility: "visible",
			command: "false",
			expect: { kind: "exit_code", code: 0 },
		});
		const result = runGate({ gate, workspace: root, includeHoldout: false, only: ["user-gate-1"] });
		expect(result.visible).toHaveLength(1);
		expect(result.visible[0].name).toBe("user-gate-1");
	});
});

describe("integrity", () => {
	it("hashes the tree and notices changes", () => {
		const root = workspace({ "a.txt": "one\n" }, true);
		const before = treeHash(root);
		writeFileSync(join(root, "a.txt"), "two\n");
		expect(treeHash(root)).not.toBe(before);
	});

	it("flags modified and skipped tests as suspicious", () => {
		const root = workspace({ "src/a.test.ts": "test('a', () => expect(1).toBe(1));\n" }, true);
		const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
		writeFileSync(join(root, "src/a.test.ts"), "test.skip('a', () => expect(1).toBe(1));\n");
		const gate = compileGate(mission(root));
		const report = monitorIntegrity(gate, root, base);
		expect(report.changedPaths).toContain("src/a.test.ts");
		expect(report.suspicious.map((finding) => finding.kind)).toEqual(
			expect.arrayContaining(["test_modified", "test_skipped"]),
		);
		expect(report.clean).toBe(false);
	});

	it("flags protected paths that were touched", () => {
		const root = workspace({ "notes.md": "x\n" }, true);
		const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
		writeFileSync(join(root, ".bedrock-gate.txt"), "x");
		const gate = compileGate(mission(root), undefined, { protectedPaths: [".bedrock-gate.txt"] });
		expect(gate.integrity.protectedPaths).toEqual([".bedrock-gate.txt"]);
		const report = monitorIntegrity(gate, root, base);
		expect(report.protectedTouched).toEqual([".bedrock-gate.txt"]);
	});
});

describe("acceptance validation", () => {
	it("accepts a check that fails on the base tree and demotes one that already passes", () => {
		const root = workspace({ "check.sh": "exit 1\n", "pass.sh": "exit 0\n" }, true);
		const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
		const real = {
			id: createId("check"),
			name: "real",
			kind: "test" as const,
			origin: "acceptance" as const,
			visibility: "visible" as const,
			command: "bash check.sh",
			expect: { kind: "exit_code" as const, code: 0 },
		};
		const vacuous = {
			id: createId("check"),
			name: "vacuous",
			kind: "test" as const,
			origin: "acceptance" as const,
			visibility: "visible" as const,
			command: "bash pass.sh",
			expect: { kind: "exit_code" as const, code: 0 },
		};
		// The check files must exist at the base commit; they do because the repo was committed after writing.
		const outcomes = validateAcceptanceChecks([real, vacuous], { workspace: root, baseCommit: base });
		expect(outcomes.find((outcome) => outcome.name === "real")).toMatchObject({ valid: true });
		expect(outcomes.map((outcome) => outcome.reason)).not.toContain("could not create a base worktree");
		expect(outcomes.find((outcome) => outcome.name === "vacuous")).toMatchObject({ valid: true });
		expect(vacuous.visibility).toBe("holdout");
		expect((real as { baseline?: { failsWithoutFix: boolean } }).baseline?.failsWithoutFix).toBe(true);
	});
});
