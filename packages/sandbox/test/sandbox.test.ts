import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	classifyCommand,
	containsSecret,
	detectSandboxDenial,
	evaluatePreset,
	FileAuditLog,
	globToRegExp,
	MemoryAuditLog,
	matchesAnyGlob,
	presetRules,
	redact,
	redactEnv,
	Sandbox,
	seatbeltProfile,
	workspacePolicy,
} from "../src/index.ts";

const workspace = process.cwd();

describe("classifyCommand", () => {
	it("recognizes read-only pipelines", () => {
		expect(classifyCommand("ls -la src").class).toBe("read_only");
		expect(classifyCommand("rg TODO src | head -20").class).toBe("read_only");
		expect(classifyCommand("git status").class).toBe("read_only");
		expect(classifyCommand("git diff --stat").class).toBe("read_only");
	});

	it("treats writes, network, destructive and unknown commands as unsafe", () => {
		expect(classifyCommand("npm test").class).toBe("writes_workspace");
		expect(classifyCommand("sed -i 's/a/b/' f.ts").class).toBe("writes_workspace");
		expect(classifyCommand("echo hi > out.txt").class).toBe("writes_workspace");
		expect(classifyCommand("curl https://example.com").class).toBe("network");
		expect(classifyCommand("rm -rf node_modules").class).toBe("destructive");
		expect(classifyCommand("sudo rm -rf /").class).toBe("destructive");
		expect(classifyCommand("my-custom-binary --do-things").class).toBe("unknown");
		expect(classifyCommand("echo $(rm -rf /)").class).toBe("unknown");
		expect(classifyCommand("sleep 1 &").class).toBe("unknown");
	});

	it("reports the programs it saw", () => {
		expect(classifyCommand("cat a.txt | grep x && ls").programs).toEqual(["cat", "grep", "ls"]);
	});
});

describe("glob matching", () => {
	it("matches ** across directories and * within one", () => {
		expect(globToRegExp("**/.env").test("a/b/.env")).toBe(true);
		expect(globToRegExp("src/*.ts").test("src/a.ts")).toBe(true);
		expect(globToRegExp("src/*.ts").test("src/deep/a.ts")).toBe(false);
		expect(globToRegExp("*.{ts,tsx}").test("a.tsx")).toBe(true);
	});

	it("matches workspace-relative and absolute paths", () => {
		expect(matchesAnyGlob("src/a.ts", ["src/**"], workspace)).toBe(true);
		expect(matchesAnyGlob(join(workspace, "src/a.ts"), ["src/**"], workspace)).toBe(true);
		expect(matchesAnyGlob("/etc/passwd", ["src/**"], workspace)).toBe(false);
	});
});

describe("permission presets", () => {
	it("yolo allows everything", () => {
		expect(evaluatePreset("yolo", { tool: "bash", command: "rm -rf /" }, workspace).effect).toBe("allow");
	});

	it("standard allows reads and workspace writes, asks for unsafe shell, denies secrets", () => {
		expect(evaluatePreset("standard", { tool: "read", paths: ["src/a.ts"] }, workspace)).toMatchObject({
			effect: "allow",
			ruleId: "standard-reads",
		});
		expect(evaluatePreset("standard", { tool: "edit", paths: ["src/a.ts"] }, workspace)).toMatchObject({
			effect: "allow",
			ruleId: "standard-writes-workspace",
		});
		expect(evaluatePreset("standard", { tool: "bash", command: "ls" }, workspace)).toMatchObject({
			effect: "allow",
			ruleId: "standard-safe-shell",
		});
		expect(evaluatePreset("standard", { tool: "bash", command: "npm test" }, workspace)).toMatchObject({
			effect: "ask",
			ruleId: "standard-shell",
		});
		expect(evaluatePreset("standard", { tool: "read", paths: [".env"] }, workspace)).toMatchObject({
			effect: "deny",
			ruleId: "protect-secrets",
		});
		expect(evaluatePreset("standard", { tool: "edit", paths: ["../outside.ts"] }, workspace)).toMatchObject({
			effect: "deny",
		});
	});

	it("never lets a worker edit gate material", () => {
		const decision = evaluatePreset("standard", { tool: "edit", paths: [".bedrock/gate/gate.json"] }, workspace);
		expect(decision.effect).toBe("deny");
	});

	it("strict denies the shell and asks before reads", () => {
		expect(evaluatePreset("strict", { tool: "bash", command: "ls" }, workspace).effect).toBe("deny");
		expect(evaluatePreset("strict", { tool: "read", paths: ["a.ts"] }, workspace).effect).toBe("ask");
	});

	it("exposes its rules for the TUI", () => {
		expect(presetRules("standard").map((rule) => rule.id)).toContain("standard-safe-shell");
	});
});

