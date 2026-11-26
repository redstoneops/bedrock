import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.ts";
import { savedModel, saveModel } from "../src/settings.ts";
import { addSkill, listSkills, skillContext, skillsDirectory } from "../src/user-skills.ts";

const roots: string[] = [];
afterEach(() => {
	vi.unstubAllEnvs();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
	const root = mkdtempSync(join(tmpdir(), "bedrock-user-state-"));
	roots.push(root);
	vi.stubEnv("BEDROCK_HOME", join(root, "user"));
	return root;
}

it("installs one skill document, persists it, and only injects explicitly selected skills", () => {
	const root = fixture();
	const source = join(root, "review guide");
	mkdirSync(source);
	const md = "---\nname: review-tests\ndescription: Review test coverage\n---\nLook for missing cases.\n";
	writeFileSync(join(source, "SKILL.md"), md);
	writeFileSync(join(source, "script.sh"), "not part of the skill store");
	const skill = addSkill("review guide", root);
	expect(skill.path).toBe(join(skillsDirectory(), "review-tests", "SKILL.md"));
	expect(readFileSync(skill.path, "utf8")).toBe(md);
	expect(listSkills()).toEqual([{ name: "review-tests", description: "Review test coverage", valid: true }]);
	expect(skillContext([])).toBe("");
	expect(skillContext(["review-tests"])).toContain("Look for missing cases.");
	expect(() => addSkill("review guide", root)).toThrow("already installed");
	expect(() => readFileSync(join(skillsDirectory(), "review-tests", "script.sh"))).toThrow("ENOENT");
});

it("rejects traversal, oversize documents and symlink aliases for installed skills", () => {
	const root = fixture();
	writeFileSync(join(root, "big.md"), "x".repeat(25 * 1024));
	expect(() => addSkill("big.md", root)).toThrow("24 KiB");
	expect(() => skillContext(["../secret"])).toThrow("kebab-case");
	if (process.platform !== "win32") {
		mkdirSync(skillsDirectory(), { recursive: true });
		symlinkSync(root, join(skillsDirectory(), "linked"));
		expect(() => skillContext(["linked"])).toThrow("invalid skill directory");
	}
});

it("persists the selected worker model without overriding a project pin on next launch", () => {
	const root = fixture();
	saveModel("deepseek/deepseek-flash");
	expect(savedModel()).toBe("deepseek/deepseek-flash");
	expect(loadConfig(root).config.roles.roles.worker?.model).toBe("deepseek/deepseek-flash");
	mkdirSync(join(root, ".bedrock"));
	writeFileSync(join(root, ".bedrock", "config.yml"), "roles:\n  roles:\n    worker: { model: openai/gpt-5.5 }\n");
	expect(loadConfig(root).config.roles.roles.worker?.model).toBe("openai/gpt-5.5");
	saveModel();
	expect(savedModel()).toBeUndefined();
});
