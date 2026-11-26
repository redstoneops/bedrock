// @bedrock/context: model roles, fallback, cost tracking and a one-call text helper over pi-ai.

import type { BedrockConfig, Effort, ModelRef, Role, RolesConfig } from "@bedrock/protocol";
import {
	type AssistantMessage,
	type Context,
	calculateCost,
	createModels,
	type Model,
	type Models,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { FEATURED_PROVIDERS, preferredModel } from "./auth.ts";

export interface ResolvedModel {
	role: Role;
	model: Model<string>;
	effort: Effort;
	/** Ordered fallback models, resolved lazily by `call`. */
	fallbacks: ModelRef[];
}

export interface AiOptions {
	config: BedrockConfig;
	/** Injected for tests: a `Models` collection with a faux provider registered. */
	models?: Models;
}

/** An assistant turn plus what it cost. */
export interface AiResult {
	message: AssistantMessage;
	text: string;
	model: string;
	costUsd: number;
	tokens: number;
	/** True when a fallback model produced the answer. */
	usedFallback: boolean;
}

/** Accumulates spend across a mission. All values are harness-computed. */
export class CostTracker {
	usd = 0;
	tokens = 0;
	calls = 0;
	#byRole = new Map<string, { usd: number; tokens: number }>();

	add(role: string, usage: AssistantMessage["usage"] | undefined): void {
		if (!usage) return;
		this.usd += usage.cost.total;
		this.tokens += usage.totalTokens;
		this.calls += 1;
		const current = this.#byRole.get(role) ?? { usd: 0, tokens: 0 };
		current.usd += usage.cost.total;
		current.tokens += usage.totalTokens;
		this.#byRole.set(role, current);
	}

	byRole(): Record<string, { usd: number; tokens: number }> {
		return Object.fromEntries(this.#byRole);
	}

	snapshot(): { usd: number; tokens: number; calls: number } {
		return { usd: this.usd, tokens: this.tokens, calls: this.calls };
	}
}

/** Splits `provider/model` into its parts. Throws on a malformed reference. */
export function parseModelRef(ref: ModelRef): { provider: string; id: string; variant?: string } {
	const [base, variant] = ref.split("#");
	const slash = base.indexOf("/");
	if (slash <= 0) throw new Error(`model reference must be "provider/model", got "${ref}"`);
	return { provider: base.slice(0, slash), id: base.slice(slash + 1), variant };
}

/**
 * Resolves roles to models and runs the calls. This is the only place that
 * talks to providers, so routing, fallback and cost accounting live together.
 */
export class Ai {
	readonly config: BedrockConfig;
	readonly models: Models;
	readonly cost: CostTracker;
	#overrides = new Map<Role, ModelRef>();
	#effortOverrides = new Map<Role, Effort>();
	#available?: Set<string>;

	constructor(options: AiOptions) {
		this.config = options.config;
		this.models = options.models ?? createModels();
		this.cost = new CostTracker();
	}

	/** Raises a role's reasoning effort one step (the budget policy's `escalate`). Returns the new effort. */
	escalateEffort(role: Role): Effort {
		const ladder: Effort[] = ["off", "minimal", "low", "medium", "high", "xhigh"];
		const current = this.#effortOverrides.get(role) ?? this.config.roles.roles[role]?.effort ?? "off";
		const next = ladder[Math.min(ladder.length - 1, Math.max(0, ladder.indexOf(current)) + 1)] ?? "high";
		this.#effortOverrides.set(role, next);
		return next;
	}

	/** Routes a role to another model without touching config (used by escalation). */
	escalate(role: Role, model: ModelRef): void {
		this.#overrides.set(role, model);
	}

	/**
	 * The model a role resolves to right now. Resolution degrades instead of
	 * failing: an unconfigured catalog (or a stale model id in config) falls back
	 * to the default role's model and then to any available model, because a
	 * harness that cannot run is worse than one running on a fallback. A truly
	 * empty catalog is a configuration error and throws.
	 */
	resolve(role: Role): ResolvedModel {
		const roles = this.config.roles as RolesConfig;
		const roleConfig = roles.roles[role] ?? {};
		const configured = this.#overrides.get(role) ?? roleConfig.model ?? roles.default;
		const fallbacks = [...(roleConfig.fallback ?? [])].filter((ref) => this.#lookup(ref) !== undefined);
		const candidates = [configured, roles.default, ...fallbacks];
		const distinct = candidates.filter((ref, index) => candidates.indexOf(ref) === index);

		let chosen = this.#lookup(configured) ? configured : undefined;
		if (!chosen) {
			for (const reference of distinct) {
				if (this.#lookup(reference)) {
					chosen = reference;
					break;
				}
			}
		}
		if (!chosen && this.#available) {
			// Nothing configured is usable: pick the best model of a provider the user is logged in to.
			const small = role === "scout" || role === "smol" || role === "commit" || role === "curator";
			for (const provider of [...this.#available].sort((a, b) => rank(a) - rank(b))) {
				const model =
					(small ? preferredModel(this.models, provider, "small") : undefined) ??
					preferredModel(this.models, provider);
				if (model) {
					chosen = `${model.provider}/${model.id}`;
					break;
				}
			}
		}
		if (!chosen) {
			if (this.#available) throw new Error('no configured provider; use /login or run "bedrock login"');
			const available = this.models.getModels();
			if (available.length === 0) {
				throw new Error(
					`no models are configured for role "${role}"; set roles.default in config or check provider credentials`,
				);
			}
			const first = available[0];
			chosen = `${first.provider}/${first.id}`;
		}

		const model = this.#lookup(chosen);
		if (!model) throw new Error(`model "${chosen}" is not in the catalog`);
		let effectiveFallbacks = fallbacks;
		if (roleConfig.requireDifferentFamily) {
			const family = parseModelRef(chosen).provider;
			effectiveFallbacks = effectiveFallbacks.filter((ref) => parseModelRef(ref).provider !== family);
		}
		return {
			role,
			model,
			effort: this.#effortOverrides.get(role) ?? roleConfig.effort ?? "off",
			fallbacks: effectiveFallbacks,
		};
	}

	/**
	 * Restricts resolution to providers with credentials. Call after checking
	 * auth (see `configuredProviders`); before that, every catalog model counts.
	 */
	setAvailableProviders(providers: Iterable<string>): void {
		this.#available = new Set(providers);
	}

	#lookup(ref: ModelRef): Model<string> | undefined {
		try {
			const { provider, id } = parseModelRef(ref);
			if (this.#available && !this.#available.has(provider)) return undefined;
			return this.models.getModel(provider, id) as Model<string> | undefined;
		} catch {
			return undefined;
		}
	}

	/**
	 * Runs one prompt for a role and returns the answer plus its cost. On a
	 * provider error or refusal the next model in the fallback chain is tried;
	 * when the chain is exhausted the error message is thrown so the caller can
	 * decide (the harness treats a failed role call as a failed step, not a crash).
	 */
	async call(
		role: Role,
		prompt: string,
		options: { system?: string; maxTokens?: number; temperature?: number } = {},
	): Promise<AiResult> {
		const resolved = this.resolve(role);
		const chain = [
			resolved.model,
			...resolved.fallbacks
				.map((ref) => this.#lookup(ref))
				.filter((model): model is Model<string> => model !== undefined),
		];
		let lastError = "";
		for (let index = 0; index < chain.length; index++) {
			const model = chain[index];
			const context: Context = { messages: [{ role: "user", content: prompt, timestamp: Date.now() }] };
			const streamOptions: SimpleStreamOptions = {
				maxTokens: options.maxTokens,
				temperature: options.temperature,
				reasoning: resolved.effort === "off" ? undefined : resolved.effort,
			};
			const message = await this.models.completeSimple(model, context, streamOptions);
			this.cost.add(role, message.usage);
			const textPart = message.content
				.filter(
					(part): part is Extract<AssistantMessage["content"][number], { type: "text" }> => part.type === "text",
				)
				.map((part) => part.text)
				.join("");
			if (message.stopReason === "error" || message.stopReason === "aborted") {
				lastError =
					message.errorMessage ?? `model "${model.provider}/${model.id}" stopped with ${message.stopReason}`;
				continue;
			}
			return {
				message,
				text: textPart,
				model: `${model.provider}/${model.id}`,
				costUsd: message.usage.cost.total,
				tokens: message.usage.totalTokens,
				usedFallback: index > 0,
			};
		}
		throw new Error(`all models for role "${role}" failed: ${lastError}`);
	}

	/** Cost of a usage record for a specific model, for tool results that report usage. */
	priceOf(model: Model<string>, usage: AssistantMessage["usage"]): number {
		return calculateCost(model, usage).total;
	}
}

function rank(provider: string): number {
	const index = FEATURED_PROVIDERS.indexOf(provider);
	return index < 0 ? 999 : index;
}

/** True when two model refs come from different provider families. */
export function differentFamilies(a: ModelRef, b: ModelRef): boolean {
	try {
		return parseModelRef(a).provider !== parseModelRef(b).provider;
	} catch {
		return false;
	}
}
