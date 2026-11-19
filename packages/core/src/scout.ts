// @bedrock/core: the scout. A cheap, fast pass that maps the repo before anything else runs.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Mission, ScoutReport } from "@bedrock/protocol";

/** Directories that say nothing about the language mix. */
const SKIP = new Set([
	".git",
	"node_modules",
	"dist",
	"build",
	"coverage",
	".next",
	"target",
	"__pycache__",
	".venv",
	"vendor",
	"refs",
]);

const LANGUAGE_BY_EXT: Record<string, string> = {
	".ts": "TypeScript",
	".tsx": "TypeScript",
	".js": "JavaScript",
	".jsx": "JavaScript",
	".mjs": "JavaScript",
	".cjs": "JavaScript",
	".py": "Python",
	".rs": "Rust",
	".go": "Go",
	".java": "Java",
	".kt": "Kotlin",
	".rb": "Ruby",
	".php": "PHP",
	".c": "C",
	".h": "C",
	".cc": "C++",
	".cpp": "C++",
	".hpp": "C++",
	".cs": "C#",
	".swift": "Swift",
	".sh": "Shell",
	".sql": "SQL",
};

const CONTEXT_FILES = [
	"AGENTS.md",
	"CLAUDE.md",
	"README.md",
	"CONTRIBUTING.md",
	".cursorrules",
	".github/copilot-instructions.md",
	".agents",
];

export interface ScoutOptions {
	workspace: string;
	mission?: Mission;
	/** Cap the walk for very large repositories. */
	maxFiles?: number;
}

function git(workspace: string, args: string[]): string | undefined {
	const result = spawnSync("git", args, { cwd: workspace, encoding: "utf8" });
	return result.status === 0 ? result.stdout.trim() : undefined;
}

function countLanguages(
	workspace: string,
	maxFiles = 50_000,
): { languages: Array<{ name: string; files: number }>; total: number } {
	const counts = new Map<string, number>();
	let total = 0;
	const visit = (dir: string) => {
		if (total >= maxFiles) return;
		let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (total >= maxFiles) return;
			if (SKIP.has(entry.name)) continue;
			const absolute = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (entry.name.startsWith(".") && entry.name !== ".agents" && entry.name !== ".github") continue;
				visit(absolute);
			} else if (entry.isFile()) {
				const ext = entry.name.slice(entry.name.lastIndexOf("."));
				const language = LANGUAGE_BY_EXT[ext];
				if (language) {
					counts.set(language, (counts.get(language) ?? 0) + 1);
					total++;
				}
			}
		}
	};
	visit(workspace);
	const languages = [...counts.entries()]
		.map(([name, files]) => ({ name, files }))
		.sort((a, b) => b.files - a.files)
		.slice(0, 8);
	return { languages, total };
}

interface PackageJson {
	scripts?: Record<string, string>;
	workspaces?: unknown;
	packageManager?: string;
}

/** The canonical commands for the repository, preferring scripts the project defines. */
export function detectCommands(workspace: string): ScoutReport["commands"] {
	const commands: ScoutReport["commands"] = {};
	const pkgPath = join(workspace, "package.json");
	if (existsSync(pkgPath)) {
		let pkg: PackageJson = {};
		try {
			pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as PackageJson;
		} catch {
			pkg = {};
		}
		const scripts = pkg.scripts ?? {};
		const binary =
			existsSync(join(workspace, "bun.lockb")) || existsSync(join(workspace, "bun.lock")) ? "bun run" : "npm run";
		if (scripts.build) commands.build = `${binary} build`;
		if (scripts.test) commands.test = `${binary} test`;
		if (scripts.typecheck) commands.typecheck = `${binary} typecheck`;
		else if (scripts["type-check"]) commands.typecheck = `${binary} type-check`;
		if (scripts.lint) commands.lint = `${binary} lint`;
		else if (scripts.check) commands.lint = `${binary} check`;
		if (scripts.format) commands.format = `${binary} format`;
		if (existsSync(join(workspace, "package-lock.json"))) commands.install = "npm ci --ignore-scripts";
		else if (existsSync(join(workspace, "bun.lockb")) || existsSync(join(workspace, "bun.lock")))
			commands.install = "bun install";
	}
	if (existsSync(join(workspace, "Cargo.toml"))) {
		commands.build ??= "cargo build";
		commands.test ??= "cargo test";
	}
	if (
		existsSync(join(workspace, "pyproject.toml")) ||
		existsSync(join(workspace, "pytest.ini")) ||
		existsSync(join(workspace, "setup.py"))
	) {
		commands.test ??= existsSync(join(workspace, "pytest.ini")) ? "python3 -m pytest -q" : "python3 -m pytest -q";
		commands.install ??= existsSync(join(workspace, "uv.lock")) ? "uv sync" : undefined;
		commands.lint ??= existsSync(join(workspace, "ruff.toml")) ? "ruff check ." : undefined;
	}
	if (existsSync(join(workspace, "go.mod"))) {
		commands.build ??= "go build ./...";
		commands.test ??= "go test ./...";
	}
	if (existsSync(join(workspace, "Makefile"))) {
		const makefile = readFileSync(join(workspace, "Makefile"), "utf8");
		if (/^test:/m.test(makefile)) commands.test ??= "make test";
		if (/^build:/m.test(makefile)) commands.build ??= "make build";
		if (/^lint:/m.test(makefile)) commands.lint ??= "make lint";
	}
	return commands;
}

