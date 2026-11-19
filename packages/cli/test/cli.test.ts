import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const bin = join(root, "bin", "bedrock.js");

function run(args: string[], cwd: string): { status: number | null; stdout: string; stderr: string } {
	const result = spawnSync(process.execPath, [bin, ...args], { encoding: "utf8", cwd, timeout: 120_000 });
	return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("bedrock cli", () => {
	it("prints its version and help without touching a workspace", () => {
		const version = run(["--version"], root);
		expect(version.status).toBe(0);
		expect(version.stdout).toContain("bedrock 0.1.0");

		const help = run(["--help"], root);
		expect(help.stdout).toContain("bedrock quick");
		expect(help.stdout).toContain("bedrock run");
		expect(help.stdout).toContain("--gate");
	});

	it("lists models from the pi catalog", () => {
		const result = run(["models", "claude-sonnet"], root);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("anthropic/claude-sonnet");
	});

	it("rejects an unknown command with a non-zero exit", () => {
		const result = run(["frobnicate"], root);
		expect(result.status).toBe(2);
		expect(result.stderr).toContain('unknown command "frobnicate"');
	});

	it("needs a goal for run mode", () => {
		const result = run(["run"], root);
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("--goal");
	});

	it("scouts the current workspace as JSON", () => {
		const result = run(["scout"], root);
		expect(result.status).toBe(0);
		const report = JSON.parse(result.stdout) as { languages: Array<{ name: string }>; vcs?: { kind: string } };
		expect(report.vcs?.kind).toBe("git");
		expect(report.languages.some((language) => language.name === "TypeScript")).toBe(true);
	});
});
