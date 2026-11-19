// @bedrock/protocol: model roles and the configuration surface shared by every package.

/** A reasoning effort hint forwarded to pi-ai when the model supports it. */
export type Effort = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/**
 * Every distinct job the harness asks a model to do. Roles exist so that a
 * cheap model can scout while a strong one works, and so that verification can
 * deliberately use a different model family than the worker it judges.
 */
export const ROLES = [
	"scout",
	"strategist",
	"worker",
	"advisor",
	"verifier",
	"judge",
	"red_team",
	"reflector",
	"curator",
	"commit",
	"smol",
] as const;

export type Role = (typeof ROLES)[number];

/** `provider/model-id#variant`, the same reference pi-ai uses. */
export type ModelRef = string;

export interface RoleConfig {
	/** Primary model. When omitted the role inherits the default role model. */
	model?: ModelRef;
	/** Ordered fallbacks tried on provider failure or refusal. */
	fallback?: ModelRef[];
	effort?: Effort;
	/** Hard cap on output tokens for calls made by this role. */
	maxTokens?: number;
	/**
	 * When true, this role refuses to reuse the worker's model family if another
	 * family is available. Used for verifier, judge and red_team by default.
	 */
	requireDifferentFamily?: boolean;
	/** Extra system-prompt text appended for this role only. */
	instructions?: string;
}

export interface RolesConfig {
	/** Role used when a mission does not specify one. */
	default: ModelRef;
	roles: Record<Role, RoleConfig>;
}

/** Budgets are hard limits enforced by the harness, never by the model. */
export interface BudgetLimits {
	usd?: number;
	tokens?: number;
	wallClockMs?: number;
	turns?: number;
	/** Maximum simultaneous worker processes. */
	maxParallelWorkers?: number;
}

export type SelectionMode = "rtv" | "judge" | "first_pass";
export type RefineMode = "pdr" | "continue" | "none";
export type IsolationMode = "worktree" | "copy" | "container";
export type EditFormat = "hashline" | "str_replace" | "patch";
export type PermissionPreset = "yolo" | "standard" | "strict";
export type MissionMode = "interactive" | "run" | "quick";

/** The `loop:` block of a mission configuration. */
export interface LoopConfig {
	/** Compile a gate before solving. Disable only for `quick` mode. */
	gateFirst: boolean;
	maxParallelWorkers: number;
	/** Sequential turn cap per worker before the budget policy prefers parallel rollouts. */
	workerTurnCap: number;
	selection: SelectionMode;
	refine: RefineMode;
	/** Run the advisor model after each worker turn. */
	advisor: boolean;
	/** Run the L4 adversarial reviewer before declaring success. */
	redTeam: boolean;
	/** Run the kernel-backed execution substrate alongside first-class tools. */
	kernel: boolean;
}

export interface EditsConfig {
	default: EditFormat;
	fallback: EditFormat[];
	/** Lines of context included in hashline read snippets. */
	contextLines: number;
}

export interface MemoryConfig {
	playbook: boolean;
	/** A refinement that touches verification behavior needs a held-out eval pass. */
	refineRequiresHoldout: boolean;
	/** Commit `.bedrock/playbook` so a team shares lessons. */
	sharePlaybook: boolean;
}

/** Fully resolved configuration for a mission. Project values override user values. */
export interface BedrockConfig {
	roles: RolesConfig;
	loop: LoopConfig;
	budget: BudgetLimits;
	edits: EditsConfig;
	permissions: PermissionPreset;
	isolation: IsolationMode;
	memory: MemoryConfig;
	/** Container image used by the container isolation mode and `--container`. */
	containerImage?: string;
	/** Root under which mission state is stored (`<cwd>/.bedrock` by default). */
	stateDir: string;
}

/** The built-in defaults for every config key. */
export function defaultConfig(): BedrockConfig {
	return {
		roles: {
			default: "anthropic/claude-sonnet-5",
			roles: {
				scout: { model: "anthropic/claude-haiku-5", effort: "low" },
				strategist: { effort: "high" },
				worker: { effort: "high" },
				advisor: { effort: "medium" },
				verifier: { effort: "high", requireDifferentFamily: true },
				judge: { effort: "medium", requireDifferentFamily: true },
				red_team: { effort: "high", requireDifferentFamily: true },
				reflector: { effort: "medium" },
				curator: { effort: "low" },
				commit: { effort: "low" },
				smol: { model: "anthropic/claude-haiku-5", effort: "low" },
			},
		},
		loop: {
			gateFirst: true,
			maxParallelWorkers: 4,
			workerTurnCap: 120,
			selection: "rtv",
			refine: "pdr",
			advisor: true,
			redTeam: true,
			kernel: false,
		},
		budget: { usd: 20, wallClockMs: 4 * 60 * 60 * 1000, maxParallelWorkers: 4 },
		edits: { default: "hashline", fallback: ["str_replace", "patch"], contextLines: 3 },
		permissions: "standard",
		isolation: "worktree",
		memory: { playbook: true, refineRequiresHoldout: true, sharePlaybook: false },
		stateDir: ".bedrock",
	};
}
