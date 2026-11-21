// @bedrock/isolation: one git worktree per worker, checkpoints, and rewind.
//
// A worktree is the cheapest real isolation: it shares the object store, so
// checkpoints are commits and a worker's changes cannot touch the primary
// checkout. Non-git directories fall back to an explicit refusal rather than a
// copy that would silently diverge.

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { basename, join, resolve } from "node:path";

export interface Worktree {
	/** Absolute path of the isolated checkout. */
	path: string;
	branch: string;
	/** Commit the worktree was created from. */
	base: string;
	/** Root repository the worktree belongs to. */
	repo: string;
}

export interface CreateWorktreeOptions {
	repo: string;
	/** Directory that will hold the worktree, usually `.bedrock/worktrees`. */
	root: string;
	/** Short, filesystem-safe label used in the branch and path. */
	label: string;
	/** Commit or ref to branch from. Defaults to HEAD. */
	base?: string;
}

function git(cwd: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
	const result = spawnSync("git", args, { cwd, encoding: "utf8" });
	return { ok: result.status === 0, stdout: (result.stdout ?? "").trim(), stderr: (result.stderr ?? "").trim() };
}

/** True when `dir` is inside a git work tree. */
export function isGitRepo(dir: string): boolean {
	return git(dir, ["rev-parse", "--is-inside-work-tree"]).stdout === "true";
}

/** The current commit of `dir`, or undefined outside git. */
export function headCommit(dir: string): string | undefined {
	const result = git(dir, ["rev-parse", "HEAD"]);
	return result.ok ? result.stdout : undefined;
}

/**
 * Creates a worktree on a new branch. The branch name includes the mission-ish
 * label and a timestamp so two workers never collide.
 */
export function createWorktree(options: CreateWorktreeOptions): Worktree {
	const repo = resolve(options.repo);
	if (!isGitRepo(repo)) throw new Error(`${repo} is not a git repository; use the copy isolation mode or a container`);
	const base = options.base ?? headCommit(repo);
	if (!base) throw new Error(`cannot resolve HEAD in ${repo}`);
	const label = options.label.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 40);
	const branch = `bedrock/${label}-${Date.now().toString(36)}`;
	const path = join(options.root, label);
	mkdirSync(options.root, { recursive: true });
	const added = git(repo, ["worktree", "add", "-b", branch, path, base]);
	if (!added.ok) throw new Error(`git worktree add failed: ${added.stderr}`);
	return { path, branch, base, repo };
}

/** Commits every change in the worktree, for a checkpoint. Returns the commit. */
export function commitCheckpoint(worktree: Worktree, message: string): string {
	git(worktree.path, ["add", "-A"]);
	const committed = git(worktree.path, ["commit", "-m", message, "--allow-empty"]);
	if (!committed.ok && !committed.stdout.includes("nothing to commit")) {
		throw new Error(`checkpoint commit failed: ${committed.stderr}`);
	}
	const head = headCommit(worktree.path);
	if (!head) throw new Error("checkpoint commit produced no commit");
	return head;
}

/** Resets the worktree to a checkpoint commit, discarding later changes. */
export function rewind(worktree: Worktree, commit: string): void {
	const reset = git(worktree.path, ["reset", "--hard", commit]);
	if (!reset.ok) throw new Error(`rewind failed: ${reset.stderr}`);
	git(worktree.path, ["clean", "-fd"]);
}

/**
 * Removes the worktree and its branch. `force` is required to discard
 * uncommitted changes; callers checkpoint before removing.
 */
export function removeWorktree(worktree: Worktree, force = false, keepBranch = false): void {
	git(worktree.repo, ["worktree", "remove", ...(force ? ["--force"] : []), worktree.path]);
	if (!keepBranch) git(worktree.repo, ["branch", "-D", worktree.branch]);
	if (existsSync(worktree.path)) rmSync(worktree.path, { recursive: true, force: true });
}

/**
 * Copies a directory for isolation when git is not available. Copies prune
 * `node_modules`, `dist` and `.git` by default; a copy is a last resort because
 * it cannot be merged back.
 */
export function copyWorkspace(
	source: string,
	destination: string,
	prune = ["node_modules", "dist", "build", ".git", ".bedrock"],
): void {
	const sourceAbs = resolve(source);
	const destinationAbs = resolve(destination);
	if (
		destinationAbs === sourceAbs ||
		destinationAbs.startsWith(`${sourceAbs}/`) ||
		destinationAbs.startsWith(`${sourceAbs}\\`)
	) {
		throw new Error(`cannot copy ${sourceAbs} into itself (${destinationAbs})`);
	}
	mkdirSync(destination, { recursive: true });
	cpSync(source, destination, {
		recursive: true,
		filter: (path) => {
			const name = basename(path);
			if (path === source) return true;
			return !prune.includes(name);
		},
	});
}

/** Creates a checkpoint commit and returns it, for the Ledger. */
export interface Checkpoint {
	label: string;
	commit: string;
	branch: string;
	createdAt: string;
}

export function checkpoint(worktree: Worktree, label: string): Checkpoint {
	const commit = commitCheckpoint(worktree, `bedrock checkpoint: ${label}`);
	return { label, commit, branch: worktree.branch, createdAt: new Date().toISOString() };
}

export interface MergeResult {
	ok: boolean;
	conflicts: string[];
	detail: string;
}

/**
 * Applies a worker's branch onto the primary branch in `repo`. The merge is
 * attempted with `--no-commit` so a conflict leaves the primary checkout
 * untouched and reports the files instead of half-merging.
 */
export function mergeCandidate(repo: string, branch: string): MergeResult {
	const merge = git(repo, ["merge", "--no-ff", "--no-commit", branch]);
	if (!merge.ok) {
		const conflicts = git(repo, ["diff", "--name-only", "--diff-filter=U"])
			.stdout.split("\n")
			.filter((line) => line.length > 0);
		git(repo, ["merge", "--abort"]);
		return { ok: false, conflicts, detail: merge.stderr || "merge conflict" };
	}
	return { ok: true, conflicts: [], detail: "merged without conflicts (not committed)" };
}