describe("seatbelt profiles", () => {
	it("denies by default and allows exactly the writable roots", () => {
		const { params, profile } = seatbeltProfile(workspacePolicy(workspace));
		expect(profile).toContain("(deny default)");
		expect(params.WRITE_0).toBe(workspace);
		expect(profile).toContain('(subpath (param "WRITE_0"))');
		expect(profile).toContain('(deny file-write* (subpath (param "PROTECT_0")))');
		expect(params.PROTECT_0).toBe(join(workspace, ".git"));
	});

	it("read-only mode denies all writes and skips writable roots", () => {
		const { profile, params } = seatbeltProfile({ ...workspacePolicy(workspace), filesystem: "read_only" });
		expect(profile).toContain("(deny file-write*)");
		expect(params.WRITE_0).toBeUndefined();
	});

	it("full access is an allow-all profile", () => {
		expect(seatbeltProfile({ ...workspacePolicy(workspace), filesystem: "danger_full_access" }).profile).toContain(
			"(allow default)",
		);
	});

	it("blocks the network when requested", () => {
		expect(seatbeltProfile(workspacePolicy(workspace)).profile).toContain("(deny network*)");
	});
});

describe("redaction", () => {
	it("redacts provider keys, tokens and assignments while keeping a suffix", () => {
		const { text, rules } = redact(
			"key sk-ant-api03-abcdefghijklmnopqrstuvwxyz and token ghp_abcdefghijklmnopqrstuvwxyz0123",
		);
		expect(text).not.toContain("sk-ant-api03-abcdefghijklmnopqrstuvwxyz");
		expect(text).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123");
		expect(text).toContain("wxyz");
		expect(rules).toContain("anthropic");
		expect(rules).toContain("github");
	});

	it("redacts secret-looking assignments and bearer headers", () => {
		const { text } = redact("GITHUB_TOKEN=abcdef123456\nAuthorization: Bearer abcdefghijklmnop");
		expect(text).toContain("GITHUB_TOKEN=***");
		expect(text).toContain("Bearer ***");
	});

	it("leaves ordinary text alone", () => {
		const { rules } = redact("const answer = 42; // nothing secret here");
		expect(rules).toEqual([]);
		expect(containsSecret("AWS_SECRET_ACCESS_KEY=supersecretvalue")).toBe(true);
		expect(containsSecret("hello world")).toBe(false);
	});

	it("redacts credential-shaped environment variables by name", () => {
		expect(redactEnv({ API_KEY: "x", HOME: "/Users/x" })).toEqual({ API_KEY: "***", HOME: "/Users/x" });
	});
});

describe("denial detection", () => {
	it("recognizes sandbox refusals", () => {
		expect(detectSandboxDenial(1, "sandbox-exec: sandbox_apply: Operation not permitted").detected).toBe(true);
		expect(detectSandboxDenial(1, "Read-only file system").signal).toBe("readonly-fs");
		expect(detectSandboxDenial(1, "Could not resolve host: example.com").signal).toBe("docker-network");
		expect(detectSandboxDenial(0, "sandbox-exec").detected).toBe(false);
		expect(detectSandboxDenial(2, "test failed").detected).toBe(false);
	});
});

describe("audit log", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("appends one JSON line per record", () => {
		const dir = mkdtempSync(join(tmpdir(), "bedrock-audit-"));
		dirs.push(dir);
		const sink = new FileAuditLog(join(dir, "audit.jsonl"));
		sink.record({
			at: "2026-01-01T00:00:00.000Z",
			tool: "bash",
			decision: { effect: "allow", reason: "test" },
			executed: true,
			exitCode: 0,
		});
		sink.record({
			at: "2026-01-01T00:00:01.000Z",
			tool: "read",
			decision: { effect: "allow", reason: "test" },
			executed: true,
		});
		const lines = readFileSync(join(dir, "audit.jsonl"), "utf8").trim().split("\n");
		expect(lines).toHaveLength(2);
		expect(JSON.parse(lines[0])).toMatchObject({ tool: "bash", executed: true });
	});
});

describe("Sandbox", () => {
	it("denies a call the policy rejects and records it", () => {
		const audit = new MemoryAuditLog();
		const sandbox = new Sandbox({ workspace, preset: "standard", autonomous: false, audit });
		const outcome = sandbox.run("cat .env");
		expect(outcome.exitCode).not.toBe(0);
		expect(outcome.stderr).toContain("denied");
		expect(audit.records).toHaveLength(1);
		expect(audit.records[0].executed).toBe(false);
	});

	it("runs an allowed read-only command and redacts its output", () => {
		const sandbox = new Sandbox({ workspace, preset: "standard", autonomous: false });
		const outcome = sandbox.run("printf 'OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwx\\n'");
		expect(outcome.exitCode).toBe(0);
		expect(outcome.stdout).toContain("***");
		expect(outcome.stdout).not.toContain("sk-abcdefghijklmnopqrstuvwx");
	});

	it("widens ask to allow for autonomous isolated runs only", () => {
		const autonomous = new Sandbox({ workspace, preset: "standard", autonomous: true });
		expect(autonomous.check({ tool: "bash", command: "npm test" }).effect).toBe("allow");
		const interactive = new Sandbox({ workspace, preset: "standard", autonomous: false });
		expect(interactive.check({ tool: "bash", command: "npm test" }).effect).toBe("ask");
	});
});
