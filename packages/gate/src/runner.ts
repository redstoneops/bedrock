// @bedrock/gate: running the gate, the invariants and the diff monitor.
//
// Results are bound to a tree hash computed before the checks run. A "passed"
// therefore always means "these checks passed on exactly this tree", which is the
// property the whole product rests on.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { ArtifactStore, TruncationOptions } from "@bedrock/context";
import { truncateOutput } from "@bedrock/context";
import type {
	CheckRun,
	CommandCheck,
	Gate,
	GateResult,
	Id,
	IntegrityReport,
	InvariantViolation,
	Suspicion,
	Timestamp,
} from "@bedrock/protocol";

export interface RunGateOptions {
	gate: Gate;
	/** Tree the checks run against. */
	workspace: string;
	/** Omit holdout checks (worker-facing runs never see them). */
	includeHoldout: boolean;
	/** Only these check ids/names, for rerunning one check in the TUI. */
	only?: string[];
	/** Timeout for a single check when the check does not set one. */
	defaultTimeoutMs?: number;
	artifacts?: ArtifactStore;
	/** Base commit, used by the diff monitor. */
	baseCommit?: string;
	truncation?: TruncationOptions;
}

/** A stable hash of the working tree: git HEAD plus a hash of the dirty files. */
export function treeHash(workspace: string): string {
	const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: workspace, encoding: "utf8" });
	if (head.status !== 0) {
		return `nogit_${createHash("sha1").update(workspace).digest("hex").slice(0, 12)}`;
	}
	const status = spawnSync("git", ["status", "--porcelain"], { cwd: workspace, encoding: "utf8" });
	const dirty = spawnSync("git", ["diff", "HEAD", "--binary"], {
		cwd: workspace,
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
	});
	return createHash("sha1").update(`${head.stdout.trim()}\n${status.stdout}\n${dirty.stdout}`).digest("hex");
}

function matchesExpectation(
	check: CommandCheck,
	exitCode: number,
	stdout: string,
	stderr: string,
	durationMs: number,
): { ok: boolean; reason?: string } {
	const output = `${stdout}\n${stderr}`;
	switch (check.expect.kind) {
		case "exit_code":
			return exitCode === check.expect.code
				? { ok: true }
				: { ok: false, reason: `expected exit ${check.expect.code}, got ${exitCode}` };
		case "stdout_contains":
			return output.includes(check.expect.text)
				? { ok: true }
				: { ok: false, reason: `output does not contain "${check.expect.text}"` };
		case "stdout_matches": {
			const regex = new RegExp(check.expect.pattern, "m");
			return regex.test(output)
				? { ok: true }
				: { ok: false, reason: `output does not match /${check.expect.pattern}/` };
		}
		case "min_count": {
			const count = [...output.matchAll(new RegExp(check.expect.pattern, "g"))].length;
			return count >= check.expect.count
				? { ok: true }
				: { ok: false, reason: `found ${count} occurrences, need ${check.expect.count}` };
		}
		case "max_duration_ms":
			return durationMs <= check.expect.ms
				? { ok: true }
				: { ok: false, reason: `${durationMs}ms exceeds ${check.expect.ms}ms` };
	}
}

/** Runs one check and captures its output as an artifact when large. */
export function runCheck(
	check: CommandCheck,
	workspace: string,
	options: { timeoutMs?: number; artifacts?: ArtifactStore; truncation?: TruncationOptions } = {},
): CheckRun {
	const startedAt = new Date().toISOString();
	const started = performance.now();
	const result = spawnSync("bash", ["-lc", check.command], {
		cwd: check.cwd ? `${workspace}/${check.cwd}` : workspace,
		timeout: check.timeoutMs ?? options.timeoutMs ?? 300_000,
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
		env: { ...process.env, ...check.env, CI: process.env.CI ?? "1" },
	});
	const durationMs = Math.round(performance.now() - started);
	const stdout = result.stdout ?? "";
	const stderr = result.stderr ?? "";
	const exitCode = result.status ?? (result.error ? 124 : 0);
	const verdict = matchesExpectation(check, exitCode, stdout, stderr, durationMs);
	const combined = `${stdout}${stderr}`;
	const truncated = truncateOutput(combined, options.truncation ?? { maxLines: 400, maxBytes: 32_000 });
	const artifact = options.artifacts && truncated.truncated ? options.artifacts.put(combined) : undefined;
	return {
		checkId: check.id,
		name: check.name,
		status: verdict.ok ? "passed" : exitCode === 124 ? "error" : "failed",
		exitCode,
		durationMs,
		artifact: artifact?.id,
		outputHead: truncated.head.split("\n").slice(0, 40).join("\n"),
		outputTail: truncated.tail.split("\n").slice(-20).join("\n"),
		truncated: truncated.truncated,
		startedAt,
		failureReason: verdict.reason,
	};
}

