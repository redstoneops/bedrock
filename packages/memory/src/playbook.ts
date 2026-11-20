// @bedrock/memory: Bookshelf. The ACE-style playbook, with incremental deltas only.
//
// Entries are small, itemized lessons. The Curator never rewrites the playbook:
// it adds, merges or deprecates entries, each with a counter and attribution.
// That is what prevents context collapse and brevity bias, and it makes every
// change reversible.

import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface PlaybookEntry {
	id: string;
	/** Where the lesson applies: a package, a language, a task family, or "global". */
	scope: string;
	/** When to recall it: a short trigger phrase or glob. */
	trigger: string;
	/** The lesson, one to three sentences, concrete and checkable. */
	content: string;
	helpful: number;
	harmful: number;
	sourceMission?: string;
	createdAt: string;
	updatedAt: string;
	status: "active" | "deprecated";
}

export type PlaybookDelta =
	| { kind: "add"; scope: string; trigger: string; content: string; sourceMission?: string }
	| { kind: "merge"; id: string; content: string }
	| { kind: "deprecate"; id: string; reason: string }
	| { kind: "feedback"; id: string; helpful: boolean };

export interface PlaybookOptions {
	/** Path to the JSONL file. Omit for an in-memory playbook (tests). */
	path?: string;
}

/** A versioned playbook. Every mutation bumps `version`. */
export class Playbook {
	readonly path?: string;
	version = 0;
	#entries = new Map<string, PlaybookEntry>();
	#history: Array<{ version: number; at: string; delta: PlaybookDelta }> = [];

	constructor(options: PlaybookOptions = {}) {
		this.path = options.path;
		if (options.path && existsSync(options.path)) this.#load(options.path);
	}

	#load(path: string): void {
		const text = readFileSync(path, "utf8");
		for (const line of text.split("\n")) {
			if (line.trim().length === 0) continue;
			try {
				const record = JSON.parse(line) as {
					kind: string;
					entry?: PlaybookEntry;
					delta?: PlaybookDelta;
					version?: number;
				};
				if (record.kind === "entry" && record.entry) this.#entries.set(record.entry.id, record.entry);
				else if (record.kind === "delta" && record.delta)
					this.#history.push({ version: record.version ?? 0, at: new Date().toISOString(), delta: record.delta });
			} catch {
				// A torn line is skipped; the rest of the playbook still loads.
			}
		}
		this.version = Math.max(0, ...this.#history.map((item) => item.version));
	}

