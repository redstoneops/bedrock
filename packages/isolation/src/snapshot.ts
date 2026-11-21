// @bedrock/isolation: snapshotting a dirty working tree and applying a winner back.
//
// Workers branch from a snapshot commit of the primary working tree, built with a
// temporary index, so uncommitted and untracked user changes are included and
// the user's own index and HEAD are never touched. When a candidate wins, its
// diff against the snapshot is applied to the primary working tree; nothing is
// committed on the user's behalf.

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function git(
	cwd: string,
	args: string[],
	env: Record<string, string> = {},
	input?: string,
): { ok: boolean; stdout: string; stderr: string } {
	const result = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		env: { ...process.env, ...env },
		input,
		maxBuffer: 256 * 1024 * 1024,
	});
	return { ok: result.status === 0, stdout: (result.stdout ?? "").trim(), stderr: (result.stderr ?? "").trim() };
}

/**
 * Creates a commit holding the current working tree (tracked changes plus
 * untracked files that are not ignored), parented on HEAD. Returns HEAD itself
 * when the tree is clean.
 */
export function snapshotCommit(repo: string, message = "bedrock: snapshot of the working tree"): string {
	const head = git(repo, ["rev-parse", "HEAD"]);
	if (!head.ok) throw new Error(`cannot snapshot ${repo}: no HEAD commit (${head.stderr})`);
	const status = git(repo, ["status", "--porcelain"]);
	if (status.ok && status.stdout.length === 0) return head.stdout;
	const index = join(tmpdir(), `bedrock-index-${randomUUID()}`);
	const env = { GIT_INDEX_FILE: index };
	try {
		const read = git(repo, ["read-tree", "HEAD"], env);
		if (!read.ok) throw new Error(`read-tree failed: ${read.stderr}`);
		const add = git(repo, ["add", "-A"], env);
		if (!add.ok) throw new Error(`add failed: ${add.stderr}`);
		// Harness state never belongs in a candidate tree.
		git(repo, ["rm", "-r", "-q", "--cached", "--ignore-unmatch", ".bedrock"], env);
		const tree = git(repo, ["write-tree"], env);
		if (!tree.ok) throw new Error(`write-tree failed: ${tree.stderr}`);
		const commit = git(repo, ["commit-tree", tree.stdout, "-p", head.stdout, "-m", message], {
			GIT_AUTHOR_NAME: "bedrock",
			GIT_AUTHOR_EMAIL: "bedrock@localhost",
			GIT_COMMITTER_NAME: "bedrock",
			GIT_COMMITTER_EMAIL: "bedrock@localhost",
		});
		if (!commit.ok) throw new Error(`commit-tree failed: ${commit.stderr}`);
		return commit.stdout;
	} finally {
		rmSync(index, { force: true });
	}
}

/** Directories worth sharing into a worktree instead of reinstalling. */
const DEPENDENCY_DIRS = ["node_modules", ".venv", "venv"];

/**
 * Symlinks dependency directories (root and one level of packages) from the
 * primary checkout into a worktree, so `npm test` or `pytest` works there
 * without a reinstall. Build output directories are deliberately not shared:
 * two workers writing the same `target/` would race.
 */
export function linkDependencyDirs(primary: string, worktree: string): string[] {
	const linked: string[] = [];
	const candidates: string[] = [...DEPENDENCY_DIRS];
	for (const parent of ["packages", "apps", "libs"]) {
		const dir = join(primary, parent);
		if (!existsSync(dir)) continue;
		for (const name of readdirSync(dir)) candidates.push(join(parent, name, "node_modules"));
	}
	for (const relative of candidates) {
		const source = join(primary, relative);
		const target = join(worktree, relative);
		if (!existsSync(source) || existsSync(target)) continue;
		if (!existsSync(join(target, ".."))) continue;
		try {
			if (!lstatSync(source).isDirectory()) continue;
			symlinkSync(source, target, "dir");
			linked.push(relative);
		} catch {
			// A failed link only costs a reinstall; never fail the worker for it.
		}
	}
	return linked;
}

/** Commits everything in a worktree (including untracked files) and returns the commit. */
export function commitAll(worktree: string, message: string): string {
	git(worktree, ["add", "-A"]);
	// Symlinked dependency dirs must never be committed into a candidate.
	for (const dir of DEPENDENCY_DIRS) git(worktree, ["reset", "-q", "--", dir]);
	const status = git(worktree, ["diff", "--cached", "--quiet"]);
	if (!status.ok) {
		const committed = git(worktree, ["commit", "-q", "--no-verify", "-m", message], {
			GIT_AUTHOR_NAME: "bedrock",
			GIT_AUTHOR_EMAIL: "bedrock@localhost",
			GIT_COMMITTER_NAME: "bedrock",
			GIT_COMMITTER_EMAIL: "bedrock@localhost",
		});
		if (!committed.ok) throw new Error(`commit failed in ${worktree}: ${committed.stderr}`);
	}
	return git(worktree, ["rev-parse", "HEAD"]).stdout;
}

/** The binary diff between two commits, for review and for applying. */
export function diffBetween(repo: string, from: string, to: string): string {
	const diff = git(repo, ["diff", "--binary", from, to]);
	return diff.ok ? `${diff.stdout}\n` : "";
}

/** Additions, deletions and files changed between two commits. */
export function diffStatBetween(
	repo: string,
	from: string,
	to: string,
): { files: number; additions: number; deletions: number } {
	const numstat = git(repo, ["diff", "--numstat", from, to]);
	let files = 0;
	let additions = 0;
	let deletions = 0;
	for (const line of numstat.stdout.split("\n")) {
		if (line.trim().length === 0) continue;
		const [added, removed] = line.split("\t");
		files += 1;
		additions += Number(added) || 0;
		deletions += Number(removed) || 0;
	}
	return { files, additions, deletions };
}

export interface ApplyResult {
	ok: boolean;
	detail: string;
	files: string[];
}

/**
 * Applies `from..to` to the primary working tree. Uses a three-way apply so a
 * user edit made during the mission conflicts loudly instead of being lost.
 */
export function applyCandidate(primary: string, from: string, to: string): ApplyResult {
	const diff = diffBetween(primary, from, to);
	if (diff.trim().length === 0) return { ok: true, detail: "no changes to apply", files: [] };
	const files = git(primary, ["diff", "--name-only", from, to])
		.stdout.split("\n")
		.filter((line) => line.length > 0);
	const check = git(primary, ["apply", "--check", "--whitespace=nowarn", "-"], {}, diff);
	if (!check.ok) {
		const threeWay = git(primary, ["apply", "--3way", "--whitespace=nowarn", "-"], {}, diff);
		return threeWay.ok
			? { ok: true, detail: "applied with a three-way merge", files }
			: { ok: false, detail: `the winning diff does not apply cleanly: ${check.stderr || threeWay.stderr}`, files };
	}
	const applied = git(primary, ["apply", "--whitespace=nowarn", "-"], {}, diff);
	return applied.ok ? { ok: true, detail: "applied", files } : { ok: false, detail: applied.stderr, files };
}
