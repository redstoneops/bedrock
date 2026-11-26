import { defaultConfig } from "@bedrock/protocol";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { expect, it, vi } from "vitest";
import { Ai, enableModelDiscovery, hasUnknownPricing, refreshModelCatalog } from "../src/index.ts";

it("replaces the bundled OpenAI chat list with account IDs and resolves a previously unknown GPT model", async () => {
	const models = builtinModels();
	const baseline = models.getModels("openai");
	const known = baseline[0];
	const fetchCatalog = vi.fn<typeof fetch>().mockResolvedValue(
		Response.json({
			data: [{ id: known.id }, { id: "gpt-9-preview" }, { id: "text-embedding-9" }, { id: "gpt-9-realtime" }],
		}),
	);
	enableModelDiscovery(models, fetchCatalog);
	await models.login("openai", "api_key", { prompt: async () => "faux-api-key", notify: () => {} });
	await refreshModelCatalog(models, { providers: ["openai"] });
	expect(fetchCatalog).toHaveBeenCalledWith(
		"https://api.openai.com/v1/models",
		expect.objectContaining({
			headers: { accept: "application/json", authorization: "Bearer faux-api-key" },
			redirect: "error",
		}),
	);
	expect((await models.getAvailable("openai")).map((model) => model.id)).toEqual([known.id, "gpt-9-preview"]);
	expect(models.getModel("openai", known.id)).toBe(known);
	const config = defaultConfig();
	config.roles.roles.worker.model = "openai/gpt-9-preview";
	const selected = new Ai({ config, models }).resolve("worker").model;
	expect(selected).toMatchObject({ id: "gpt-9-preview", api: "openai-responses", baseUrl: known.baseUrl });
	expect(hasUnknownPricing(selected)).toBe(true);

	fetchCatalog.mockResolvedValueOnce(new Response(null, { status: 503 }));
	const note = vi.fn();
	await refreshModelCatalog(models, { providers: ["openai"], note });
	expect(note).toHaveBeenCalledWith(expect.stringContaining("live model discovery failed"));
	expect(models.getModel("openai", "gpt-9-preview")).toBeUndefined();
	expect(models.getModels("openai")).toEqual(baseline);
});

it("uses the OAuth account and keeps Codex-only models available without exposing hidden entries", async () => {
	const expires = Date.now() + 120_000;
	const models = builtinModels({
		credentials: {
			read: async (id) =>
				id === "openai-codex"
					? { type: "oauth", access: "faux-codex", refresh: "faux-refresh", expires, accountId: "faux-account" }
					: undefined,
			list: async () => [],
			modify: async () => {
				throw new Error("must not refresh a valid token");
			},
			delete: async () => {},
		},
	});
	const fetchCatalog = vi.fn<typeof fetch>().mockResolvedValue(
		Response.json({
			models: [
				{ slug: "codex-preview", visibility: "list", supported_in_api: false, context_window: 160_000 },
				{ slug: "hidden-preview", visibility: "hide" },
			],
		}),
	);
	enableModelDiscovery(models, fetchCatalog);
	await refreshModelCatalog(models, { providers: ["openai", "openai-codex"] });
	expect(fetchCatalog).toHaveBeenCalledOnce();
	expect(fetchCatalog).toHaveBeenCalledWith(
		expect.stringContaining("https://chatgpt.com/backend-api/codex/models?"),
		expect.objectContaining({
			headers: expect.objectContaining({ authorization: "Bearer faux-codex", "chatgpt-account-id": "faux-account" }),
		}),
	);
	expect(models.getModels("openai-codex")).toMatchObject([
		{ id: "codex-preview", contextWindow: 160_000, api: "openai-codex-responses" },
	]);
});

it("follows provider pagination without following redirects and excludes non-chat Gemini entries", async () => {
	const models = builtinModels();
	const fetchCatalog = vi
		.fn<typeof fetch>()
		.mockResolvedValueOnce(
			Response.json({
				nextPageToken: "next/page",
				models: [
					{
						name: "models/gemini-9-pro",
						supportedGenerationMethods: ["generateContent"],
						inputTokenLimit: 100_000,
					},
				],
			}),
		)
		.mockResolvedValueOnce(
			Response.json({
				models: [
					{
						name: "models/gemini-9-tts",
						supportedGenerationMethods: ["generateContent"],
					},
				],
			}),
		);
	enableModelDiscovery(models, fetchCatalog);
	await models.login("google", "api_key", { prompt: async () => "faux-key", notify: () => {} });
	await refreshModelCatalog(models, { providers: ["google"] });
	expect(fetchCatalog).toHaveBeenCalledTimes(2);
	expect(new URL(fetchCatalog.mock.calls[1][0] as string).searchParams.get("pageToken")).toBe("next/page");
	expect(models.getModels("google")).toMatchObject([{ id: "gemini-9-pro", contextWindow: 100_000 }]);
});
