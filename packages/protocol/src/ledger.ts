// @bedrock/protocol: the Ledger of evidence-backed beliefs, and the records it stores.

import type { Id, Timestamp } from "./ids.ts";

export type EntryKind =
	| "fact"
	| "hypothesis"
	| "decision"
	| "evidence"
	| "risk"
	| "question"
	| "artifact"
	| "checkpoint"
	| "candidate";

export type Author =
	| "worker"
	| "scout"
	| "strategist"
	| "verifier"
	| "judge"
	| "advisor"
	| "reflector"
	| "human"
	| "harness";

export interface LedgerEntryBase {
	id: Id<"entry">;
	missionId: Id<"mission">;
	kind: EntryKind;
	author: Author;
	/** Which worker/agent wrote it, when applicable. */
	sessionId?: Id<"session">;
	createdAt: Timestamp;
	/** Other entries this one depends on (supports or refutes). */
	links?: Id<"entry">[];
	/** Free-form tags used by retrieval and prompt assembly. */
	tags?: string[];
	/** Entry id of the evidence that backs this claim, if any. */
	evidence?: Id<"entry">;
}

/** Something believed true about the world. `confidence` is explicit so the harness can challenge it. */
export interface Fact extends LedgerEntryBase {
	kind: "fact";
	statement: string;
	confidence: "certain" | "likely" | "speculative";
	/** Raw evidence entries recorded inline; protocol keeps them attached by id. */
	sources?: Id<"entry">[];
}

export type HypothesisStatus = "open" | "confirmed" | "refuted";

export interface Hypothesis extends LedgerEntryBase {
	kind: "hypothesis";
	statement: string;
	status: HypothesisStatus;
	/** Experiment that would settle it, so a worker knows what to run next. */
	experiment?: string;
	resolvedBy?: Id<"entry">;
}

export interface Decision extends LedgerEntryBase {
	kind: "decision";
	statement: string;
	alternatives?: string[];
	rationale: string;
}

export interface Evidence extends LedgerEntryBase {
	kind: "evidence";
	/** What was run, or `undefined` for non-command evidence such as a file hash. */
	command?: string;
	exitCode?: number;
	durationMs?: number;
	/** sha256 of the captured output. */
	outputHash?: string;
	/** Tree hash (or commit) the evidence was produced against. */
	treeHash?: string;
	/** Stored output, referenced rather than inlined. */
	artifact?: Id<"artifact">;
	summary: string;
}

export interface Risk extends LedgerEntryBase {
	kind: "risk";
	statement: string;
	severity: "low" | "medium" | "high";
	mitigation?: string;
}

export interface OpenQuestion extends LedgerEntryBase {
	kind: "question";
	question: string;
	status: "open" | "answered";
	answer?: string;
}

export interface Artifact extends LedgerEntryBase {
	kind: "artifact";
	/** Path relative to the artifact store root. */
	path: string;
	bytes: number;
	mime: string;
}

export interface Checkpoint extends LedgerEntryBase {
	kind: "checkpoint";
	/** Worktree/branch/ref the checkpoint points at. */
	ref: string;
	commit: string;
	label: string;
}

export interface Candidate extends LedgerEntryBase {
	kind: "candidate";
	workerId: Id<"worker">;
	branch: string;
	commit: string;
	/** Tree hash the candidate was verified at. */
	treeHash?: string;
	diffStat: { files: number; additions: number; deletions: number };
	score?: number;
	selected?: boolean;
}

export type LedgerEntry =
	| Fact
	| Hypothesis
	| Decision
	| Evidence
	| Risk
	| OpenQuestion
	| Artifact
	| Checkpoint
	| Candidate;

/** Query shape supported by the ledger store. All filters are AND-ed. */
export interface LedgerQuery {
	missionId?: Id<"mission">;
	kind?: EntryKind | EntryKind[];
	author?: Author;
	/** Substring match over statement/question/summary text. */
	text?: string;
	tags?: string[];
	/** Only entries whose evidence is one of these ids. */
	evidence?: Id<"entry">[];
	since?: Timestamp;
	limit?: number;
	order?: "asc" | "desc";
}

/** Counts used by the TUI status strip and budget controller. */
export interface LedgerSummary {
	total: number;
	byKind: Record<EntryKind, number>;
	openHypotheses: number;
	risks: number;
	/** Entries with no supporting evidence, as a fraction of claim-like entries. */
	unsupportedRatio: number;
	lastEntryAt?: Timestamp;
}

/** A compact brief distilled from failed attempts, fed to the next rollout (Parallel-Distill-Refine). */
export interface RefineBrief {
	failingChecks: { name: string; reason: string }[];
	ruledOut: string[];
	useful: string[];
	nextSteps: string[];
	/** Entry ids the brief was distilled from, so claims stay traceable. */
	sourceEntries: Id<"entry">[];
}
