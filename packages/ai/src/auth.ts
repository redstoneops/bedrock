// @bedrock/ai: provider logins, status and model preferences.
//
// pi-ai owns the actual login flows (API-key prompts, OAuth with a browser,
// device codes) and token refresh. This module lists providers in the order a
// coding user cares about, runs a login through a surface-supplied interaction
// (the CLI's readline or the TUI), and picks a sensible default model for
// whatever the user is logged in to.

import type { AuthInteraction, AuthType, LoginOptions, Model, Models, MutableModels } from "@earendil-works/pi-ai";

/** Providers shown first, in this order; the rest follow alphabetically. */
export const FEATURED_PROVIDERS = [
	"anthropic",
	"openai",
	"openai-codex",
	"google",
	"deepseek",
	"openrouter",
	"xai",
	"github-copilot",
	"mistral",
	"groq",
	"moonshotai",
	"kimi-coding",
	"zai",
	"together",
	"fireworks",
];

/** Model preferred per provider when the user has not chosen one, best first. */
export const PREFERRED_MODELS: Record<string, string[]> = {
	anthropic: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-opus-5", "claude-sonnet-5"],
	openai: ["gpt-5.5", "gpt-6.1-sol", "gpt-6-sol", "gpt-5.4", "gpt-5"],
	"openai-codex": ["gpt-5.5", "gpt-5.3-codex", "gpt-5.4"],
	google: ["gemini-4-argon", "gemini-3.8-flash", "gemini-3.1-pro-preview", "gemini-2.5-pro"],
	deepseek: ["deepseek-v4-pro", "deepseek-flash"],
	openrouter: ["anthropic/claude-sonnet-5-5", "openai/gpt-5.5", "deepseek/deepseek-v4-pro"],
	xai: ["grok-4.7", "grok-4.6"],
	"github-copilot": ["claude-sonnet-5-5", "gpt-5.5", "claude-sonnet-5"],
	mistral: ["devstral-latest", "mistral-large-latest"],
	"kimi-coding": ["kimi-for-coding", "k3.1-pro-highspeed"],
	moonshotai: ["kimi-k3"],
	zai: ["glm-5.3", "glm-5"],
};

/** Cheap model preferred per provider for scout/smol roles. */
export const SMALL_MODELS: Record<string, string[]> = {
	anthropic: ["claude-haiku-5-5", "claude-haiku-4-5"],
	openai: ["gpt-5.4-mini", "gpt-5-mini"],
	google: ["gemini-3.8-flash", "gemini-3.5-flash", "gemini-2.5-flash"],
	deepseek: ["deepseek-flash"],
};

export interface ProviderInfo {
	id: string;
	name: string;
	/** Label of the API-key method, when the provider has one. */
	apiKey?: string;
	/** Label of the subscription/OAuth method, when the provider has one. */
	oauth?: string;
	models: number;
	/** How the provider is currently configured, if at all (e.g. "stored api key", "ANTHROPIC_API_KEY"). */
	configured?: string;
	featured: boolean;
}

/** Lists chat providers with their login methods and current configuration. */
export async function listProviders(models: Models): Promise<ProviderInfo[]> {
	const providers = models.getProviders().filter((provider) => models.getModels(provider.id).length > 0);
	const infos = await Promise.all(
		providers.map(async (provider): Promise<ProviderInfo> => {
			const auth = provider.auth;
			let configured: string | undefined;
			try {
				const check = await models.checkAuth(provider.id, { signal: AbortSignal.timeout(2500) });
				configured = check ? (check.source ?? check.type) : undefined;
			} catch {
				configured = undefined;
			}
			return {
				id: provider.id,
				name: provider.name,
				apiKey: auth.apiKey?.login ? auth.apiKey.name : undefined,
				oauth: auth.oauth ? (auth.oauth.loginLabel ?? auth.oauth.name) : undefined,
				models: models.getModels(provider.id).length,
				configured,
				featured: FEATURED_PROVIDERS.includes(provider.id),
			};
		}),
	);
	return infos.sort((a, b) => {
		const ai = FEATURED_PROVIDERS.indexOf(a.id);
		const bi = FEATURED_PROVIDERS.indexOf(b.id);
		if (ai >= 0 || bi >= 0) return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi);
		return a.id.localeCompare(b.id);
	});
}

/** Providers that have usable credentials right now (env, stored key or OAuth). */
export async function configuredProviders(models: Models): Promise<string[]> {
	const providers = await listProviders(models);
	return providers.filter((provider) => provider.configured !== undefined).map((provider) => provider.id);
}

/**
 * Logs in to a provider through pi-ai and stores the credential.
 */
export async function loginProvider(
	models: MutableModels,
	providerId: string,
	type: AuthType,
	interaction: AuthInteraction,
	options?: LoginOptions,
): Promise<void> {
	const provider = models.getProvider(providerId);
	if (!provider) throw new Error(`unknown provider "${providerId}"; run \`bedrock login\` to see the list`);
	const auth = provider.auth;
	if (type === "oauth" && !auth.oauth) throw new Error(`${provider.name} has no subscription login; use an API key`);
	if (type === "api_key" && !auth.apiKey?.login) throw new Error(`${provider.name} has no interactive API-key login`);
	await models.login(providerId, type, interaction, options);
}

export async function logoutProvider(models: MutableModels, providerId: string): Promise<void> {
	if (!models.getProvider(providerId)) throw new Error("unknown provider; use /providers or bedrock providers");
	await models.logout(providerId);
}

/** Picks the best model for a provider: a preferred id if present, else its first chat model. */
export function preferredModel(
	models: Models,
	providerId: string,
	size: "large" | "small" = "large",
): Model<string> | undefined {
	const table = size === "small" ? SMALL_MODELS : PREFERRED_MODELS;
	for (const id of table[providerId] ?? []) {
		const model = models.getModel(providerId, id);
		if (model) return model as Model<string>;
	}
	if (size === "small") return undefined;
	return models.getModels(providerId)[0];
}
