// @bedrock/protocol: permission decisions shared by the sandbox, tools and CLI.

import type { PermissionPreset } from "./roles.ts";

export type PermissionEffect = "allow" | "deny" | "ask";

export interface PermissionDecision {
	effect: PermissionEffect;
	/** Why the decision was made, shown in the TUI and written to the audit log. */
	reason: string;
	/** Rule that produced the decision, when one matched. */
	ruleId?: string;
}

/** A command or tool call the policy is asked about. */
export interface PermissionRequest {
	tool: string;
	/** Shell command for bash-like tools. */
	command?: string;
	cwd?: string;
	/** File paths read or written by the tool, absolute or workspace-relative. */
	paths?: string[];
	/** Network hosts the call would reach. */
	hosts?: string[];
	/** Raw tool arguments, for rules that match on them. */
	args?: Record<string, unknown>;
}

export interface PermissionRule {
	id: string;
	effect: PermissionEffect;
	/** Tool name or `*`. Omitted matches any tool. */
	tool?: string;
	/** Regular expressions matched against the command. */
	commandPatterns?: string[];
	/** Glob patterns matched against absolute paths. */
	pathPatterns?: string[];
	/** Hostnames or `*.example.com`. */
	hosts?: string[];
}

export interface PermissionPolicyConfig {
	preset: PermissionPreset;
	/** Rules are evaluated in order; the first match wins. */
	rules: PermissionRule[];
	/** Workspace root that `workspace-write` style rules are relative to. */
	workspace: string;
	/** In autonomous mode, `ask` degrades to `allow` inside an isolated workspace. */
	autonomous: boolean;
	isolated: boolean;
}

/** The policy engine is stateful only to remember decisions for the audit log. */
export interface PermissionPolicy {
	readonly preset: PermissionPreset;
	check(request: PermissionRequest): PermissionDecision;
}

/** A recorded permission decision, written to the append-only audit log. */
export interface AuditRecord {
	at: string;
	tool: string;
	command?: string;
	decision: PermissionDecision;
	/** Whether the call actually ran; a denied call is recorded for later review. */
	executed: boolean;
	exitCode?: number;
}

/** Evidence that a sandbox blocked an operation, used to decide when to ask for escalation. */
export interface SandboxDenial {
	detected: boolean;
	signal?: string;
	detail?: string;
}
