import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const bin = join(import.meta.dirname, "..", "bin", "bedrock.js");
const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(): { repo: string; home: string } {
	const repo = mkdtempSync(join(tmpdir(), "bedrock-e2e-"));
	const home = mkdtempSync(join(tmpdir(), "bedrock-home-"));
	dirs.push(repo, home);
	writeFileSync(join(repo, "package.json"), JSON.stringify({ scripts: { test: "node check.js" } }));
	writeFileSync(
		join(repo, "check.js"),
		"const add = require('./add.js');\nif (add(2, 2) !== 4) { console.error('add(2,2) =', add(2, 2)); process.exit(1); }\nconsole.log('ok');\n",
	);
	writeFileSync(join(repo, "add.js"), "module.exports = (a, b) => a - b;\n");
	for (const args of [
		["init", "-q"],
		["config", "user.email", "t@e.com"],
		["config", "user.name", "t"],
		["add", "-A"],
		["commit", "-qm", "init"],
	]) {
		execFileSync("git", args, { cwd: repo });
	}
	return { repo, home };
}

function script(home: string, steps: unknown[]): string {
	const path = join(home, "script.json");
	writeFileSync(path, JSON.stringify({ steps }));
	return path;
}

function run(repo: string, home: string, scriptPath: string, args: string[]) {
	return spawnSync(process.execPath, [bin, ...args], {
		cwd: repo,
		encoding: "utf8",
		timeout: 120_000,
		env: {
			...process.env,
			HOME: home,
			BEDROCK_HOME: join(home, ".bedrock"),
			BEDROCK_SCRIPT: scriptPath,
			ANTHROPIC_API_KEY: "",
			OPENAI_API_KEY: "",
		},
	});
}

describe("bedrock run end to end (scripted model)", () => {
	it("fixes a bug in a worktree, verifies it, applies it and writes a proof", () => {
		const { repo, home } = fixture();
		const steps = [
			{ text: "Reading the implementation.", tools: [{ name: "read", args: { path: "add.js" } }] },
			{ tools: [{ name: "edit", args: { patch: "¶add.js\nPUT 1\nmodule.exports = (a, b) => a + b;" } }] },
			{ tools: [{ name: "checks", args: {} }] },
			{
				tools: [
					{
						name: "finish",
						args: {
							summary: "add used subtraction; fixed to addition",
							checks: ["checks: 1/1 visible passed"],
							unverified: [],
						},
					},
				],
			},
		];
		const result = run(repo, home, script(home, steps), [
			"run",
			"--goal",
			"make npm test pass",
			"--json",
			"--permissions",
			"yolo",
		]);
		const events = result.stdout
			.trim()
			.split("\n")
			.filter((line) => line.startsWith("{"))
			.map((line) => JSON.parse(line) as { type: string; finalState?: string; proof?: string });
		expect(result.stderr).toBe("");
		expect(result.status).toBe(0);
		const types = events.map((event) => event.type);
		for (const type of [
			"mission_start",
			"scout_report",
			"gate_compiled",
			"worker_spawned",
			"tool_call",
			"verification",
			"mission_finish",
		])
			expect(types).toContain(type);
		expect(events.at(-1)).toMatchObject({ type: "result", finalState: "passed" });
		expect(readFileSync(join(repo, "add.js"), "utf8")).toContain("a + b");
		const proof = events.at(-1)?.proof as string;
		expect(existsSync(proof)).toBe(true);
		expect(readFileSync(proof, "utf8")).toContain("# Proof of work: PASSED");
		// The ledger recorded evidence, and no worktree was left behind.
		expect(
			execFileSync("git", ["worktree", "list"], { cwd: repo, encoding: "utf8" }).trim().split("\n"),
		).toHaveLength(1);
		expect(execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" })).not.toContain(".bedrock");
	});

	it("reports an honest failure and keeps the user's tree untouched", () => {
		const { repo, home } = fixture();
		const steps = Array.from({ length: 6 }, () => ({
			tools: [{ name: "finish", args: { summary: "could not find it", checks: [], unverified: ["the bug"] } }],
		}));
		const result = run(repo, home, script(home, steps), [
			"run",
			"--goal",
			"make npm test pass",
			"--json",
			"--permissions",
			"yolo",
			"--max-attempts",
			"1",
		]);
		expect(result.status).toBe(1);
		expect(result.stdout).toContain('"finalState":"failed"');
		expect(readFileSync(join(repo, "add.js"), "utf8")).toContain("a - b");
		const proofs = spawnSync(process.execPath, [bin, "proof"], {
			cwd: repo,
			encoding: "utf8",
			env: { ...process.env, HOME: home },
		});
		expect(proofs.stdout).toContain("# Proof of work: FAILED");
		expect(proofs.stdout).toContain("the bug");
	});
});
