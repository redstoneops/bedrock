import { describe, expect, it } from "vitest";
import { describeToolCall, patchPaths, patchPathsFromApplyPatch } from "../src/index.ts";

describe("describeToolCall", () => {
	it("labels common tools the way a reader scans them", () => {
		expect(describeToolCall("read", { path: "src/a.ts", offset: 40 })).toBe("read src/a.ts @40");
		expect(describeToolCall("bash", { command: "npm   test\n -- --run" })).toBe("$ npm test -- --run");
		expect(describeToolCall("edit", { patch: "¶src/a.ts#ABCD\nPUT 1\nx\n¶src/b.ts\nCUT 2" })).toBe(
			"edit src/a.ts, src/b.ts",
		);
		expect(describeToolCall("grep", { pattern: "TODO", path: "src" })).toBe("grep TODO in src");
		expect(describeToolCall("checks", {})).toBe("checks (visible gate)");
		expect(describeToolCall("mystery", null)).toBe("mystery");
	});

	it("clips long labels and survives hostile arguments", () => {
		expect(describeToolCall("bash", { command: "x".repeat(500) }).length).toBeLessThanOrEqual(120);
		expect(describeToolCall("read", { path: 42 })).toBe("read ?");
	});

	it("extracts paths from hashline and apply_patch formats", () => {
		expect(patchPaths("¶a.ts#0000\nPUT 1\n¶a.ts\nCUT 1")).toEqual(["a.ts"]);
		expect(
			patchPathsFromApplyPatch("*** Begin Patch\n*** Update File: a.ts\n*** Add File: b.ts\n*** End Patch"),
		).toEqual(["a.ts", "b.ts"]);
	});
});
