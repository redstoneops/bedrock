import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactStore } from "@bedrock/context";
import { MemoryAuditLog, Sandbox } from "@bedrock/sandbox";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it } from "vitest";
import {
	applyHunks,
	createApplyPatchTool,
	createArtifactTool,
	createStrReplaceTool,
	parseApplyPatch,
	type ToolContext,
} from "../src/index.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function context(files: Record<string, string> = {}): ToolContext {
	const root = mkdtempSync(join(tmpdir(), "bedrock-patch-"));
	dirs.push(root);
	for (const [name, content] of Object.entries(files)) writeFileSync(join(root, name), content);
	return {
		workspace: root,
		sandbox: new Sandbox({ workspace: root, preset: "yolo", autonomous: true, audit: new MemoryAuditLog() }),
		artifacts: new ArtifactStore({ kind: "memory" }),
	};
}

async function call(tool: { execute: unknown }, params: object): Promise<AgentToolResult<unknown>> {
	return (tool.execute as (id: string, params: object) => Promise<AgentToolResult<unknown>>)("c", params);
}

const text = (result: AgentToolResult<unknown>) => (result.content[0]?.type === "text" ? result.content[0].text : "");

describe("apply_patch grammar", () => {
	it("parses add, update with move, and delete", () => {
		const parsed = parseApplyPatch(
			"*** Begin Patch\n*** Add File: n.ts\n+one\n*** Update File: a.ts\n*** Move to: b.ts\n@@ fn\n x\n-y\n+z\n*** Delete File: old.ts\n*** End Patch",
		);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.operations.map((operation) => operation.kind)).toEqual(["add", "update", "delete"]);
		const update = parsed.operations[1];
		expect(update.kind === "update" && update.moveTo).toBe("b.ts");
	});

	it("rejects malformed patches with a useful message", () => {
		expect(parseApplyPatch("*** Update File: a.ts")).toMatchObject({
			ok: false,
			error: expect.stringContaining("Begin Patch"),
		});
		expect(parseApplyPatch("*** Begin Patch\n*** Add File: a\nno plus\n*** End Patch")).toMatchObject({ ok: false });
		expect(parseApplyPatch("*** Begin Patch\n*** Update File: a\n x\n")).toMatchObject({
			ok: false,
			error: expect.stringContaining("End Patch"),
		});
	});

	it("locates hunks exactly, then ignoring whitespace drift", () => {
		const source = "function a() {\n  return 1;\n}\nfunction b() {\n  return 2;  \n}\n";
		const exact = applyHunks(
			source,
			[{ before: ["function a() {", "  return 1;"], after: ["function a() {", "  return 10;"], endOfFile: false }],
			"x",
		);
		expect(exact.ok && exact.content).toContain("return 10;");
		const fuzzy = applyHunks(source, [{ before: ["return 2;"], after: ["  return 20;"], endOfFile: false }], "x");
		expect(fuzzy.ok && fuzzy.content).toContain("return 20;");
		expect(applyHunks(source, [{ before: ["nope"], after: [], endOfFile: false }], "x")).toMatchObject({ ok: false });
	});

	it("applies a multi-file patch atomically through the tool", async () => {
		const ctx = context({ "a.ts": "const x = 1;\nconst y = 2;\n", "old.ts": "bye\n" });
		const result = await call(createApplyPatchTool(ctx), {
			patch: "*** Begin Patch\n*** Update File: a.ts\n const x = 1;\n-const y = 2;\n+const y = 3;\n*** Add File: n.ts\n+hello\n*** Delete File: old.ts\n*** End Patch",
		});
		expect(result.isError).toBeFalsy();
		expect(readFileSync(join(ctx.workspace, "a.ts"), "utf8")).toBe("const x = 1;\nconst y = 3;\n");
		expect(readFileSync(join(ctx.workspace, "n.ts"), "utf8")).toBe("hello\n");
		expect(existsSync(join(ctx.workspace, "old.ts"))).toBe(false);
		const failed = await call(createApplyPatchTool(ctx), {
			patch: "*** Begin Patch\n*** Add File: z.ts\n+z\n*** Update File: a.ts\n-missing\n+x\n*** End Patch",
		});
		expect(failed.isError).toBe(true);
		expect(existsSync(join(ctx.workspace, "z.ts"))).toBe(false);
	});
});

describe("str_replace", () => {
	it("replaces a unique occurrence and refuses ambiguity", async () => {
		const ctx = context({ "a.ts": "let a = 1;\nlet b = 1;\n" });
		const tool = createStrReplaceTool(ctx);
		expect((await call(tool, { path: "a.ts", old: "= 1;", new: "= 2;" })).isError).toBe(true);
		const ok = await call(tool, { path: "a.ts", old: "let b = 1;", new: "let b = 2;" });
		expect(ok.isError).toBeFalsy();
		expect(readFileSync(join(ctx.workspace, "a.ts"), "utf8")).toBe("let a = 1;\nlet b = 2;\n");
		expect(text(await call(tool, { path: "a.ts", old: "zzz", new: "" }))).toContain("not found");
	});
});

describe("artifact tool", () => {
	it("pages and greps stored outputs by handle", async () => {
		const ctx = context();
		const stored = ctx.artifacts.put(
			Array.from({ length: 500 }, (_, index) => (index === 321 ? "ERROR: boom" : `line ${index}`)).join("\n"),
		);
		const tool = createArtifactTool(ctx);
		expect(text(await call(tool, { id: stored.id, pattern: "ERROR" }))).toBe("322:ERROR: boom");
		expect(text(await call(tool, { id: stored.id, offset: 10, limit: 2 }))).toBe("11:line 10\n12:line 11");
		expect((await call(tool, { id: "art_deadbeef" })).isError).toBe(true);
	});
});
