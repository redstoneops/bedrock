import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ArtifactStore } from "@bedrock/context";
import { MemoryAuditLog, Sandbox } from "@bedrock/sandbox";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it } from "vitest";
import {
	applySection,
	contentTag,
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createReadTool,
	createTools,
	createWriteTool,
	diffStat,
	parsePatch,
	parseSectionHeader,
	renderTaggedFile,
	type ToolContext,
} from "../src/index.ts";

const dirs: string[] = [];
function workspace(files: Record<string, string> = {}): string {
	const dir = mkdtempSync(join(tmpdir(), "bedrock-tools-"));
	dirs.push(dir);
	for (const [name, content] of Object.entries(files)) {
		const path = join(dir, name);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, content, "utf8");
	}
	return dir;
}
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function context(root: string): ToolContext {
	return {
		workspace: root,
		sandbox: new Sandbox({ workspace: root, preset: "yolo", autonomous: true, audit: new MemoryAuditLog() }),
		artifacts: new ArtifactStore({ kind: "memory" }),
	};
}

async function run(
	tool: ReturnType<typeof createReadTool> | ReturnType<typeof createEditTool>,
	params: object,
): Promise<AgentToolResult> {
	// Tools are typed per parameter shape; tests exercise the runtime contract.
	return (tool.execute as unknown as (id: string, params: object) => Promise<AgentToolResult>)("call", params);
}

const sample = ["const a = 1;", "const b = 2;", "export function main() {", "  return a + b;", "}", ""].join("\n");

describe("hashline format", () => {
	it("tags content deterministically and heading a file", () => {
		expect(contentTag("abc\n")).toBe(contentTag("abc\r\n"));
		expect(contentTag("abc")).toMatch(/^[0-9A-F]{4}$/);
		const rendered = renderTaggedFile("src/a.ts", sample);
		expect(rendered.text.split("\n")[0]).toBe(`¶src/a.ts#${contentTag(sample)}`);
		expect(rendered.text).toContain("1:const a = 1;");
		expect(rendered.totalLines).toBe(5);
	});

	it("renders windows with a hidden-lines note", () => {
		const rendered = renderTaggedFile("a.ts", sample, { offset: 1, limit: 2 });
		expect(rendered.text).toContain("2:const b = 2;");
		expect(rendered.text).toContain("3:export function main() {");
		expect(rendered.text).toContain("lines 4-5 hidden");
		expect(rendered.truncated).toBe(true);
	});

	it("parses headers with and without tags", () => {
		expect(parseSectionHeader("¶src/a.ts#A3F1")).toEqual({ path: "src/a.ts", tag: "A3F1" });
		expect(parseSectionHeader("[src/a.ts]")).toEqual({ path: "src/a.ts", tag: undefined });
		expect(parseSectionHeader("const x = 1;")).toBeNull();
	});
});

