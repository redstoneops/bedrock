// @bedrock/ledger: the evidence ledger. Typed beliefs with the evidence behind them.
//
// One row per entry, with the discriminated payload stored as JSON and the fields
// the harness queries (kind, author, mission, tags, evidence) promoted to columns.
// `node:sqlite` keeps the store in-process, so the daemon, the TUI and tests share
// one implementation.

import { DatabaseSync } from "node:sqlite";
import type {
	Author,
	EntryKind,
	Id,
	LedgerEntry,
	LedgerQuery,
	LedgerSummary,
	RefineBrief,
	Timestamp,
} from "@bedrock/protocol";

export interface LedgerOptions {
	/** `:memory:` for tests, a file path for durable missions. */
	path: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS entries (
	seq INTEGER PRIMARY KEY AUTOINCREMENT,
	id TEXT NOT NULL UNIQUE,
	mission_id TEXT NOT NULL,
	kind TEXT NOT NULL,
	author TEXT NOT NULL,
	session_id TEXT,
	created_at TEXT NOT NULL,
	evidence TEXT,
	text TEXT NOT NULL,
	tags TEXT NOT NULL DEFAULT '[]',
	payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS entries_mission ON entries (mission_id, kind, created_at);
CREATE INDEX IF NOT EXISTS entries_text ON entries (mission_id, created_at);
`;

const KIND_ORDER: EntryKind[] = [
	"fact",
	"hypothesis",
	"decision",
	"evidence",
	"risk",
	"question",
	"artifact",
	"checkpoint",
	"candidate",
];

/** Searches every text-bearing field of an entry for query text. */
function entryText(entry: LedgerEntry): string {
	const record = entry as unknown as Record<string, unknown>;
	for (const key of ["statement", "question", "summary", "label", "rationale", "title"]) {
		const value = record[key];
		if (typeof value === "string") return value;
	}
	return "";
}

/** The ledger. Append-only except for hypothesis status, which is the one mutable field. */
export class Ledger {
	readonly #db: DatabaseSync;

	constructor(options: LedgerOptions) {
		this.#db = new DatabaseSync(options.path);
		this.#db.exec(SCHEMA);
	}

	/** Appends an entry and returns it unchanged. */
	append<E extends LedgerEntry>(entry: E): E {
		const statement = this.#db.prepare(
			`INSERT INTO entries (id, mission_id, kind, author, session_id, created_at, evidence, text, tags, payload)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		);
		statement.run(
			entry.id,
			entry.missionId,
			entry.kind,
			entry.author,
			entry.sessionId ?? null,
			entry.createdAt,
			entry.evidence ?? null,
			entryText(entry),
			JSON.stringify(entry.tags ?? []),
			JSON.stringify(entry),
		);
		return entry;
	}

	/** Appends many entries in one transaction. */
	appendAll(entries: LedgerEntry[]): void {
		this.#db.exec("BEGIN");
		try {
			for (const entry of entries) this.append(entry);
			this.#db.exec("COMMIT");
		} catch (error) {
			this.#db.exec("ROLLBACK");
			throw error;
		}
	}

	get(id: Id<"entry">): LedgerEntry | undefined {
		const row = this.#db.prepare("SELECT payload FROM entries WHERE id = ?").get(id) as
			| { payload?: string }
			| undefined;
		return row?.payload ? (JSON.parse(row.payload) as LedgerEntry) : undefined;
	}

	query(query: LedgerQuery = {}): LedgerEntry[] {
		const clauses: string[] = [];
		const params: Array<string | number> = [];
		if (query.missionId) {
			clauses.push("mission_id = ?");
			params.push(query.missionId);
		}
		if (query.kind) {
			const kinds = Array.isArray(query.kind) ? query.kind : [query.kind];
			clauses.push(`kind IN (${kinds.map(() => "?").join(", ")})`);
			params.push(...kinds);
		}
		if (query.author) {
			clauses.push("author = ?");
			params.push(query.author);
		}
		if (query.text) {
			clauses.push("text LIKE ?");
			params.push(`%${query.text}%`);
		}
		if (query.since) {
			clauses.push("created_at >= ?");
			params.push(query.since);
		}
		if (query.evidence?.length) {
			clauses.push(`evidence IN (${query.evidence.map(() => "?").join(", ")})`);
			params.push(...query.evidence);
		}
		const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
		const order = query.order === "asc" ? "ASC" : "DESC";
		const limit = query.limit ? `LIMIT ${Math.max(1, Math.floor(query.limit))}` : "";
		const rows = this.#db
			.prepare(`SELECT payload, tags FROM entries ${where} ORDER BY seq ${order} ${limit}`)
			.all(...params) as Array<{
			payload: string;
			tags: string;
		}>;
		const entries = rows.map((row) => JSON.parse(row.payload) as LedgerEntry);
		if (!query.tags?.length) return entries;
		// Tags are normalized to lower case so retrieval is predictable.
		const wanted = new Set(query.tags.map((tag) => tag.toLowerCase()));
		return entries.filter((entry) => (entry.tags ?? []).some((tag) => wanted.has(tag.toLowerCase())));
	}

	/** Confirms or refutes a hypothesis. The only mutation the ledger allows. */
	resolveHypothesis(
		id: Id<"entry">,
		status: "confirmed" | "refuted",
		resolvedBy?: Id<"entry">,
	): LedgerEntry | undefined {
		const entry = this.get(id);
		if (!entry || entry.kind !== "hypothesis") return undefined;
		const updated: LedgerEntry = {
			...entry,
			status,
			resolvedBy,
			createdAt: entry.createdAt,
		};
		this.#db
			.prepare("UPDATE entries SET payload = ?, text = ? WHERE id = ?")
			.run(JSON.stringify(updated), entryText(updated), id);
		return updated;
	}

	/** Number of entries, optionally for one mission and kind. */
	count(missionId?: Id<"mission">, kind?: EntryKind): number {
		const row =
			missionId && kind
				? (this.#db
						.prepare("SELECT COUNT(*) AS n FROM entries WHERE mission_id = ? AND kind = ?")
						.get(missionId, kind) as { n: number })
				: missionId
					? (this.#db.prepare("SELECT COUNT(*) AS n FROM entries WHERE mission_id = ?").get(missionId) as {
							n: number;
						})
					: (this.#db.prepare("SELECT COUNT(*) AS n FROM entries").get() as { n: number });
		return Number(row.n);
	}

	/** The counts and ratios the budget controller and TUI strip use. */
	summary(missionId: Id<"mission">): LedgerSummary {
		const entries = this.query({ missionId, order: "asc" });
		const byKind = Object.fromEntries(KIND_ORDER.map((kind) => [kind, 0])) as Record<EntryKind, number>;
		let openHypotheses = 0;
		let risks = 0;
		let claims = 0;
		let supported = 0;
		for (const entry of entries) {
			byKind[entry.kind] += 1;
			if (entry.kind === "hypothesis" && entry.status === "open") openHypotheses += 1;
			if (entry.kind === "risk") risks += 1;
			if (entry.kind === "fact" || entry.kind === "hypothesis" || entry.kind === "decision") {
				claims += 1;
				if (entry.evidence) supported += 1;
			}
		}
		return {
			total: entries.length,
			byKind,
			openHypotheses,
			risks,
			unsupportedRatio: claims === 0 ? 0 : 1 - supported / claims,
			lastEntryAt: entries.at(-1)?.createdAt,
		};
	}

	/** The most recent evidence entries, for prompt assembly and the TUI. */
	recentEvidence(missionId: Id<"mission">, limit = 5): LedgerEntry[] {
		return this.query({ missionId, kind: "evidence", limit });
	}

	/**
	 * Builds a Parallel-Distill-Refine brief from failed attempts: failing checks,
	 * ruled-out hypotheses, confirmed facts and open questions.
	 */
	refineBrief(missionId: Id<"mission">, failingChecks: Array<{ name: string; reason: string }>): RefineBrief {
		const entries = this.query({ missionId, order: "asc" });
		const ruledOut = entries
			.filter(
				(entry): entry is Extract<LedgerEntry, { kind: "hypothesis" }> =>
					entry.kind === "hypothesis" && entry.status === "refuted",
			)
			.map((entry) => entry.statement);
		const useful = entries
			.filter(
				(entry): entry is Extract<LedgerEntry, { kind: "fact" }> =>
					entry.kind === "fact" && entry.confidence !== "speculative",
			)
			.map((entry) => entry.statement);
		const openQuestions = entries
			.filter(
				(entry): entry is Extract<LedgerEntry, { kind: "question" }> =>
					entry.kind === "question" && entry.status === "open",
			)
			.map((entry) => entry.question);
		return {
			failingChecks,
			ruledOut,
			useful,
			nextSteps: openQuestions,
			sourceEntries: entries.slice(-20).map((entry) => entry.id),
		};
	}

	/** Writes the ledger as JSONL, for lab traces and human review. */
	toJsonl(missionId: Id<"mission">): string {
		return this.query({ missionId, order: "asc" })
			.map((entry) => JSON.stringify(entry))
			.join("\n");
	}

	close(): void {
		this.#db.close();
	}
}

/** Convenience: an entry's author for harness-computed records. */
export const HARNESS: Author = "harness";

/** A timestamp for entries created right now. */
export function now(): Timestamp {
	return new Date().toISOString();
}
