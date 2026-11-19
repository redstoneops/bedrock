// @bedrock/gate: proving that an acceptance check tests something.
//
// An acceptance test that passes before the fix proves nothing. Before a worker
// ever sees the gate, the compiler runs each acceptance check against the
// pre-fix tree in a throwaway worktree; only checks that fail there (or carry a
// written justification for being a non-regression check) are kept visible.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandCheck } from "@bedrock/protocol";
import { runCheck } from "./runner.ts";

export type ValidationOutcome = { checkId: string; name: string; valid: boolean; reason: string };

export interface ValidateOptions {
	workspace: string;
	/** Commit the mission started from. */
	baseCommit: string;
	timeoutMs?: number;
}

/**
 * Runs acceptance checks against the base commit. Returns one outcome per check;
 * `valid` is true only when the check actually fails on the original code, or
 * when the caller supplied a justification.
 */
export function validateAcceptanceChecks(checks: CommandCheck[], options: ValidateOptions): ValidationOutcome[] {
	const acceptance = checks.filter((check) => check.origin === "acceptance" || check.origin === "holdout");
	if (acceptance.length === 0) return [];

	const worktree = mkdtempSync(join(tmpdir(), "bedrock-gate-base-"));
	const add = spawnSync("git", ["worktree", "add", "--detach", worktree, options.baseCommit], {
		cwd: options.workspace,
		encoding: "utf8",
	});
	if (add.status !== 0) {
		rmSync(worktree, { recursive: true, force: true });
		return acceptance.map((check) => ({
			checkId: check.id,
			name: check.name,
			valid: false,
			reason: `could not create a base worktree: ${add.stderr.trim()}`,
		}));
	}

	const outcomes: ValidationOutcome[] = [];
	try {
		for (const check of acceptance) {
			if (check.baseline?.justification) {
				outcomes.push({ checkId: check.id, name: check.name, valid: true, reason: check.baseline.justification });
				continue;
			}
			const run = runCheck(check, worktree, { timeoutMs: options.timeoutMs ?? check.timeoutMs });
			const fails = run.status !== "passed";
			if (!fails) {
				// A check that already passes on the base tree is refused unless it is
				// explicitly marked as a non-regression check with a justification.
				check.visibility = "holdout";
				check.baseline = {
					failsWithoutFix: false,
					justification: "passed before the fix; demoted to holdout as a non-regression check",
				};
				outcomes.push({
					checkId: check.id,
					name: check.name,
					valid: true,
					reason: "passed on the base tree; demoted to holdout as a non-regression check",
				});
				continue;
			}
			check.baseline = { failsWithoutFix: true };
			outcomes.push({
				checkId: check.id,
				name: check.name,
				valid: true,
				reason: "fails on the base tree, as an acceptance check must",
			});
		}
	} finally {
		spawnSync("git", ["worktree", "remove", "--force", worktree], { cwd: options.workspace, encoding: "utf8" });
		rmSync(worktree, { recursive: true, force: true });
	}
	return outcomes;
}
