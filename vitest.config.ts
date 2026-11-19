// Root Vitest config: runs every package's tests from TypeScript source.
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { defineConfig } from "vitest/config";

const root = import.meta.dirname;

// Map each workspace package name to its source entry so tests never need a build.
function workspaceAliases(): Record<string, string> {
	const aliases: Record<string, string> = {};
	for (const dir of readdirSync(join(root, "packages"))) {
		const pkgPath = join(root, "packages", dir, "package.json");
		let pkg: { name?: string };
		try {
			pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { name?: string };
		} catch {
			continue;
		}
		if (pkg.name) aliases[pkg.name] = resolve(root, "packages", dir, "src/index.ts");
	}
	return aliases;
}

export default defineConfig({
	resolve: {
		alias: workspaceAliases(),
	},
	test: {
		include: ["packages/*/test/**/*.test.ts"],
		exclude: ["**/node_modules/**", "**/dist/**", "refs/**", ".worktrees/**"],
		environment: "node",
		testTimeout: 30_000,
		hookTimeout: 30_000,
		pool: "forks",
	},
});
