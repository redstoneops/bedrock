import { describe, expect, it } from "vitest";
import { createId, defaultConfig, idKind, isId, isIdOf, ROLES, shortId, summarizeEntry } from "../src/index.ts";

describe("ids", () => {
	it("creates prefixed ids that round-trip through the parsers", () => {
		const id = createId("mission");
		expect(id.startsWith("mis_")).toBe(true);
		expect(isId(id)).toBe(true);
		expect(isIdOf(id, "mission")).toBe(true);
		expect(isIdOf(id, "gate")).toBe(false);
		expect(idKind(id)).toBe("mission");
	});

	it("rejects malformed ids", () => {
		expect(isId("mission_abc")).toBe(false);
		expect(isIdOf("gat_00000000000000000000000000000000", "gate")).toBe(true);
		expect(idKind("nope")).toBeUndefined();
	});

	it("shortens ids for logs without losing the kind", () => {
		const id = createId("worker");
		expect(shortId(id)).toMatch(/^wrk_[0-9a-f]{8}$/);
	});
});

describe("config", () => {
	it("sensible defaults: gate first, verify with a different model family", () => {
		const config = defaultConfig();
		expect(config.loop.gateFirst).toBe(true);
		expect(config.roles.roles.verifier.requireDifferentFamily).toBe(true);
		expect(config.permissions).toBe("standard");
		expect(new Set(ROLES).size).toBe(ROLES.length);
		for (const role of ROLES) expect(config.roles.roles[role]).toBeDefined();
	});
});

describe("summarizeEntry", () => {
	it("truncates long statements", () => {
		const line = summarizeEntry({ kind: "fact", id: "led_1", statement: "x".repeat(200) });
		expect(line.length).toBeLessThan(140);
		expect(line.endsWith("...")).toBe(true);
	});
});