/** Files changed since the base commit, relative to the workspace. */
export function changedFiles(workspace: string, baseCommit?: string): string[] {
	if (!baseCommit) {
		const status = spawnSync("git", ["status", "--porcelain"], { cwd: workspace, encoding: "utf8" });
		if (status.status !== 0) return [];
		return status.stdout
			.split("\n")
			.map((line) => line.slice(3).trim())
			.filter((line) => line.length > 0);
	}
	// Tracked changes against the base commit plus untracked files, which a diff
	// alone would miss and which are exactly how a worker can smuggle in a file.
	const diff = spawnSync("git", ["diff", "--name-only", baseCommit], { cwd: workspace, encoding: "utf8" });
	const untracked = spawnSync("git", ["ls-files", "--others", "--exclude-standard"], {
		cwd: workspace,
		encoding: "utf8",
	});
	const files = new Set<string>();
	for (const line of diff.stdout.split("\n")) if (line.trim().length > 0) files.add(line.trim());
	for (const line of untracked.stdout.split("\n")) if (line.trim().length > 0) files.add(line.trim());
	return [...files];
}

function globToRegExp(glob: string): RegExp {
	const escaped = glob
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replaceAll("**", "\u0000")
		.replaceAll("*", "[^/]*")
		.replaceAll("\u0000/", "(?:.*/)?")
		.replaceAll("\u0000", ".*");
	return new RegExp(`^${escaped}$`);
}

/**
 * The diff monitor: flags the behaviors that mean "the check was gamed" rather
 * than "the problem was solved". Findings are warnings, not verdicts; L4 and the
 * human read them, and the final state treats `critical` findings as blocking.
 */