describe("parsePatch and applySection", () => {
	const tag = () => contentTag(sample);

	it("replaces a single line", () => {
		const parsed = parsePatch(`¶a.ts#${tag()}\nPUT 1\nconst a = 10;`);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		const result = applySection(sample, parsed.sections[0]);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.content.split("\n")[0]).toBe("const a = 10;");
		expect(result.preview).toContain("-const a = 1;");
		expect(result.preview).toContain("+const a = 10;");
	});

	it("replaces a range and composes edits against original line numbers", () => {
		const parsed = parsePatch(`¶a.ts#${tag()}\nPUT 1.=2\nconst sum = [1, 2];\nCUT 4`);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		const result = applySection(sample, parsed.sections[0]);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.content.split("\n").slice(0, 4)).toEqual([
			"const sum = [1, 2];",
			"export function main() {",
			"}",
			"",
		]);
	});

	it("inserts before and after, and appends at the end", () => {
		const parsed = parsePatch(`¶a.ts#${tag()}\nPUT 1.<\n// header\nPUT 5.>\n// footer\nPUT .>\nexport default main;`);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		const result = applySection(sample, parsed.sections[0]);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const lines = result.content.split("\n");
		expect(lines[0]).toBe("// header");
		expect(lines[6]).toBe("// footer");
		expect(lines[7]).toBe("export default main;");
	});

	it("keeps insertion order for ops anchored on the same line", () => {
		const parsed = parsePatch(`¶a.ts#${tag()}\nINS.PRE 3\n// one\nINS.PRE 3\n// two\nINS.POST 3\n// three`);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		const result = applySection(sample, parsed.sections[0]);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const lines = result.content.split("\n");
		expect(lines.slice(2, 7)).toEqual([
			"// one",
			"// two",
			"export function main() {",
			"// three",
			"  return a + b;",
		]);
	});

	it("rejects a stale tag without changing anything", () => {
		const parsed = parsePatch("¶a.ts#0000\nPUT 1\nconst a = 10;");
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		const result = applySection(sample, parsed.sections[0]);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toContain("changed since it was read");
		expect(result.error).toContain(`current tag #${tag()}`);
	});

	it("accepts a patch without a tag and rejects out-of-range lines", () => {
		const untagged = parsePatch("¶a.ts\nPUT 1\nconst a = 10;");
		expect(untagged.ok && applySection(sample, untagged.sections[0]).ok).toBe(true);
		const bad = parsePatch("¶a.ts\nPUT 99\nx");
		expect(bad.ok).toBe(true);
		if (!bad.ok) return;
		expect(applySection(sample, bad.sections[0])).toMatchObject({ ok: false });
	});

	it("rejects overlapping operations", () => {
		const parsed = parsePatch(`¶a.ts#${tag()}\nPUT 1.=3\nx\nCUT 2`);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		const result = applySection(sample, parsed.sections[0]);
		expect(result.ok).toBe(false);
	});

	it("reports parse errors with context", () => {
		expect(parsePatch("PUT 1\nx")).toMatchObject({ ok: false, error: expect.stringContaining("section header") });
		expect(parsePatch("¶a.ts\n")).toMatchObject({ ok: false, error: expect.stringContaining("no operations") });
		expect(parsePatch("¶a.ts\nhello")).toMatchObject({
			ok: false,
			error: expect.stringContaining("expected an operation"),
		});
	});
});

describe("file tools", () => {
	it("reads a file with line numbers and a tag", async () => {
		const root = workspace({ "a.ts": sample });
		const result = await run(createReadTool(context(root)), { path: "a.ts" });
		const body = result.content[0].type === "text" ? result.content[0].text : "";
		expect(body).toContain(`¶a.ts#${contentTag(sample)}`);
		expect(body).toContain("4:  return a + b;");
	});

	it("refuses paths outside the workspace and missing files", async () => {
		const root = workspace();
		const tool = createReadTool(context(root));
		expect((await run(tool, { path: "../etc/passwd" })).isError).toBe(true);
		expect((await run(tool, { path: "nope.ts" })).isError).toBe(true);
	});

	it("writes a new file, then requires the tag to replace it", async () => {
		const root = workspace();
		const write = createWriteTool(context(root));
		await run(write, { path: "new.ts", content: "¶new.ts\nexport const x = 1;\n" });
		expect(readFileSync(join(root, "new.ts"), "utf8")).toBe("export const x = 1;\n");
		const refused = await run(write, { path: "new.ts", content: "unconditional" });
		expect(refused.isError).toBe(true);
		const accepted = await run(write, {
			path: "new.ts",
			content: `¶new.ts#${contentTag("export const x = 1;\n")}\nexport const x = 2;\n`,
		});
		expect(accepted.isError).toBeFalsy();
		expect(readFileSync(join(root, "new.ts"), "utf8")).toBe("export const x = 2;\n");
	});

	it("edits a file through the tool and reports the diff", async () => {
		const root = workspace({ "a.ts": sample });
		const edit = createEditTool(context(root));
		const result = await run(edit, { patch: `¶a.ts#${contentTag(sample)}\nPUT 2\nconst b = 20;` });
		expect(result.isError).toBeFalsy();
		const body = result.content[0].type === "text" ? result.content[0].text : "";
		expect(body).toContain("+const b = 20;");
		expect(readFileSync(join(root, "a.ts"), "utf8")).toContain("const b = 20;");
	});

	it("leaves every file untouched when one section is stale", async () => {
		const root = workspace({ "a.ts": sample, "b.ts": "one\ntwo\n" });
		const edit = createEditTool(context(root));
		const result = await run(edit, {
			patch: `¶a.ts#${contentTag(sample)}\nPUT 1\nchanged\n¶b.ts#0000\nPUT 1\nchanged`,
		});
		expect(result.isError).toBe(true);
		expect(readFileSync(join(root, "a.ts"), "utf8")).toBe(sample);
		expect(readFileSync(join(root, "b.ts"), "utf8")).toBe("one\ntwo\n");
	});
});

