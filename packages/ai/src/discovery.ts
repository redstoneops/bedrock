// Refresh provider catalogs in place so listing and model resolution share the same IDs.

import type { Model, Models, MutableModels, Provider, RefreshModelsContext } from "@earendil-works/pi-ai";

type Entry = Record<string, unknown>;
type Catalog = { url: string; headers: Record<string, string>; field: string; id: string };

const unknownPricing = new WeakSet<Model<string>>();

export function hasUnknownPricing(model: Model<string>): boolean {
	return unknownPricing.has(model);
}

function source(provider: string, context: RefreshModelsContext): Catalog | undefined {
	const credential = context.credential;
	const key = credential?.type === "oauth" ? credential.access : credential?.key;
	if (!key) return;
	const bearer = { authorization: `Bearer ${key}` };
	switch (provider) {
		case "openai":
			return { url: "https://api.openai.com/v1/models", headers: bearer, field: "data", id: "id" };
		case "openai-codex": {
			if (credential?.type !== "oauth") return;
			// Codex's model catalog is scoped to the subscription account.
			const headers: Record<string, string> = { ...bearer, originator: "pi" };
			if (typeof credential.accountId === "string") headers["chatgpt-account-id"] = credential.accountId;
			return {
				url: "https://chatgpt.com/backend-api/codex/models?client_version=0.0.0",
				headers,
				field: "models",
				id: "slug",
			};
		}
		case "anthropic":
			if (credential?.type !== "api_key") return;
			return {
				url: "https://api.anthropic.com/v1/models?limit=1000",
				headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
				field: "data",
				id: "id",
			};
		case "deepseek":
			return { url: "https://api.deepseek.com/models", headers: bearer, field: "data", id: "id" };
		case "google":
			return {
				url: "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000",
				headers: { "x-goog-api-key": key },
				field: "models",
				id: "name",
			};
	}
}

function canChat(provider: string, id: string): boolean {
	if (provider === "openai")
		return (
			/^(?:gpt-[45-9]\d*(?:[.-]|$)|o[1-9]\d*(?:-|$))/.test(id) &&
			!/(?:^|-)(?:audio|realtime|transcribe|tts|image|search|moderation|instruct|chat-latest)(?:-|$)/.test(id)
		);
	if (provider === "anthropic") return id.startsWith("claude-");
	if (provider === "deepseek") return id.startsWith("deepseek-") && !/(?:embed|rerank|vision)/.test(id);
	if (provider === "google")
		return id.startsWith("gemini-") && !/(?:embedding|tts|native-audio|live|image|robotics|computer-use)/.test(id);
	return true; // The Codex endpoint already lists coding models.
}

function positiveInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function chatCatalog(
	provider: Provider,
	baseline: readonly Model<string>[],
	entries: unknown[],
	idField: string,
): Model<string>[] {
	const known = new Map(baseline.map((model) => [model.id, model]));
	const available = new Map<string, Model<string>>();
	const template = baseline[0];
	for (const raw of entries) {
		if (!raw || typeof raw !== "object") continue;
		const entry = raw as Entry;
		const rawId = entry[idField];
		const id = typeof rawId === "string" && provider.id === "google" ? rawId.replace(/^models\//, "") : rawId;
		if (typeof id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,199}$/.test(id)) continue;
		if (provider.id === "openai-codex" && entry.visibility && entry.visibility !== "list") continue;
		if (
			provider.id === "google" &&
			(!Array.isArray(entry.supportedGenerationMethods) ||
				!entry.supportedGenerationMethods.includes("generateContent"))
		)
			continue;
		const label = entry.display_name ?? entry.displayName;
		const name = typeof label === "string" ? label.replace(/\p{C}/gu, "").slice(0, 120) : undefined;
		const existing = known.get(id);
		if (existing) {
			available.set(id, existing);
		} else if (template && canChat(provider.id, id)) {
			// Listing APIs often omit prices and limits. Do not borrow them from a different model.
			const model: Model<string> = {
				id,
				name: name || id,
				provider: template.provider,
				api: template.api,
				baseUrl: template.baseUrl,
				input: ["text"],
				reasoning: provider.id === "openai-codex" || /^o\d|^gpt-[5-9]/.test(id),
				contextWindow: positiveInteger(entry.context_window ?? entry.inputTokenLimit) ?? 32_768,
				maxTokens: positiveInteger(entry.max_output_tokens ?? entry.outputTokenLimit) ?? 4096,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			};
			unknownPricing.add(model);
			available.set(id, model);
		}
	}
	// Preserve baseline ordering for automatic fallback; new models are still selectable by ID.
	return [
		...baseline.flatMap(({ id }) => (available.has(id) ? [available.get(id)!] : [])),
		...[...available.values()].filter((model) => !known.has(model.id)).sort((a, b) => a.id.localeCompare(b.id)),
	];
}

/** Adds native account discovery where the installed pi provider only has a static catalog. */
export function enableModelDiscovery(models: MutableModels, fetchCatalog: typeof fetch = fetch): void {
	for (const provider of models.getProviders()) {
		if (
			provider.refreshModels ||
			!["openai", "openai-codex", "anthropic", "deepseek", "google"].includes(provider.id)
		)
			continue;
		const baseline = provider.getModels();
		const other = provider.getAllModels?.().filter((model) => model.type && model.type !== "chat") ?? [];
		let current = baseline;
		models.setProvider({
			...provider,
			getModels: () => current,
			getAllModels: () => [...current, ...other],
			async refreshModels(context) {
				if (!context.allowNetwork) {
					// Clear a previous account's results before checking auth or going to the network.
					await context.publish({
						update: () => {
							current = baseline;
						},
					});
					return;
				}
				const catalog = source(provider.id, context);
				if (!catalog) return;
				const entries: unknown[] = [];
				const endpoint = new URL(catalog.url);
				for (let page = 0; page < 20; page++) {
					const response = await fetchCatalog(endpoint.href, {
						headers: { accept: "application/json", ...catalog.headers },
						redirect: "error",
						signal: context.signal,
					});
					if (!response.ok) throw new Error(`model list returned HTTP ${response.status}`);
					const body = (await response.json()) as Entry | null;
					const batch = body?.[catalog.field];
					if (!Array.isArray(batch)) throw new Error("invalid model catalog response");
					entries.push(...batch);
					const parameter = provider.id === "google" ? "pageToken" : "after_id";
					const next =
						provider.id === "google" ? body?.nextPageToken : body?.has_more === true ? body.last_id : undefined;
					if (next === undefined && body?.has_more !== true) break;
					if (page === 19 || typeof next !== "string" || !next || endpoint.searchParams.get(parameter) === next)
						throw new Error("invalid model catalog pagination");
					endpoint.searchParams.set(parameter, next);
				}
				const discovered = chatCatalog(provider, baseline, entries, catalog.id);
				await context.publish({
					update: () => {
						current = discovered;
					},
				});
			},
		});
	}
}

/** Refreshes configured dynamic providers and reports failures while retaining usable local catalogs. */
export async function refreshModelCatalog(
	models: Models,
	options: {
		providers?: string[];
		signal?: AbortSignal;
		note?: (message: string) => void;
	} = {},
): Promise<void> {
	const timeout = AbortSignal.timeout(6000);
	const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
	const result = await models.refresh({ providers: options.providers, force: true, signal });
	options.signal?.throwIfAborted();
	for (const provider of result.errors.keys())
		options.note?.(`${provider}: live model discovery failed; using the local catalog.`);
	if (result.aborted) options.note?.("Model discovery timed out; using available catalog entries.");
}
