import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyOverrides, loadConfig } from "../src/config.ts";

const dirs: string[] = [];
function temp(): string {
	const dir = mkdtempSync(join(tmpdir(), "bedrock-cli-"));
	dirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("loadConfig", () => {
	it("returns defaults when no config exists", () => {
		const loaded = loadConfig(temp());
		expect(loaded.sources).toEqual(["defaults"]);
		expect(loaded.config.loop.gateFirst).toBe(true);
		expect(loaded.config.roles.roles.verifier.requireDifferentFamily).toBe(true);
	});

	it("merges a project config over defaults", () => {
		const dir = temp();
		mkdirSync(join(dir, ".bedrock"));
		writeFileSync(
			join(dir, ".bedrock", "config.yml"),
			[
				"roles:",
				"  default: openai/gpt-5.5",
				"  roles:",
				"    worker: { model: openai/gpt-5.5, effort: high }",
				"loop: { maxParallelWorkers: 2 }",
				"budget: { usd: 3 }",
				"permissions: strict",
				"isolation: container",
			].join("\n"),
		);
		const loaded = loadConfig(dir);
		expect(loaded.sources.some((source) => source.endsWith("config.yml"))).toBe(true);
		expect(loaded.config.roles.default).toBe("openai/gpt-5.5");
		expect(loaded.config.roles.roles.worker.model).toBe("openai/gpt-5.5");
		expect(loaded.config.roles.roles.verifier.requireDifferentFamily).toBe(true);
		expect(loaded.config.loop.maxParallelWorkers).toBe(2);
		expect(loaded.config.budget.usd).toBe(3);
		expect(loaded.config.permissions).toBe("strict");
		expect(loaded.config.isolation).toBe("container");
		expect(loaded.config.stateDir).toBe(join(dir, ".bedrock"));
	});

	it("warns about unknown keys and bad YAML instead of failing", () => {
		const dir = temp();
		mkdirSync(join(dir, ".bedrock"));
		writeFileSync(join(dir, ".bedrock", "config.yml"), "loopd: {}\npermissions: [not, a, string]\n");
		const loaded = loadConfig(dir);
		expect(loaded.warnings.join("\n")).toContain('unknown config key "loopd"');
		expect(loaded.config.permissions).toBe("standard");
	});
});

describe("applyOverrides", () => {
	it("maps flags onto config without mutating the input", () => {
		const base = loadConfig(temp()).config;
		const next = applyOverrides(base, { model: "openai/gpt-5.5", maxUsd: 1, parallel: 2, permissions: "yolo" });
		expect(next.roles.roles.worker.model).toBe("openai/gpt-5.5");
		expect(next.budget.usd).toBe(1);
		expect(next.loop.maxParallelWorkers).toBe(2);
		expect(next.budget.maxParallelWorkers).toBe(2);
		expect(next.permissions).toBe("yolo");
		expect(base.roles.roles.worker.model).toBeUndefined();
	});

	it("targets another role when asked", () => {
		const base = loadConfig(temp()).config;
		const next = applyOverrides(base, { model: "google/gemini-3.8-flash", role: "red_team" });
		expect(next.roles.roles.red_team.model).toBe("google/gemini-3.8-flash");
		expect(next.roles.roles.worker.model).toBeUndefined();
	});
});
