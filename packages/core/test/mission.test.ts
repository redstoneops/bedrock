import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { detectCommands, MissionController, runMission, scout } from "../src/index.ts";

const dirs: string[] = [];
function worktreeRoot(): string {
	const dir = mkdtempSync(join(tmpdir(), "bedrock-wt-"));
	dirs.push(dir);
	return dir;
}
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
			worktreeRoot: worktreeRoot(),
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
			worktreeRoot: worktreeRoot(),
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
			worktreeRoot: worktreeRoot(),
		});
		expect(result.gate.userSupplied).toEqual(["grep -q yes done.txt"]);
		// The built-in test passes even without an edit, so the honest verdict is
		// partial: some checks pass, the user gate does not.
		expect(result.finalState).toBe("partial");
		ledger.close();
	});

	it("widens to parallel workers in worktrees after a failed attempt, then applies the winner", async () => {
		const original = JSON.stringify({
			scripts: { test: "node -e \"process.exit(require('./fixed.json').ok ? 0 : 1)\"" },
		});
		const root = repo({ "package.json": original, "fixed.json": JSON.stringify({ ok: false }) });
		const broken = JSON.stringify({ ok: false });
		let call = 0;
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const respond = (context: { messages: Array<{ role: string }> }) => {
			call += 1;
			// Round 1: the only worker gives up. Later rounds: fix, then finish.
			if (call === 1)
				return fauxAssistantMessage([fauxToolCall("finish", { summary: "gave up", checks: [], unverified: [] })]);
			const acted = context.messages.some((message) => message.role === "toolResult");
			return acted
				? fauxAssistantMessage([
						fauxToolCall("finish", { summary: "fixed the flag", checks: ["npm test"], unverified: [] }),
					])
				: fauxAssistantMessage([
						fauxToolCall("write", {
							path: "fixed.json",
							content: `¶fixed.json#${contentTag(broken)}\n{"ok":true}`,
						}),
					]);
		};
		faux.setResponses(Array.from({ length: 12 }, () => respond as never));
		const ai = new Ai({ config: defaultConfig(), models });
		const ledger = new Ledger({ path: ":memory:" });
		const events: string[] = [];
		const task = mission(root);
		const result = await runMission({
			mission: task,
			ai,
			sandbox: new Sandbox({ workspace: root, preset: "yolo", autonomous: true, audit: new MemoryAuditLog() }),
			artifacts: new ArtifactStore({ kind: "memory" }),
			ledger: ledger as unknown as LedgerSink & never,
			maxAttempts: 3,
			maxParallel: 2,
			worktreeRoot: worktreeRoot(),
			onEvent: (event) =>
				events.push(event.type === "budget_decision" ? `budget:${event.decision.action}` : event.type),
		});
		expect(events).toContain("budget:widen");
		expect(events.filter((type) => type === "worker_spawned")).toHaveLength(3);
		expect(result.finalState).toBe("passed");
		expect(result.winner).toBeDefined();
		// The verified change was applied to the primary checkout, which was untouched until then.
		expect(JSON.parse(readFileSync(join(root, "fixed.json"), "utf8"))).toEqual({ ok: true });
		expect(
			execFileSync("git", ["worktree", "list"], { cwd: root, encoding: "utf8" }).trim().split("\n"),
		).toHaveLength(1);
		ledger.close();
	});

	it("stops with a cancelled verdict when the controller cancels", async () => {
		const root = repo({ "package.json": JSON.stringify({ scripts: { test: "true" } }) });
		const controller = new MissionController();
		controller.cancel();
		const { ai } = aiWith([
			fauxAssistantMessage([fauxToolCall("finish", { summary: "x", checks: [], unverified: [] })]),
		]);
		const ledger = new Ledger({ path: ":memory:" });
		const result = await runMission({
			mission: mission(root),
			ai,
			sandbox: new Sandbox({ workspace: root, preset: "yolo", autonomous: true, audit: new MemoryAuditLog() }),
			artifacts: new ArtifactStore({ kind: "memory" }),
			ledger: ledger as unknown as LedgerSink & never,
			controller,
			worktreeRoot: worktreeRoot(),
		});
		expect(result.finalState).toBe("cancelled");
		ledger.close();
	});
});