export function monitorIntegrity(gate: Gate, workspace: string, baseCommit: string | undefined): IntegrityReport {
	const files = changedFiles(workspace, baseCommit);
	const protectedPatterns = gate.integrity.protectedPaths.map(globToRegExp);
	const testPatterns = gate.integrity.testGlobs.map(globToRegExp);
	const protectedTouched = files.filter((file) => protectedPatterns.some((pattern) => pattern.test(file)));
	const unjustified = files.filter((file) =>
		gate.integrity.justifyPaths.some((glob) => globToRegExp(glob).test(file)),
	);
	const suspicious: Suspicion[] = [];

	for (const file of files) {
		if (!testPatterns.some((pattern) => pattern.test(file))) continue;
		const diff = spawnSync("git", ["diff", baseCommit ?? "HEAD", "--", file], {
			cwd: workspace,
			encoding: "utf8",
			maxBuffer: 16 * 1024 * 1024,
		});
		const removed = diff.stdout.split("\n").filter((line) => line.startsWith("-") && !line.startsWith("---"));
		const added = diff.stdout.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++"));
		suspicious.push({
			kind: "test_modified",
			path: file,
			detail: `${added.length} added and ${removed.length} removed lines in a test file`,
			severity: removed.length > 0 ? "warning" : "info",
		});
		if (added.some((line) => /\.(skip|only)\(|@pytest\.mark\.skip|xtest\(/.test(line))) {
			suspicious.push({
				kind: "test_skipped",
				path: file,
				detail: "a test was skipped or focused",
				severity: "critical",
			});
		}
		if (
			added.some((line) => /expect\(.*\)\.toBe\(.*\)|\bassert\b/.test(line)) &&
			removed.some((line) => /expect\(.*\)\.toBe\(.*\)|\bassert\b/.test(line))
		) {
			suspicious.push({
				kind: "hardcoded_expected_output",
				path: file,
				detail: "assertions were changed rather than the behavior",
				severity: "warning",
			});
		}
	}

	return {
		changedPaths: files,
		protectedTouched,
		unjustified,
		suspicious,
		clean: protectedTouched.length === 0 && !suspicious.some((finding) => finding.severity === "critical"),
	};
}

/** Runs invariants that can be checked from files and commands. */
export function checkInvariants(gate: Gate, workspace: string, baseCommit?: string): InvariantViolation[] {
	const violations: InvariantViolation[] = [];
	for (const invariant of gate.invariants) {
		if (invariant.kind === "paths_untouched") {
			const files = changedFiles(workspace, baseCommit);
			const hit = files.filter((file) => invariant.globs.some((glob) => globToRegExp(glob).test(file)));
			if (hit.length > 0) violations.push({ invariant, detail: `modified protected paths: ${hit.join(", ")}` });
		} else if (invariant.kind === "files_unchanged") {
			const changed = new Set(changedFiles(workspace, baseCommit));
			const hit = invariant.paths.filter((path) => changed.has(path));
			if (hit.length > 0) violations.push({ invariant, detail: `unchanged files were modified: ${hit.join(", ")}` });
		} else if (invariant.kind === "command_passes") {
			const result = spawnSync("bash", ["-lc", invariant.command], {
				cwd: workspace,
				encoding: "utf8",
				timeout: 300_000,
			});
			if (result.status !== 0)
				violations.push({ invariant, detail: `${invariant.name} failed with exit ${result.status}` });
		}
	}
	return violations;
}

/** Runs the gate: tree hash, checks (visible, optionally holdout), invariants, integrity. */
export function runGate(options: RunGateOptions): GateResult {
	const startedAt: Timestamp = new Date().toISOString();
	const hash = treeHash(options.workspace);
	const all = options.gate.checks.filter((check) => (options.includeHoldout ? true : check.visibility === "visible"));
	const selected = options.only
		? all.filter((check) => options.only?.includes(check.id) || options.only?.includes(check.name))
		: all;
	const visible = selected
		.filter((check) => check.visibility === "visible")
		.map((check) =>
			runCheck(check, options.workspace, {
				timeoutMs: options.defaultTimeoutMs,
				artifacts: options.artifacts,
				truncation: options.truncation,
			}),
		);
	const holdout = selected
		.filter((check) => check.visibility === "holdout")
		.map((check) =>
			runCheck(check, options.workspace, {
				timeoutMs: options.defaultTimeoutMs,
				artifacts: options.artifacts,
				truncation: options.truncation,
			}),
		);
	const invariantViolations = checkInvariants(options.gate, options.workspace, options.baseCommit);
	const integrity = monitorIntegrity(options.gate, options.workspace, options.baseCommit);
	const passed = [...visible, ...holdout].every((run) => run.status === "passed") && invariantViolations.length === 0;
	const total = visible.length + holdout.length;
	return {
		gateId: options.gate.id,
		gateVersion: options.gate.version,
		treeHash: hash,
		startedAt,
		finishedAt: new Date().toISOString(),
		visible,
		holdout,
		invariantViolations,
		integrity,
		passed,
		passRatio: total === 0 ? 0 : [...visible, ...holdout].filter((run) => run.status === "passed").length / total,
	};
}

/** A one-paragraph human summary of a gate result. */
export function describeResult(result: GateResult): string {
	const runs = [...result.visible, ...result.holdout];
	const failed = runs.filter((run) => run.status !== "passed");
	const verdict = result.passed ? "PASSED" : failed.length > 0 ? "FAILED" : "PARTIAL";
	const lines = [
		`${verdict} on tree ${result.treeHash.slice(0, 12)}`,
		`${runs.length - failed.length}/${runs.length} checks passed`,
	];
	for (const run of failed) lines.push(`- ${run.name}: ${run.failureReason ?? run.status}`);
	for (const violation of result.invariantViolations) lines.push(`- invariant violated: ${violation.detail}`);
	if (!result.integrity.clean)
		lines.push(`- integrity: ${result.integrity.suspicious.map((finding) => finding.kind).join(", ")}`);
	return lines.join("\n");
}

/** Tree hash without git, for tests and non-repo directories. */
export function hashTree(root: string): string {
	return createHash("sha1").update(root).digest("hex");
}

export type { Id };