	#append(record: unknown): void {
		if (!this.path) return;
		mkdirSync(dirname(this.path), { recursive: true });
		const line = `${JSON.stringify(record)}\n`;
		const existing = existsSync(this.path) ? readFileSync(this.path, "utf8") : "";
		writeFileSync(this.path, `${existing}${line}`, "utf8");
	}

	/** Applies one delta. Refinement uses this and nothing else. */
	apply(delta: PlaybookDelta): PlaybookEntry | undefined {
		this.version += 1;
		const now = new Date().toISOString();
		let changed: PlaybookEntry | undefined;
		if (delta.kind === "add") {
			// Adding a lesson that already exists merges into it instead of duplicating.
			const existing = [...this.#entries.values()].find(
				(entry) =>
					entry.scope === delta.scope && entry.content.trim().toLowerCase() === delta.content.trim().toLowerCase(),
			);
			if (existing) {
				existing.updatedAt = now;
				existing.sourceMission = delta.sourceMission ?? existing.sourceMission;
				changed = existing;
			} else {
				changed = {
					id: `pbk_${randomUUID().replaceAll("-", "").slice(0, 12)}`,
					scope: delta.scope,
					trigger: delta.trigger,
					content: delta.content,
					helpful: 0,
					harmful: 0,
					sourceMission: delta.sourceMission,
					createdAt: now,
					updatedAt: now,
					status: "active",
				};
				this.#entries.set(changed.id, changed);
			}
		} else if (delta.kind === "merge") {
			const entry = this.#entries.get(delta.id);
			if (entry) {
				entry.content = delta.content;
				entry.updatedAt = now;
				changed = entry;
			}
		} else if (delta.kind === "deprecate") {
			const entry = this.#entries.get(delta.id);
			if (entry) {
				entry.status = "deprecated";
				entry.updatedAt = now;
				changed = entry;
			}
		} else {
			const entry = this.#entries.get(delta.id);
			if (entry) {
				if (delta.helpful) entry.helpful += 1;
				else entry.harmful += 1;
				entry.updatedAt = now;
				changed = entry;
			}
		}
		if (changed) this.#append({ kind: "entry", entry: changed });
		this.#append({ kind: "delta", version: this.version, delta });
		this.#history.push({ version: this.version, at: now, delta });
		return changed;
	}

	applyAll(deltas: PlaybookDelta[]): void {
		for (const delta of deltas) this.apply(delta);
	}

	/** Reverts to a previous version by replaying history up to it. */
	rollback(toVersion: number): void {
		if (toVersion < 0 || toVersion > this.version)
			throw new Error(`cannot roll back to version ${toVersion}; current is ${this.version}`);
		const entries = new Map<string, PlaybookEntry>();
		for (const item of this.#history.filter((history) => history.version <= toVersion)) {
			const delta = item.delta;
			const at = item.at;
			if (delta.kind === "add") {
				const id = `pbk_${createHash("sha1").update(`${delta.scope}:${delta.content}`).digest("hex").slice(0, 12)}`;
				if (
					![...entries.values()].some((entry) => entry.scope === delta.scope && entry.content === delta.content)
				) {
					entries.set(id, {
						id,
						scope: delta.scope,
						trigger: delta.trigger,
						content: delta.content,
						helpful: 0,
						harmful: 0,
						sourceMission: delta.sourceMission,
						createdAt: at,
						updatedAt: at,
						status: "active",
					});
				}
			} else if (delta.kind === "merge") {
				const entry = entries.get(delta.id);
				if (entry) entry.content = delta.content;
			} else if (delta.kind === "deprecate") {
				const entry = entries.get(delta.id);
				if (entry) entry.status = "deprecated";
			}
		}
		this.#entries = entries;
		this.version = toVersion;
	}

	/** Retrieval by scope, trigger and free text. Deprecated entries never match. */
	recall(query: { scope?: string; text?: string; tags?: string[]; limit?: number } = {}): PlaybookEntry[] {
		const words = (query.text ?? "")
			.toLowerCase()
			.split(/\s+/)
			.filter((word) => word.length > 2);
		return [...this.#entries.values()]
			.filter((entry) => entry.status === "active")
			.filter((entry) => !query.scope || entry.scope === query.scope || entry.scope === "global")
			.map((entry) => {
				let score = entry.helpful - entry.harmful;
				const haystack = `${entry.trigger} ${entry.content}`.toLowerCase();
				for (const word of words) if (haystack.includes(word)) score += 2;
				for (const tag of query.tags ?? []) if (haystack.includes(tag.toLowerCase())) score += 2;
				return { entry, score };
			})
			.filter((candidate) => candidate.score > 0 || (query.text === undefined && query.scope !== undefined))
			.sort((a, b) => b.score - a.score)
			.slice(0, query.limit ?? 8)
			.map((candidate) => candidate.entry);
	}

	all(): PlaybookEntry[] {
		return [...this.#entries.values()];
	}

	get(id: string): PlaybookEntry | undefined {
		return this.#entries.get(id);
	}

	/** The deltas applied so far, for review and rollback auditing. */
	history(): Array<{ version: number; at: string; delta: PlaybookDelta }> {
		return [...this.#history];
	}

	/** Exports the playbook as markdown, for committing to a repository. */
	toMarkdown(): string {
		const lines = [
			"# Playbook",
			"",
			`Version ${this.version}. Managed by Bedrock; edits outside the harness are overwritten.`,
			"",
		];
		const byScope = new Map<string, PlaybookEntry[]>();
		for (const entry of this.#entries.values()) {
			if (entry.status !== "active") continue;
			byScope.set(entry.scope, [...(byScope.get(entry.scope) ?? []), entry]);
		}
		for (const [scope, entries] of [...byScope.entries()].sort()) {
			lines.push(`## ${scope}`, "");
			for (const entry of entries)
				lines.push(`- **When:** ${entry.trigger} — ${entry.content} _(+${entry.helpful}/-${entry.harmful})_`);
			lines.push("");
		}
		return lines.join("\n");
	}

	/** Writes the canonical JSONL form to `directory`, for sharing. */
	saveTo(directory: string): string {
		const path = join(directory, "playbook.jsonl");
		mkdirSync(directory, { recursive: true });
		const lines = [...this.#entries.values()].map((entry) => JSON.stringify({ kind: "entry", entry }));
		writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
		return path;
	}
}

/** A playbook path under the project state directory. */
export function defaultPlaybookPath(stateDir: string): string {
	return join(stateDir, "playbook", "playbook.jsonl");
}
