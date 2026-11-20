import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	checkpoint,
	commitCheckpoint,
	copyWorkspace,
	createWorktree,
	headCommit,
	isGitRepo,
	mergeCandidate,
	removeWorktree,
	rewind,
} from "../src/index.ts";

const dirs: string[] = [];
function repo(): string {
	const dir = mkdtempSync(join(tmpdir(), "bedrock-iso-"));
	dirs.push(dir);
	writeFileSync(join(dir, "README.md"), "# test\n");
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

describe("worktrees", () => {
	it("detects a git repo and its head", () => {
		const dir = repo();
		expect(isGitRepo(dir)).toBe(true);
		expect(headCommit(dir)).toMatch(/^[0-9a-f]{40}$/);
		expect(isGitRepo(join(dir, "nonexistent"))).toBe(false);
	});

	it("creates an isolated worktree on its own branch", () => {
		const dir = repo();
		const worktree = createWorktree({ repo: dir, root: join(dir, ".bedrock", "worktrees"), label: "worker-1" });
		expect(existsSync(worktree.path)).toBe(true);
		expect(worktree.branch.startsWith("bedrock/worker-1-")).toBe(true);
		writeFileSync(join(worktree.path, "README.md"), "# changed in the worktree\n");
		expect(readFileSync(join(dir, "README.md"), "utf8")).toBe("# test\n");
		removeWorktree(worktree, true);
		expect(existsSync(worktree.path)).toBe(false);
	});

	it("refuses to create a worktree outside git", () => {
		const dir = mkdtempSync(join(tmpdir(), "bedrock-nogit-"));
		dirs.push(dir);
		expect(() => createWorktree({ repo: dir, root: join(dir, "w"), label: "x" })).toThrow(/not a git repository/);
	});

	it("checkpoints and rewinds, discarding later changes", () => {
		const dir = repo();
		const worktree = createWorktree({ repo: dir, root: join(dir, ".bedrock", "worktrees"), label: "worker-2" });
		writeFileSync(join(worktree.path, "a.txt"), "one\n");
		const point = checkpoint(worktree, "after a.txt");
		expect(point.commit).toMatch(/^[0-9a-f]{40}$/);
		writeFileSync(join(worktree.path, "a.txt"), "two\n");
		rewind(worktree, point.commit);
		expect(readFileSync(join(worktree.path, "a.txt"), "utf8")).toBe("one\n");
		removeWorktree(worktree, true);
	});

	it("merges a candidate branch without committing", () => {
		const dir = repo();
		const worktree = createWorktree({ repo: dir, root: join(dir, ".bedrock", "worktrees"), label: "worker-3" });
		writeFileSync(join(worktree.path, "b.txt"), "new\n");
		commitCheckpoint(worktree, "add b");
		const merged = mergeCandidate(dir, worktree.branch);
		expect(merged.ok).toBe(true);
		expect(readFileSync(join(dir, "b.txt"), "utf8")).toBe("new\n");
		execFileSync("git", ["merge", "--abort"], { cwd: dir });
		removeWorktree(worktree, true);
	});

	it("reports conflicts without half-merging", () => {
		const dir = repo();
		const worktree = createWorktree({ repo: dir, root: join(dir, ".bedrock", "worktrees"), label: "worker-4" });
		writeFileSync(join(worktree.path, "README.md"), "# worker\n");
		commitCheckpoint(worktree, "worker edit");
		writeFileSync(join(dir, "README.md"), "# main\n");
		execFileSync("git", ["add", "-A"], { cwd: dir });
		execFileSync("git", ["commit", "-qm", "main edit"], { cwd: dir });
		const merged = mergeCandidate(dir, worktree.branch);
		expect(merged.ok).toBe(false);
		expect(merged.conflicts).toContain("README.md");
		expect(readFileSync(join(dir, "README.md"), "utf8")).toBe("# main\n");
		removeWorktree(worktree, true);
	});
});

describe("copyWorkspace", () => {
	it("copies without build output or git metadata", () => {
		const dir = mkdtempSync(join(tmpdir(), "bedrock-copy-"));
		dirs.push(dir);
		mkdirSync(join(dir, "src"));
		mkdirSync(join(dir, "node_modules"));
		writeFileSync(join(dir, "src", "a.ts"), "x");
		writeFileSync(join(dir, "node_modules", "dep.js"), "y");
		const destination = join(tmpdir(), `bedrock-copy-out-${Date.now()}`);
		dirs.push(destination);
		copyWorkspace(dir, destination);
		expect(existsSync(join(destination, "src", "a.ts"))).toBe(true);
		expect(existsSync(join(destination, "node_modules"))).toBe(false);
		expect(() => copyWorkspace(dir, join(dir, "nested"))).toThrow(/into itself/);
	});
});