describe("search tools", () => {
	it("finds files by glob and substring", async () => {
		const root = workspace({ "src/a.ts": "x", "src/b.test.ts": "y", "docs/readme.md": "z" });
		const find = createFindTool(context(root));
		const byGlob = await run(find as never, { pattern: "src/*.ts" });
		const text1 = byGlob.content[0].type === "text" ? byGlob.content[0].text : "";
		expect(text1).toContain("src/a.ts");
		expect(text1).toContain("src/b.test.ts");
		expect(text1).not.toContain("docs/readme.md");
		const bySubstring = await run(find as never, { contains: ".test." });
		const text2 = bySubstring.content[0].type === "text" ? bySubstring.content[0].text : "";
		expect(text2.trim()).toBe("src/b.test.ts");
	});

	it("greps contents with a regex", async () => {
		const root = workspace({ "src/a.ts": "const answer = 42;\n", "src/b.ts": "const other = 43;\n" });
		const grep = createGrepTool(context(root));
		const result = await run(grep as never, { pattern: "answer\\s*=\\s*\\d+", path: "src" });
		const body = result.content[0].type === "text" ? result.content[0].text : "";
		expect(body).toContain("src/a.ts:1:const answer = 42;");
		expect(body).not.toContain("b.ts");
	});
});

describe("bash tool", () => {
	it("runs a command and reports exit code", async () => {
		const root = workspace();
		const bash = createBashTool(context(root));
		const result = await run(bash as never, { command: "echo hello" });
		const body = result.content[0].type === "text" ? result.content[0].text : "";
		expect(body).toContain("exit 0");
		expect(body).toContain("hello");
	});

	it("marks a failing command as an error", async () => {
		const root = workspace();
		const bash = createBashTool(context(root));
		const result = await run(bash as never, { command: "exit 3" });
		expect(result.isError).toBe(true);
		expect(result.content[0].type === "text" ? result.content[0].text : "").toContain("exit 3");
	});

	it("refuses a command the policy denies", async () => {
		const root = workspace({ ".env": "SECRET=1" });
		const ctx = context(root);
		ctx.sandbox = new Sandbox({
			workspace: root,
			preset: "standard",
			autonomous: false,
			audit: new MemoryAuditLog(),
		});
		const bash = createBashTool(ctx);
		const result = await run(bash as never, { command: "cat .env" });
		expect(result.isError).toBe(true);
		expect(result.content[0].type === "text" ? result.content[0].text : "").toContain("denied");
	});
});

describe("registry and helpers", () => {
	it("builds the default tool set and honors exclusions", () => {
		const root = workspace();
		const ctx = context(root);
		const names = createTools(ctx).map((tool) => tool.name);
		expect(names).toEqual(["read", "write", "edit", "grep", "find", "ls", "bash", "todo", "ask"]);
		expect(createTools(ctx, { exclude: ["bash", "ask"] }).map((tool) => tool.name)).not.toContain("bash");
		expect(createTools(ctx).every((tool) => (tool.parameters as { type?: string }).type === "object")).toBe(true);
	});

	it("counts diff additions and deletions", () => {
		expect(diffStat("a\nb\nc\n", "a\nB\nc\nd\n")).toEqual({ additions: 2, deletions: 1 });
	});
});
