// @bedrock/lab: Anvil. The outer loop that proposes harness variants and keeps
// only the ones that win on held-out tasks.
//
// The loop is deliberately boring and auditable: propose -> evaluate on the
// search split -> keep a diverse archive -> promote only after a held-out split
// passes. The proposer is a function, so it can be a human, a script, or a model.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BedrockConfig } from "@bedrock/protocol";
import type { RunRecord } from "./bench.ts";

export interface Variant {
	id: string;
	/** What changed relative to the baseline, in one sentence. */
	description: string;
	config: BedrockConfig;
	/** The policy module or prompt patch under test; opaque to the archive. */
	patch?: Record<string, unknown>;
}

export interface VariantScore {
	variantId: string;
	success: number;
	costPerSolved: number | undefined;
	falseCompletionRate: number;
}

export interface ArchiveEntry {
	variant: Variant;
	score: VariantScore;
	runId: string;
	/** Held-out result, once promoted. */
	holdout?: { success: number; costPerSolved: number | undefined; passed: boolean };
}

export interface EvolveOptions {
	base: Variant;
	/** Search-split tasks, in a stable order. */
	search: () => Promise<Array<{ id: string }>>;
	/** Evaluates a variant on the search split and returns its run. */
	evaluate: (variant: Variant) => Promise<RunRecord>;
	/** Proposes new variants from the archive. Called once per round. */
	propose: (archive: ArchiveEntry[], round: number) => Promise<Variant[]>;
	/** Evaluates a variant on the held-out split. */
	evaluateHoldout: (variant: Variant) => Promise<{ success: number; costPerSolved: number | undefined }>;
	/** Minimum held-out success to promote. */
	holdoutThreshold: number;
	rounds?: number;
	archiveDir?: string;
}

export interface EvolveResult {
	archive: ArchiveEntry[];
	/** The variant promoted to default, if any. */
	promoted?: ArchiveEntry;
	log: string[];
}

/** Pareto front on success (higher) versus cost per solved task (lower). */
export function paretoFront(entries: ArchiveEntry[]): ArchiveEntry[] {
	return entries.filter((entry) => {
		const dominated = entries.some((other) => {
			if (other === entry) return false;
			const betterSuccess = other.score.success >= entry.score.success;
			const betterCost =
				(entry.score.costPerSolved === undefined && other.score.costPerSolved !== undefined) ||
				(other.score.costPerSolved !== undefined &&
					entry.score.costPerSolved !== undefined &&
					other.score.costPerSolved <= entry.score.costPerSolved);
			const strictlyBetter =
				other.score.success > entry.score.success ||
				(other.score.costPerSolved !== undefined &&
					entry.score.costPerSolved !== undefined &&
					other.score.costPerSolved < entry.score.costPerSolved);
			return betterSuccess && betterCost && strictlyBetter;
		});
		return !dominated;
	});
}

/**
 * Runs the loop. Promotion requires a held-out success at or above the threshold;
 * nothing is ever promoted on search-split results alone.
 */
export async function evolve(options: EvolveOptions): Promise<EvolveResult> {
	const archive: ArchiveEntry[] = [];
	const log: string[] = [];
	const rounds = options.rounds ?? 2;

	const baseRun = await options.evaluate(options.base);
	archive.push({ variant: options.base, runId: baseRun.runId, score: scoreOf(baseRun) });
	log.push(`round 0: baseline success ${(baseRun.metrics.bestAtK * 100).toFixed(1)}%`);

	for (let round = 1; round <= rounds; round++) {
		await options.search();
		const proposals = await options.propose(archive, round);
		log.push(`round ${round}: ${proposals.length} proposal(s)`);
		for (const variant of proposals) {
			if (archive.some((entry) => entry.variant.id === variant.id)) continue;
			const run = await options.evaluate(variant);
			const entry: ArchiveEntry = { variant, runId: run.runId, score: scoreOf(run) };
			archive.push(entry);
			log.push(
				`  ${variant.id}: success ${(entry.score.success * 100).toFixed(1)}% cost ${entry.score.costPerSolved?.toFixed(2) ?? "n/a"}`,
			);
		}
	}

	// Promote the best search-split variant only after the holdout agrees.
	const ranked = [...archive].sort(
		(a, b) =>
			b.score.success - a.score.success || (a.score.costPerSolved ?? Infinity) - (b.score.costPerSolved ?? Infinity),
	);
	for (const entry of ranked) {
		const holdout = await options.evaluateHoldout(entry.variant);
		entry.holdout = { ...holdout, passed: holdout.success >= options.holdoutThreshold };
		log.push(
			`${entry.variant.id}: holdout ${(holdout.success * 100).toFixed(1)}%${entry.holdout.passed ? " (threshold met)" : ""}`,
		);
		if (entry.holdout.passed) {
			log.push(`promoted ${entry.variant.id}`);
			if (options.archiveDir) saveArchive(options.archiveDir, archive);
			return { archive, promoted: entry, log };
		}
	}
	if (options.archiveDir) saveArchive(options.archiveDir, archive);
	log.push("nothing promoted: no variant met the held-out threshold");
	return { archive, log };
}

function scoreOf(run: RunRecord): VariantScore {
	return {
		variantId: run.variant,
		success: run.metrics.bestAtK,
		costPerSolved: run.metrics.costPerSolved,
		falseCompletionRate: run.metrics.falseCompletionRate,
	};
}

export function saveArchive(dir: string, archive: ArchiveEntry[]): string {
	mkdirSync(dir, { recursive: true });
	const path = join(dir, "archive.json");
	writeFileSync(path, JSON.stringify(archive, null, 2), "utf8");
	return path;
}

export function loadArchive(dir: string): ArchiveEntry[] {
	const path = join(dir, "archive.json");
	return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as ArchiveEntry[]) : [];
}
