import { defaultConfig } from "@bedrock/protocol";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { Ai, CostTracker, differentFamilies, parseModelRef } from "../src/index.ts";

function testAi(roleModels: string[][] = []): { ai: Ai; faux: ReturnType<typeof fauxProvider> } {
	const faux = fauxProvider({
		models: [
			{ id: "opus", name: "Opus" },
			{ id: "gpt", name: "GPT" },
			{ id: "sonnet", name: "Sonnet" },
		],
	});
	const models = createModels();
	models.setProvider(faux.provider);
	const config = defaultConfig();
	config.roles.default = `faux/sonnet`;
	config.roles.roles.worker = { model: "faux/opus", effort: "high", fallback: roleModels.map(([model]) => model) };
	const ai = new Ai({ config, models });
	return { ai, faux };
}

describe("parseModelRef", () => {
	it("splits provider, id and variant", () => {
		expect(parseModelRef("anthropic/claude-opus-5")).toEqual({
			provider: "anthropic",
			id: "claude-opus-5",
			variant: undefined,
		});
		expect(parseModelRef("openai/gpt-5#xhigh")).toEqual({ provider: "openai", id: "gpt-5", variant: "xhigh" });
		expect(() => parseModelRef("nope")).toThrow();
	});
});

describe("differentFamilies", () => {
	it("compares providers, tolerating malformed refs", () => {
		expect(differentFamilies("anthropic/a", "openai/b")).toBe(true);
		expect(differentFamilies("anthropic/a", "anthropic/b")).toBe(false);
		expect(differentFamilies("bad", "anthropic/b")).toBe(false);
	});
});

describe("Ai", () => {
	it("routes a role to its configured model and reports cost", async () => {
		const { ai, faux } = testAi();
		faux.setResponses([fauxAssistantMessage("the bug is in the lexer")]);
		const result = await ai.call("worker", "find the bug");
		expect(result.text).toBe("the bug is in the lexer");
		expect(result.model).toBe("faux/opus");
		expect(result.usedFallback).toBe(false);
		expect(ai.cost.calls).toBe(1);
		expect(ai.cost.snapshot().tokens).toBeGreaterThan(0);
	});

	it("falls back to the next model when the first errors", async () => {
		const { ai, faux } = testAi([["faux/gpt"]]);
		faux.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded" }),
			fauxAssistantMessage("fallback answer"),
		]);
		const result = await ai.call("worker", "find the bug");
		expect(result.text).toBe("fallback answer");
		expect(result.usedFallback).toBe(true);
		expect(result.model).toBe("faux/gpt");
	});

	it("throws a useful error when every model fails", async () => {
		const { ai, faux } = testAi([["faux/gpt"]]);
		faux.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "a" }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "b" }),
		]);
		await expect(ai.call("worker", "hi")).rejects.toThrow(/all models for role "worker" failed: b/);
	});

	it("degrades a stale configured model to something in the catalog", () => {
		const { ai } = testAi();
		ai.config.roles.roles.scout = { model: "nobody/missing" };
		expect(ai.resolve("scout").model.provider).toBe("faux");
	});

	it("refuses to guess when the catalog is empty", () => {
		const ai = new Ai({ config: defaultConfig(), models: createModels() });
		expect(() => ai.resolve("worker")).toThrow(/no models are configured/);
	});

	it("drops same-family fallbacks when the role requires a different family", () => {
		const { ai } = testAi();
		ai.config.roles.roles.verifier = {
			model: "faux/opus",
			requireDifferentFamily: true,
			fallback: ["faux/sonnet", "other/gpt"],
		};
		const resolved = ai.resolve("verifier");
		expect(resolved.fallbacks).toEqual([]);
	});

	it("tracks cost per role", () => {
		const tracker = new CostTracker();
		const usage = {
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 15,
			cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
		};
		tracker.add("worker", usage);
		tracker.add("worker", usage);
		tracker.add("scout", usage);
		expect(tracker.snapshot()).toEqual({ usd: 0.09, tokens: 45, calls: 3 });
		expect(tracker.byRole().worker).toEqual({ usd: 0.06, tokens: 30 });
	});
});
