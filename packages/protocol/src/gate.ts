// @bedrock/protocol: the Gate. The machine-checkable definition of "done".

import type { Id, Timestamp } from "./ids.ts";

/** What a check proves. `manual` checks are rubric-only fallbacks that need human approval. */
export type CheckKind = "build" | "test" | "lint" | "typecheck" | "command" | "benchmark" | "manual";

/** How a command check's success is decided. Defaults to `exit_code`. */
export type Expectation =
	| { kind: "exit_code"; code: number }
	| { kind: "stdout_contains"; text: string }
	| { kind: "stdout_matches"; pattern: string }
	| { kind: "min_count"; pattern: string; count: number }
	| { kind: "max_duration_ms"; ms: number };

export interface CommandCheck {
	id: Id<"check">;
	name: string;
	kind: CheckKind;
	/** Shell command, run with `bash -lc` unless `shell` says otherwise. */
	command: string;
	cwd?: string;
	timeoutMs?: number;
	env?: Record<string, string>;
	expect: Expectation;
	/** Acceptance checks written for this mission must fail before the fix and pass after. */
	origin: "existing" | "acceptance" | "holdout";
	/** Visible checks run by workers and the verifier; holdout checks run only by the verifier. */
	visibility: "visible" | "holdout";
	/** Set by the compiler when it proved the check fails on the pre-fix tree. */
	baseline?: { failsWithoutFix: boolean; evidenceId?: Id<"evidence">; justification?: string };
}

/** Things that must stay true even when every check passes. */
export type Invariant =
	| { kind: "files_unchanged"; paths: string[]; reason: string }
	| { kind: "command_passes"; name: string; command: string; reason: string }
	| { kind: "paths_untouched"; globs: string[]; reason: string }
	| { kind: "no_new_dependencies"; reason: string }
	| { kind: "public_api_unchanged"; entrypoints: string[]; reason: string };

export type RubricSeverity = "blocker" | "major" | "minor";

/** A repo-grounded criterion for qualities that cannot be executed (Agentic Rubrics style). */
export interface RubricCriterion {
	id: string;
	criterion: string;
	weight: number;
	severity: RubricSeverity;
	/** Concrete evidence a judge should look for, e.g. a path or a test name. */
	evidenceHint?: string;
}

/** Rules the harness enforces against reward hacking and accidental damage. */
export interface IntegrityRules {
	/** Files a worker may never modify (gate material, holdout tests, eval fixtures). */
	protectedPaths: string[];
	/** Files whose modification is allowed but must carry a ledger justification. */
	justifyPaths: string[];
	/** Forbid reading git history/remotes for answers. */
	forbidHistoryMining: boolean;
	/** Forbid network access from checks and workers unless allowlisted. */
	networkAllowlist: string[];
	/** Which path globs count as tests, for the diff monitor. */
	testGlobs: string[];
}

export type GateOrigin = "user" | "compiled" | "merged";

/** The compiled gate. Immutable once approved; changes create a new version. */
export interface Gate {
	id: Id<"gate">;
	missionId: Id<"mission">;
	version: number;
	origin: GateOrigin;
	createdAt: Timestamp;
	checks: CommandCheck[];
	invariants: Invariant[];
	rubric: RubricCriterion[];
	integrity: IntegrityRules;
	/** User-supplied `--gate` commands are always included and cannot be weakened. */
	userSupplied: string[];
	approved: boolean;
	approvedBy?: "user" | "policy";
	/** Rationale the compiler gives for the gate it produced. */
	rationale?: string;
}

export type CheckStatus = "passed" | "failed" | "skipped" | "error" | "not_run";

/** One execution of one check against one tree. */
export interface CheckRun {
	checkId: Id<"check">;
	name: string;
	status: CheckStatus;
	exitCode?: number;
	durationMs: number;
	/** Artifact handle holding the truncated output, when there was output. */
	artifact?: Id<"artifact">;
	/** First and last lines inlined for UI and prompt use. */
	outputHead?: string;
	outputTail?: string;
	truncated?: boolean;
	startedAt: Timestamp;
	failureReason?: string;
}

/** Result of running one gate (visible checks, holdout, invariants, rubric). */
export interface GateResult {
	gateId: Id<"gate">;
	gateVersion: number;
	/** Tree hash the checks ran against. Evidence is bound to this, not to a message. */
	treeHash: string;
	commit?: string;
	startedAt: Timestamp;
	finishedAt: Timestamp;
	visible: CheckRun[];
	holdout: CheckRun[];
	invariantViolations: InvariantViolation[];
	rubricScore?: number;
	rubricVerdicts?: RubricVerdict[];
	integrity: IntegrityReport;
	passed: boolean;
	/** Fraction of visible checks that passed, 0..1. Drives budget decisions. */
	passRatio: number;
}

export interface InvariantViolation {
	invariant: Invariant;
	detail: string;
}

export interface RubricVerdict {
	criterionId: string;
	score: number;
	justification: string;
	/** True when the judge could not find supporting evidence. */
	unverified: boolean;
}

/** Findings from the diff monitor, used to spot reward hacking. */
export interface IntegrityReport {
	changedPaths: string[];
	protectedTouched: string[];
	unjustified: string[];
	suspicious: Suspicion[];
	clean: boolean;
}

export interface Suspicion {
	kind:
		| "test_modified"
		| "test_skipped"
		| "test_special_cased"
		| "evaluation_file_read"
		| "history_mined"
		| "network_used"
		| "gate_weakened"
		| "monkey_patched"
		| "hardcoded_expected_output";
	path?: string;
	detail: string;
	severity: "info" | "warning" | "critical";
}

/** Harness-computed verdict on a mission. Never derived from model text. */
export type FinalState = "passed" | "partial" | "failed" | "unverified" | "cancelled" | "exhausted";

export function isPassing(result: GateResult): boolean {
	return result.passed && result.integrity.clean;
}
