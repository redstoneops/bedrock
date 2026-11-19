// @bedrock/cli: configuration loading and merging.
//
// Precedence: built-in defaults < ~/.bedrock/config.yml < .bedrock/config.yml <
// command-line flags. Unknown keys are reported, not ignored, so a typo does not
// silently disable a guard.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
	type BedrockConfig,
	type BudgetLimits,
	defaultConfig,
	type LoopConfig,
	type Role,
	type RolesConfig,
} from "@bedrock/protocol";
import { parse as parseYaml } from "yaml";

export interface LoadedConfig {
	config: BedrockConfig;
	sources: string[];
	warnings: string[];
}

function readYaml(path: string): { value: Record<string, unknown>; error?: string } | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const parsed = parseYaml(readFileSync(path, "utf8")) as unknown;
		if (parsed === null || typeof parsed !== "object")
			return { value: {}, error: `${path}: expected a YAML mapping` };
		return { value: parsed as Record<string, unknown> };
	} catch (error) {
		return { value: {}, error: `${path}: ${(error as Error).message}` };
	}
}

const KNOWN_KEYS = new Set([
	"roles",
	"loop",
	"budget",
	"edits",
	"permissions",
	"isolation",
	"memory",
	"containerImage",
	"stateDir",
]);

/** Loads and merges the user and project config. Never throws on a missing file. */
export function loadConfig(cwd: string): LoadedConfig {
	const config = defaultConfig();
	const sources: string[] = ["defaults"];
	const warnings: string[] = [];
	const paths = [join(homedir(), ".bedrock", "config.yml"), join(cwd, ".bedrock", "config.yml")];
	for (const path of paths) {
		const loaded = readYaml(path);
		if (!loaded) continue;
		if (loaded.error) {
			warnings.push(loaded.error);
			continue;
		}
		sources.push(path);
		const value = loaded.value;
		for (const key of Object.keys(value)) {
			if (!KNOWN_KEYS.has(key)) warnings.push(`${path}: unknown config key "${key}" (ignored)`);
		}
		if (value.roles && typeof value.roles === "object") {
			const roles = value.roles as Partial<RolesConfig> & { default?: string };
			if (roles.default) config.roles.default = roles.default;
			if (roles.roles && typeof roles.roles === "object") {
				config.roles.roles = { ...config.roles.roles, ...(roles.roles as RolesConfig["roles"]) };
			}
		}
		if (value.loop && typeof value.loop === "object")
			config.loop = { ...config.loop, ...(value.loop as Partial<LoopConfig>) };
		if (value.budget && typeof value.budget === "object")
			config.budget = { ...config.budget, ...(value.budget as BudgetLimits) };
		if (value.edits && typeof value.edits === "object")
			config.edits = { ...config.edits, ...(value.edits as BedrockConfig["edits"]) };
		if (value.memory && typeof value.memory === "object")
			config.memory = { ...config.memory, ...(value.memory as BedrockConfig["memory"]) };
		if (typeof value.permissions === "string" && ["yolo", "standard", "strict"].includes(value.permissions)) {
			config.permissions = value.permissions as BedrockConfig["permissions"];
		}
		if (typeof value.isolation === "string" && ["worktree", "copy", "container"].includes(value.isolation)) {
			config.isolation = value.isolation as BedrockConfig["isolation"];
		}
		if (typeof value.containerImage === "string") config.containerImage = value.containerImage;
		if (typeof value.stateDir === "string") config.stateDir = value.stateDir;
	}
	config.stateDir = resolve(cwd, config.stateDir);
	return { config, sources, warnings };
}

/** Applies command-line overrides that map directly onto config keys. */
export function applyOverrides(
	config: BedrockConfig,
	overrides: {
		model?: string;
		role?: Role;
		maxUsd?: number;
		permissions?: string;
		isolation?: string;
		parallel?: number;
	},
): BedrockConfig {
	const next: BedrockConfig = {
		...config,
		roles: { ...config.roles, roles: { ...config.roles.roles } },
		loop: { ...config.loop },
		budget: { ...config.budget },
	};
	if (overrides.model) {
		if (overrides.role)
			next.roles.roles[overrides.role] = { ...next.roles.roles[overrides.role], model: overrides.model };
		else next.roles.roles.worker = { ...next.roles.roles.worker, model: overrides.model };
	}
	if (overrides.maxUsd !== undefined) next.budget = { ...next.budget, usd: overrides.maxUsd };
	if (overrides.parallel !== undefined) {
		next.loop = { ...next.loop, maxParallelWorkers: overrides.parallel };
		next.budget = { ...next.budget, maxParallelWorkers: overrides.parallel };
	}
	if (overrides.permissions && ["yolo", "standard", "strict"].includes(overrides.permissions))
		next.permissions = overrides.permissions as BedrockConfig["permissions"];
	if (overrides.isolation && ["worktree", "copy", "container"].includes(overrides.isolation))
		next.isolation = overrides.isolation as BedrockConfig["isolation"];
	return next;
}
