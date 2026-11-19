import { createId, type Evidence, type Fact, type Hypothesis, type LedgerEntry, type Risk } from "@bedrock/protocol";
import { describe, expect, it } from "vitest";
import { Ledger, now } from "../src/index.ts";

const missionId = createId("mission");

function fact(
	statement: string,
	confidence: "certain" | "likely" | "speculative" = "likely",
	tags: string[] = [],
): Fact {
	return {
		id: createId("entry"),
		missionId,
		kind: "fact",
		author: "worker",
		createdAt: now(),
		statement,
		confidence,
		tags,
	};
}

function hypothesis(statement: string): Hypothesis {
	return {
		id: createId("entry"),
		missionId,
		kind: "hypothesis",
		author: "worker",
		createdAt: now(),
		statement,
		status: "open",
	};
}

function evidence(summary: string, treeHash = "abc"): Evidence {
	return {
		id: createId("entry"),
		missionId,
		kind: "evidence",
		author: "harness",
		createdAt: now(),
		summary,
		command: "npm test",
		exitCode: 1,
		treeHash,
	};
}

function risk(statement: string): Risk {
	return {
		id: createId("entry"),
		missionId,
		kind: "risk",
		author: "worker",
		createdAt: now(),
		statement,
		severity: "high",
	};
}

describe("Ledger", () => {
	it("appends, reads back and preserves payloads", () => {
		const ledger = new Ledger({ path: ":memory:" });
		const entry = fact("the parser ignores CRLF line endings", "certain", ["parser", "crlf"]);
		ledger.append(entry);
		expect(ledger.get(entry.id)).toEqual(entry);
		expect(ledger.count(missionId)).toBe(1);
		ledger.close();
	});

	it("filters by kind, text, tags and author", () => {
		const ledger = new Ledger({ path: ":memory:" });
		const f = fact("build uses esbuild");
		const h = hypothesis("the cache is stale");
		const r = risk("no coverage for windows paths");
		const e = evidence("npm test failed", "tree-1");
		ledger.appendAll([f, h, r, e]);

		expect(ledger.query({ missionId, kind: "hypothesis" }).map((entry) => entry.id)).toEqual([h.id]);
		expect(ledger.query({ missionId, kind: ["fact", "risk"] })).toHaveLength(2);
		expect(ledger.query({ missionId, text: "cache" }).map((entry) => entry.id)).toEqual([h.id]);
		expect(ledger.query({ missionId, tags: ["parser"] })).toHaveLength(0);
		expect(ledger.query({ missionId, author: "harness" }).map((entry) => entry.id)).toEqual([e.id]);
		expect(ledger.query({ missionId, evidence: [e.id] })).toHaveLength(0);
		ledger.close();
	});

	it("resolves hypotheses once, and only hypotheses", () => {
		const ledger = new Ledger({ path: ":memory:" });
		const h = hypothesis("the bug is in the lexer");
		const f = fact("the bug is in the lexer");
		ledger.appendAll([h, f]);
		const resolved = ledger.resolveHypothesis(h.id, "refuted");
		expect(resolved).toMatchObject({ kind: "hypothesis", status: "refuted" });
		expect(ledger.get(h.id)).toMatchObject({ status: "refuted" });
		expect(ledger.resolveHypothesis(f.id, "confirmed")).toBeUndefined();
		ledger.close();
	});

	it("summarizes claims and evidence coverage", () => {
		const ledger = new Ledger({ path: ":memory:" });
		const e = evidence("tests fail on main");
		const supported = fact("tests fail on main");
		supported.evidence = e.id;
		ledger.appendAll([e, supported, fact("unproven claim"), hypothesis("open question?"), risk("flaky test")]);
		const summary = ledger.summary(missionId);
		expect(summary.total).toBe(5);
		expect(summary.byKind.evidence).toBe(1);
		expect(summary.openHypotheses).toBe(1);
		expect(summary.risks).toBe(1);
		// Two facts + one hypothesis are claims; only one carries evidence.
		expect(summary.unsupportedRatio).toBeCloseTo(2 / 3, 5);
		expect(summary.lastEntryAt).toBeDefined();
		ledger.close();
	});

	it("distills a refine brief from refuted hypotheses and confirmed facts", () => {
		const ledger = new Ledger({ path: ":memory:" });
		const refuted = hypothesis("the cache key is wrong");
		ledger.appendAll([fact("build uses esbuild", "certain"), refuted]);
		ledger.resolveHypothesis(refuted.id, "refuted");
		const brief = ledger.refineBrief(missionId, [{ name: "test", reason: "assertion failed" }]);
		expect(brief.ruledOut).toEqual(["the cache key is wrong"]);
		expect(brief.useful).toContain("build uses esbuild");
		expect(brief.failingChecks[0].name).toBe("test");
		expect(brief.sourceEntries).toHaveLength(2);
		ledger.close();
	});

	it("exports JSONL in insertion order", () => {
		const ledger = new Ledger({ path: ":memory:" });
		ledger.appendAll([fact("one"), fact("two")]);
		const lines = ledger.toJsonl(missionId).split("\n");
		expect(lines).toHaveLength(2);
		expect(JSON.parse(lines[0]).statement).toBe("one");
		ledger.close();
	});

	it("rejects duplicate ids", () => {
		const ledger = new Ledger({ path: ":memory:" });
		const entry = fact("unique");
		ledger.append(entry);
		expect(() => ledger.append(entry as LedgerEntry)).toThrow();
		ledger.close();
	});
});
