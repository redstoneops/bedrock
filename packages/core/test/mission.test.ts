import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ai } from "@bedrock/ai";
import { ArtifactStore, EventLog } from "@bedrock/context";
import { Ledger } from "@bedrock/ledger";
import { createId, defaultConfig, type Mission } from "@bedrock/protocol";
import { MemoryAuditLog, Sandbox } from "@bedrock/sandbox";
import { contentTag, type LedgerSink } from "@bedrock/tools";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { detectCommands, runMission, scout } from "../src/index.ts";

const dirs: string[] = [];
function repo(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "bedrock-core-"));
	dirs.push(dir);
	for (const [name, content] of Object.entries(files)) {
		mkdirSync(join(dir, name, ".."), { recursive: true });
		writeFileSync(join(dir, name), content, "utf8");
	}
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

describe("scout", () => {
	it("maps languages, commands, context files and vcs state", () => {
		const root = repo({
			"package.json": JSON.stringify({ scripts: { test: "true", build: "true", typecheck: "true" } }),
			"package-lock.json": "{}",
			"src/a.ts": "export const a = 1;\n",
			"src/b.ts": "export const b = 2;\n",
			"docs/readme.md": "# hi\n",
			"AGENTS.md": "rules\n",
		});
		const report = scout({ workspace: root });
		expect(report.languages[0]).toEqual({ name: "TypeScript", files: 2 });
		expect(report.commands).toMatchObject({
			test: "npm run test",
			build: "npm run build",
			typecheck: "npm run typecheck",
		});
		expect(report.contextFiles).toContain("AGENTS.md");
		expect(report.vcs).toMatchObject({ kind: "git", clean: true });
		expect(report.services.find((service) => service.name === "git")?.reachable).toBe(true);
	});

	it("detects commands without a package.json", () => {
		const root = repo({ "Cargo.toml": '[package]\nname = "x"\n', Makefile: "test:\n\ttrue\n" });
		expect(detectCommands(root)).toMatchObject({ build: "cargo build", test: "cargo test" });
	});
});

function mission(root: string, gateCommands?: string[]): Mission {
	return {
		id: createId("mission"),
		spec: {
			goal: "make the tests pass",
			mode: "run",
			budget: { usd: 5, maxParallelWorkers: 2 },
			isolation: "worktree",
			gateCommands,
		},
		status: "running",
		phase: "bootstrap",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		workspace: root,
		baseTree: "abc",
	};
}

function aiWith(responses: ReturnType<typeof fauxAssistantMessage>[]): {
	ai: Ai;
	faux: ReturnType<typeof fauxProvider>;
} {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	faux.setResponses(responses);
	const config = defaultConfig();
	return { ai: new Ai({ config, models }), faux };
}

describe("runMission", () => {
	it("passes only when the gate passes, and reports the tree hash", async () => {
		const original = JSON.stringify({ scripts: { test: 'node -e "process.exit(1)"' } });
		const root = repo({ "package.json": original });
		const task = mission(root);
		const replacement = JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } });
		const { ai } = aiWith([
			fauxAssistantMessage([
				fauxToolCall("write", {
					path: "package.json",
					content: `¶package.json#${contentTag(original)}\n${replacement}`,
				}),
			]),
			fauxAssistantMessage([
				fauxToolCall("finish", { summary: "made the test pass", checks: ["npm test -> exit 0"], unverified: [] }),
			]),
		]);
		const ledger = new Ledger({ path: ":memory:" });
		const result = await runMission({
			mission: task,
			ai,
			sandbox: new Sandbox({ workspace: root, preset: "yolo", autonomous: true, audit: new MemoryAuditLog() }),
			artifacts: new ArtifactStore({ kind: "memory" }),
			ledger: ledger as unknown as LedgerSink & never,
			eventLog: new EventLog({ sessionId: createId("session") }),
			maxAttempts: 1,
		});
		expect(result.results[0].treeHash).toMatch(/^[0-9a-f]{40}$/);
		expect(result.finalState).toBe("passed");
		expect(result.proof.summary).toContain("gate passed");
		expect(result.gate.checks.length).toBeGreaterThan(0);
		ledger.close();
	});

	it("reports failure honestly when the worker does not fix anything", async () => {
		const root = repo({ "package.json": JSON.stringify({ scripts: { test: 'node -e "process.exit(1)"' } }) });
		const { ai } = aiWith([
			fauxAssistantMessage([
				fauxToolCall("finish", { summary: "could not fix it", checks: [], unverified: ["everything"] }),
			]),
			fauxAssistantMessage([
				fauxToolCall("finish", { summary: "still could not fix it", checks: [], unverified: ["everything"] }),
			]),
			fauxAssistantMessage([fauxToolCall("finish", { summary: "gave up", checks: [], unverified: ["everything"] })]),
		]);
		const ledger = new Ledger({ path: ":memory:" });
		const result = await runMission({
			mission: mission(root),
			ai,
			sandbox: new Sandbox({ workspace: root, preset: "yolo", autonomous: true, audit: new MemoryAuditLog() }),
			artifacts: new ArtifactStore({ kind: "memory" }),
			ledger: ledger as unknown as LedgerSink & never,
			maxAttempts: 1,
		});
		expect(result.finalState).toBe("failed");
		expect(result.proof.summary).toContain("No candidate passed");
		expect(result.proof.unverified).toContain("everything");
		ledger.close();
	});

	it("includes a user-supplied gate command and cannot be passed without it", async () => {
		const root = repo({ "package.json": JSON.stringify({ scripts: { test: "true" } }), "done.txt": "no\n" });
		const task = mission(root, ["grep -q yes done.txt"]);
		const { ai } = aiWith([
			fauxAssistantMessage([fauxToolCall("finish", { summary: "did nothing", checks: [], unverified: [] })]),
		]);
		const ledger = new Ledger({ path: ":memory:" });
		const result = await runMission({
			mission: task,
			ai,
			sandbox: new Sandbox({ workspace: root, preset: "yolo", autonomous: true, audit: new MemoryAuditLog() }),
			artifacts: new ArtifactStore({ kind: "memory" }),
			ledger: ledger as unknown as LedgerSink & never,
			maxAttempts: 1,
		});
		expect(result.gate.userSupplied).toEqual(["grep -q yes done.txt"]);
		// The built-in test passes even without an edit, so the honest verdict is
		// partial: some checks pass, the user gate does not.
		expect(result.finalState).toBe("partial");
		ledger.close();
	});
});
