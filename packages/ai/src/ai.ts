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

	constructor(options: AiOptions) {
		this.config = options.config;
		this.models = options.models ?? createModels();
		this.cost = new CostTracker();
	}

	/** Routes a role to another model without touching config (used by escalation). */
	escalate(role: Role, model: ModelRef): void {
		this.#overrides.set(role, model);
	}

	/** The model a role resolves to right now. */
	resolve(role: Role): ResolvedModel {
		const roles = this.config.roles as RolesConfig;
		const roleConfig = roles.roles[role] ?? {};
		const ref = this.#overrides.get(role) ?? roleConfig.model ?? roles.default;
		const { provider, id } = parseModelRef(ref);
		const model = this.models.getModel(provider, id);
		if (!model) {
			throw new Error(
				`model "${ref}" for role "${role}" is not in the catalog; check your config or run \`bedrock models\``,
			);
		}
		let fallbacks = [...(roleConfig.fallback ?? [])].filter((ref) => {
			// A fallback that is not in the catalog (unconfigured provider) is dead weight.
			try {
				const parsed = parseModelRef(ref);
				return this.models.getModel(parsed.provider, parsed.id) !== undefined;
			} catch {
				return false;
			}
		});
		if (roleConfig.requireDifferentFamily) {
			const family = provider;
			fallbacks = fallbacks.filter((ref) => parseModelRef(ref).provider !== family);
		}
		return { role, model: model as Model<string>, effort: roleConfig.effort ?? "off", fallbacks };
	}

	/**
	 * Runs one prompt for a role and returns the answer plus its cost. On a
	 * provider error or refusal the next model in the fallback chain is tried;
	 * when the chain is exhausted the error message is returned as text so the
	 * caller decides what to do (the harness never throws on provider errors).
	 */
	async call(
		role: Role,
		prompt: string,
		options: { system?: string; maxTokens?: number; temperature?: number } = {},
	): Promise<AiResult> {
		const resolved = this.resolve(role);
		const chain: ModelRef[] = [
			this.#overrides.get(role) ?? this.config.roles.roles[role]?.model ?? this.config.roles.default,
			...resolved.fallbacks,
		];
		let lastError = "";
		for (let index = 0; index < chain.length; index++) {
			const ref = chain[index];
			const { provider, id } = parseModelRef(ref);
			const model = this.models.getModel(provider, id) as Model<string> | undefined;
			if (!model) {
				lastError = `model "${ref}" is not in the catalog`;
				continue;
			}
			const context: Context = { messages: [{ role: "user", content: prompt, timestamp: Date.now() }] };
			const streamOptions: SimpleStreamOptions = {
				maxTokens: options.maxTokens,
				temperature: options.temperature,
				reasoning: resolved.effort === "off" ? undefined : resolved.effort,
			};
			const message = await this.models.completeSimple(model, context, streamOptions);
			this.cost.add(role, message.usage);
			const text = message.content
				.filter(
					(part): part is Extract<AssistantMessage["content"][number], { type: "text" }> => part.type === "text",
				)
				.map((part) => part.text)
				.join("");
			if (message.stopReason === "error" || message.stopReason === "aborted") {
				lastError = message.errorMessage ?? `model "${ref}" stopped with ${message.stopReason}`;
				continue;
			}
			return {
				message,
				text,
				model: ref,
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

/** True when two model refs come from different provider families. */
export function differentFamilies(a: ModelRef, b: ModelRef): boolean {
	try {
		return parseModelRef(a).provider !== parseModelRef(b).provider;
	} catch {
		return false;
	}
}
