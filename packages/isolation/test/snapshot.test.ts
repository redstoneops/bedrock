import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	applyCandidate,
	commitAll,
	createWorktree,
	diffStatBetween,
	linkDependencyDirs,
	removeWorktree,
	snapshotCommit,
} from "../src/index.ts";

const dirs: string[] = [];
function repo(): string {
	const dir = mkdtempSync(join(tmpdir(), "bedrock-snap-"));
	dirs.push(dir);
	writeFileSync(join(dir, "a.txt"), "one\n");
	writeFileSync(join(dir, ".gitignore"), "node_modules/\n");
	execFileSync("git", ["init", "-q"], { cwd: dir });
	execFileSync("git", ["config", "user.email", "t@e.com"], { cwd: dir });
	execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
	execFileSync("git", ["add", "-A"], { cwd: dir });
	execFileSync("git", ["commit", "-qm", "init"], { cwd: dir });
	return dir;
}
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("snapshots and candidates", () => {
	it("returns HEAD for a clean tree and a new commit for a dirty one, without touching the index", () => {
		const dir = repo();
		const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
		expect(snapshotCommit(dir)).toBe(head);
		writeFileSync(join(dir, "a.txt"), "dirty\n");
		writeFileSync(join(dir, "new.txt"), "untracked\n");
		mkdirSync(join(dir, ".bedrock"));
		writeFileSync(join(dir, ".bedrock", "state.json"), "{}");
		const snap = snapshotCommit(dir);
		expect(snap).not.toBe(head);
		const files = execFileSync("git", ["ls-tree", "--name-only", snap], { cwd: dir, encoding: "utf8" });
		expect(files).toContain("new.txt");
		expect(files).not.toContain(".bedrock");
		expect(execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: dir, encoding: "utf8" }).trim()).toBe("");
		expect(execFileSync("git", ["show", `${snap}:a.txt`], { cwd: dir, encoding: "utf8" })).toBe("dirty\n");
	});

	it("links dependency dirs, commits a candidate without them, and applies it back", () => {
		const dir = repo();
		mkdirSync(join(dir, "node_modules", "dep"), { recursive: true });
		writeFileSync(join(dir, "a.txt"), "dirty base\n");
		const base = snapshotCommit(dir);
		const worktree = createWorktree({
			repo: dir,
			root: join(tmpdir(), `bedrock-wt-${Date.now()}`),
			label: "w1",
			base,
		});
		dirs.push(join(worktree.path, ".."));
		expect(linkDependencyDirs(dir, worktree.path)).toEqual(["node_modules"]);
		expect(lstatSync(join(worktree.path, "node_modules")).isSymbolicLink()).toBe(true);
		writeFileSync(join(worktree.path, "a.txt"), "fixed\n");
		const commit = commitAll(worktree.path, "candidate");
		expect(execFileSync("git", ["ls-tree", "--name-only", commit], { cwd: dir, encoding: "utf8" })).not.toContain(
			"node_modules",
		);
		expect(diffStatBetween(dir, base, commit)).toEqual({ files: 1, additions: 1, deletions: 1 });
		const applied = applyCandidate(dir, base, commit);
		expect(applied.ok).toBe(true);
		expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("fixed\n");
		removeWorktree(worktree, true);
		expect(existsSync(worktree.path)).toBe(false);
	});

	it("reports a conflict instead of clobbering a user edit", () => {
		const dir = repo();
		const base = snapshotCommit(dir);
		const worktree = createWorktree({
			repo: dir,
			root: join(tmpdir(), `bedrock-wt-${Date.now()}-c`),
			label: "w2",
			base,
		});
		dirs.push(join(worktree.path, ".."));
		writeFileSync(join(worktree.path, "a.txt"), "worker\n");
		const commit = commitAll(worktree.path, "candidate");
		writeFileSync(join(dir, "a.txt"), "user edited meanwhile\n");
		const applied = applyCandidate(dir, base, commit);
		expect(applied.ok).toBe(false);
		expect(readFileSync(join(dir, "a.txt"), "utf8")).toContain("user edited meanwhile");
		removeWorktree(worktree, true);
	});
});