/** Probes the toolchain, once, so the gate does not discover a missing compiler mid-run. */
function probeEnvironment(): ScoutReport["services"] {
	const probes: Array<[string, string[]]> = [
		["node", ["node", "--version"]],
		["npm", ["npm", "--version"]],
		["python3", ["python3", "--version"]],
		["git", ["git", "--version"]],
		["docker", ["docker", "--version"]],
		["rg", ["rg", "--version"]],
	];
	return probes.map(([name, command]) => {
		const result = spawnSync(command[0], command.slice(1), { encoding: "utf8", timeout: 10_000 });
		return {
			name,
			reachable: result.status === 0,
			detail: result.status === 0 ? (result.stdout.split("\n")[0] ?? "").trim() : "not found",
		};
	});
}

function buildSystem(workspace: string): string | undefined {
	if (existsSync(join(workspace, "package.json"))) {
		const pkg = JSON.parse(readFileSync(join(workspace, "package.json"), "utf8")) as PackageJson;
		if (pkg.workspaces) return "npm workspaces";
		return pkg.packageManager ?? "npm";
	}
	if (existsSync(join(workspace, "Cargo.toml"))) return "cargo";
	if (existsSync(join(workspace, "pyproject.toml"))) return "python";
	if (existsSync(join(workspace, "go.mod"))) return "go modules";
	if (existsSync(join(workspace, "Makefile"))) return "make";
	return undefined;
}

/**
 * Produces the ScoutReport. Everything here is cheap and deterministic: no model
 * calls, no network. The report is what the gate compiler and the strategist see.
 */
export function scout(options: ScoutOptions): ScoutReport {
	const { workspace } = options;
	const { languages, total } = countLanguages(workspace, options.maxFiles);
	const branch = git(workspace, ["rev-parse", "--abbrev-ref", "HEAD"]);
	const commit = git(workspace, ["rev-parse", "HEAD"]);
	const status = git(workspace, ["status", "--porcelain"]);
	const contextFiles = CONTEXT_FILES.filter((file) => existsSync(join(workspace, file)));
	const commands = detectCommands(workspace);
	const notes: string[] = [];
	if (total > 20_000) notes.push(`large repository: ${total} source files; reads should be scoped`);
	if (languages[0] && languages[0].files > 0)
		notes.push(`primary language: ${languages[0].name} (${languages[0].files} files)`);
	if (!commands.test) notes.push("no test command detected; the gate will need a --gate command");
	if (contextFiles.length > 0) notes.push(`context files present: ${contextFiles.join(", ")}`);
	const head = git(workspace, ["log", "-1", "--pretty=%s"]);
	if (head) notes.push(`HEAD: ${head}`);

	return {
		missionId: options.mission?.id ?? ("" as ScoutReport["missionId"]),
		createdAt: new Date().toISOString(),
		root: workspace,
		vcs: branch && commit ? { kind: "git", branch, commit, clean: status === "" } : undefined,
		languages,
		buildSystem: buildSystem(workspace),
		commands,
		contextFiles,
		notes,
		services: probeEnvironment(),
	};
}

/** Reads the context files (AGENTS.md and friends) so the system prompt can include them. */
export function readContextFiles(workspace: string, files: string[], maxBytes = 12_000): string {
	const parts: string[] = [];
	for (const file of files) {
		const path = join(workspace, file);
		if (!existsSync(path)) continue;
		let content: string;
		try {
			content = readFileSync(path, "utf8");
		} catch {
			continue;
		}
		parts.push(
			`### ${basename(file)}\n${content.slice(0, maxBytes)}${content.length > maxBytes ? "\n(truncated)" : ""}`,
		);
	}
	return parts.join("\n\n");
}
