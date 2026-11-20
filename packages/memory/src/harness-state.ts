// @bedrock/memory: harness state H and guarded refinement.
//
// Refinement is allowed to change prompt notes, sub-agent definitions and the
// playbook. It is never allowed to change the gate, the verifier, the integrity
// rules or the evals. Anything that could affect verification requires a
// held-out eval pass or explicit human approval before it is activated.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The parts of the harness a refinement may touch. */
export type RefinementTarget = "prompt-notes" | "sub-agents" | "playbook";

/** The parts that are immutable to refinement, by policy. */
export const IMMUTABLE_TARGETS = ["gate", "verifier", "integrity", "evals", "system-prompt"] as const;
export type ImmutableTarget = (typeof IMMUTABLE_TARGETS)[number];

export interface PromptNote {
	id: string;
	section: "worker" | "advisor" | "verifier" | "strategist";
	content: string;
	createdAt: string;
}

export interface HarnessVersion {
	version: number;
	at: string;
	reason: string;
	/** The diff applied, for review and rollback. */
	patch: Array<{ target: RefinementTarget; op: "set" | "add" | "remove"; key: string; value?: string }>;
	status: "pending" | "active" | "rolled-back";
	/** The eval that justified activation, when one was required. */
	evidence?: string;
}

export interface HarnessStateData {
	promptNotes: PromptNote[];
	subAgents: Record<string, { role: string; brief: string }>;
	/** Playbook version this state expects. */
	playbookVersion: number;
	versions: HarnessVersion[];
}

export interface RefinementProposal {
	reason: string;
	patch: Array<{ target: RefinementTarget; op: "set" | "add" | "remove"; key: string; value?: string }>;
	/** True when the change could affect verification behavior or the gate. */
	touchesVerification?: boolean;
}

export interface ActivationContext {
	/** Result of a held-out eval the refinement was required to pass. */
	holdoutPassed?: boolean;
	/** Human approval, required when no holdout eval is available. */
	humanApproved?: boolean;
	requireHoldout: boolean;
}

export interface ActivationResult {
	activated: boolean;
	reason: string;
	version?: HarnessVersion;
}

/**
 * Versioned harness state. Every accepted refinement is a numbered version with
 * its patch and reason; rollback is by id, and the state on disk is always the
 * result of applying active versions in order.
 */
export class HarnessState {
	readonly path?: string;
	#data: HarnessStateData;

	constructor(path?: string) {
		this.path = path;
		this.#data =
			path && existsSync(path)
				? (JSON.parse(readFileSync(path, "utf8")) as HarnessStateData)
				: { promptNotes: [], subAgents: {}, playbookVersion: 0, versions: [] };
	}

	get data(): HarnessStateData {
		return this.#data;
	}

	get version(): number {
		return this.#data.versions.length;
	}

	/** Refuses changes to immutable targets before they can be proposed. */
	static validate(proposal: RefinementProposal): { ok: true } | { ok: false; reason: string } {
		for (const change of proposal.patch) {
			if ((IMMUTABLE_TARGETS as readonly string[]).includes(change.target)) {
				return {
					ok: false,
					reason: `"${change.target}" is immutable to refinement; change it with a code review, not a lesson`,
				};
			}
			if (!["prompt-notes", "sub-agents", "playbook"].includes(change.target)) {
				return { ok: false, reason: `unknown refinement target "${change.target}"` };
			}
		}
		if (proposal.patch.length === 0) return { ok: false, reason: "empty refinement" };
		return { ok: true };
	}

	/**
	 * Submits a proposal. It stays `pending` until activated with evidence (a
	 * passing held-out eval, or human approval when no eval exists).
	 */
	propose(proposal: RefinementProposal): HarnessVersion {
		const validation = HarnessState.validate(proposal);
		if (!validation.ok) throw new Error(validation.reason);
		const version: HarnessVersion = {
			version: this.#data.versions.length + 1,
			at: new Date().toISOString(),
			reason: proposal.reason,
			patch: proposal.patch,
			status: "pending",
		};
		this.#data.versions.push(version);
		this.#save();
		return version;
	}

	/**
	 * Activates a pending version. Verification-affecting changes need a passing
	 * held-out eval when the config requires one, else explicit human approval.
	 */
	activate(versionNumber: number, context: ActivationContext): ActivationResult {
		const version = this.#data.versions.find((candidate) => candidate.version === versionNumber);
		if (!version) return { activated: false, reason: `no version ${versionNumber}` };
		if (version.status === "active")
			return { activated: false, reason: `version ${versionNumber} is already active` };
		const affectsVerification = version.patch.some(
			(change) => change.target === "prompt-notes" && /verifier|advisor/i.test(change.key),
		);
		if (affectsVerification && context.requireHoldout && !context.holdoutPassed && !context.humanApproved) {
			return {
				activated: false,
				reason: "this refinement affects verification and has no passing held-out eval or human approval",
			};
		}
		version.status = "active";
		version.evidence = context.holdoutPassed
			? "held-out eval passed"
			: context.humanApproved
				? "human approved"
				: undefined;
		this.#apply(version);
		this.#save();
		return { activated: true, reason: "activated", version };
	}

	/** Reverts an active version and every later one, restoring earlier state. */
	rollback(versionNumber: number): HarnessVersion {
		const version = this.#data.versions.find((candidate) => candidate.version === versionNumber);
		if (!version) throw new Error(`no version ${versionNumber}`);
		version.status = "rolled-back";
		// Rebuild state from the versions that remain active.
		this.#data.promptNotes = [];
		this.#data.subAgents = {};
		for (const candidate of this.#data.versions) {
			if (candidate.status === "active" && candidate.version < versionNumber) this.#apply(candidate);
		}
		this.#save();
		return version;
	}

	#apply(version: HarnessVersion): void {
		for (const change of version.patch) {
			if (change.target === "prompt-notes") {
				if (change.op === "remove")
					this.#data.promptNotes = this.#data.promptNotes.filter((note) => note.id !== change.key);
				else {
					const existing = this.#data.promptNotes.find((note) => note.id === change.key);
					if (existing) existing.content = change.value ?? existing.content;
					else
						this.#data.promptNotes.push({
							id: change.key,
							section: "worker",
							content: change.value ?? "",
							createdAt: version.at,
						});
				}
			} else if (change.target === "sub-agents") {
				if (change.op === "remove") delete this.#data.subAgents[change.key];
				else this.#data.subAgents[change.key] = { role: "worker", brief: change.value ?? "" };
			}
		}
	}

	/** Prompt notes merged into a role's prompt in a stable order. */
	notesFor(section: PromptNote["section"]): string[] {
		return this.#data.promptNotes.filter((note) => note.section === section).map((note) => note.content);
	}

	#save(): void {
		if (!this.path) return;
		mkdirSync(join(this.path, ".."), { recursive: true });
		writeFileSync(this.path, JSON.stringify(this.#data, null, 2), "utf8");
	}
}
