import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Kernel } from "../src/index.ts";

const dirs: string[] = [];
const PYTHON = process.env.PYTHON ?? "python3";
const hasPython = spawnSync(PYTHON, ["--version"], { encoding: "utf8" }).status === 0;

function temp(): string {
	const dir = mkdtempSync(join(tmpdir(), "bedrock-kernel-"));
	dirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!hasPython)("Kernel", () => {
	it("keeps variables between executions and reports the last expression", async () => {
		const kernel = new Kernel({ workspace: temp() });
		await kernel.start();
		try {
			await kernel.execute("log_lines = ['a', 'b', 'c']");
			const result = await kernel.execute("len(log_lines)");
			expect(result.ok).toBe(true);
			expect(result.result).toBe("3");
			await kernel.execute("filtered = [line for line in log_lines if line != 'b']");
			expect((await kernel.execute("filtered")).result).toEqual("['a', 'c']");
		} finally {
			await kernel.stop();
		}
	});

	it("captures stdout and tracebacks without killing the kernel", async () => {
		const kernel = new Kernel({ workspace: temp() });
		await kernel.start();
		try {
			const printed = await kernel.execute("print('hello from python')");
			expect(printed.stdout).toContain("hello from python");
			const failed = await kernel.execute("1 / 0");
			expect(failed.ok).toBe(false);
			expect(failed.error?.traceback).toContain("ZeroDivisionError");
			expect((await kernel.execute("2 + 2")).result).toBe("4");
		} finally {
			await kernel.stop();
		}
	});

	it("exposes file helpers rooted in the workspace", async () => {
		const dir = temp();
		writeFileSync(join(dir, "notes.txt"), "alpha\nbeta\ngamma\n");
		const kernel = new Kernel({ workspace: dir });
		await kernel.start();
		try {
			const read = await kernel.execute("read('notes.txt', 1, 2)");
			expect(read.result).toContain("beta");
			const wrote = await kernel.execute("write('out/count.txt', 'three')");
			expect(wrote.ok).toBe(true);
			const grep = await kernel.execute("grep('beta', '.')");
			expect(grep.result).toContain("notes.txt");
		} finally {
			await kernel.stop();
		}
	});

	it("queues spawn requests that the host can drain", async () => {
		const kernel = new Kernel({ workspace: temp() });
		await kernel.start();
		try {
			await kernel.execute("spawn('scout', 'map the repo')");
			await kernel.execute("spawn('verifier', 'check the diff')");
			const spawns = await kernel.drainSpawns();
			expect(spawns.map((request) => request.role)).toEqual(["scout", "verifier"]);
			expect(await kernel.drainSpawns()).toEqual([]);
		} finally {
			await kernel.stop();
		}
	});

	it("snapshots and restores the namespace", async () => {
		const dir = temp();
		const kernel = new Kernel({ workspace: dir, stateDir: join(dir, ".state") });
		await kernel.start();
		try {
			await kernel.execute("big = list(range(10))");
			const path = await kernel.snapshot();
			await kernel.execute("big = None");
			const restored = await kernel.restore(path);
			expect(restored).toBeGreaterThan(0);
			expect((await kernel.execute("len(big)")).result).toBe("10");
		} finally {
			await kernel.stop();
		}
	});

	it("fails cleanly when Python is missing", async () => {
		const kernel = new Kernel({ workspace: temp(), python: "definitely-not-python" });
		await expect(kernel.start()).rejects.toThrow(/cannot start/);
	});
});
