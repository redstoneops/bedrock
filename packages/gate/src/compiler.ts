// @bedrock/gate: Recipe. Compiling a mission into a machine-checkable Gate.
//
// The compiler deliberately prefers the repository's own canonical commands over
// invented ones: a check that the project already runs in CI is harder to game
// and more likely to be right. User-supplied gate commands are always included
// and cannot be weakened. When no canonical command is found the gate says so
// rather than inventing a vacuous check.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CommandCheck, Expectation, Gate, Id, IntegrityRules, Mission, ScoutReport } from "@bedrock/protocol";

export interface CompileOptions {
	/** Commands that must run regardless of detection (the `--gate` flag). */
	userCommands?: string[];
	/** Extra acceptance checks the caller already knows about. */
	extraChecks?: CommandCheck[];
	/** Test glob used by the diff monitor to flag test edits. */
	testGlobs?: string[];
	/** Paths a worker may never modify. Defaults cover git metadata and gate material. */
	protectedPaths?: string[];
}

/** Default integrity rules. Committed with the gate; refinement cannot change them. */
export function defaultIntegrity(overrides: Partial<IntegrityRules> = {}): IntegrityRules {
	return {
		protectedPaths: overrides.protectedPaths ?? [".git/**", ".bedrock/gate/**", ".bedrock/holdout/**"],
		justifyPaths: overrides.justifyPaths ?? [],
		forbidHistoryMining: overrides.forbidHistoryMining ?? false,
		networkAllowlist: overrides.networkAllowlist ?? [],
		testGlobs: overrides.testGlobs ?? ["**/*.test.*", "**/*.spec.*", "**/test/**", "**/tests/**"],
	};
}

function exitCheck(
	name: string,
	command: string,
	kind: CommandCheck["kind"],
	origin: CommandCheck["origin"] = "existing",
	visibility: CommandCheck["visibility"] = "visible",
	expect: Expectation = { kind: "exit_code", code: 0 },
): CommandCheck {
	return {
		id: `chk_${crypto.randomUUID().replaceAll("-", "")}` as Id<"check">,
		name,
		kind,
		command,
		expect,
		origin,
		visibility,
	};
}

interface PackageJson {
	scripts?: Record<string, string>;
}

function readPackageScripts(workspace: string): Record<string, string> | undefined {
	const path = join(workspace, "package.json");
	if (!existsSync(path)) return undefined;
	try {
		const pkg = JSON.parse(readFileSync(path, "utf8")) as PackageJson;
		return pkg.scripts ?? {};
	} catch {
		return undefined;
	}
}

/** The checks a repository already advertises, in the order we prefer to trust them. */
export function detectChecks(workspace: string, scout?: ScoutReport): CommandCheck[] {
	const commands = scout?.commands ?? {};
	const checks: CommandCheck[] = [];
	if (commands.install) checks.push(exitCheck("install", commands.install, "command"));
	if (commands.build) checks.push(exitCheck("build", commands.build, "build"));
	if (commands.typecheck) checks.push(exitCheck("typecheck", commands.typecheck, "typecheck"));
	if (commands.test) checks.push(exitCheck("test", commands.test, "test"));
	if (commands.lint) checks.push(exitCheck("lint", commands.lint, "lint"));

	if (checks.length > 0) return checks;

	// Without a scout report, detect from files on disk.
	const scripts = readPackageScripts(workspace);
	if (scripts) {
		if (scripts.build) checks.push(exitCheck("build", "npm run build", "build"));
		if (scripts.typecheck) checks.push(exitCheck("typecheck", "npm run typecheck", "typecheck"));
		if (scripts.test) checks.push(exitCheck("test", "npm test", "test"));
		if (scripts.lint) checks.push(exitCheck("lint", "npm run lint", "lint"));
		return checks;
	}
	if (existsSync(join(workspace, "Cargo.toml"))) {
		checks.push(exitCheck("build", "cargo build", "build"), exitCheck("test", "cargo test", "test"));
	} else if (existsSync(join(workspace, "pyproject.toml")) || existsSync(join(workspace, "pytest.ini"))) {
		checks.push(exitCheck("test", "python3 -m pytest -q", "test"));
	} else if (existsSync(join(workspace, "go.mod"))) {
		checks.push(exitCheck("build", "go build ./...", "build"), exitCheck("test", "go test ./...", "test"));
	} else if (existsSync(join(workspace, "Makefile"))) {
		checks.push(exitCheck("test", "make test", "test"));
	}
	return checks;
}

/**
 * Compiles a gate. `holdout` checks are supplied by the caller (an eval harness
 * or a human); the compiler never guesses a holdout, but it always records that
 * none exists so a reader knows the "passed" is visible-checks-only.
 */
export function compileGate(mission: Mission, scout?: ScoutReport, options: CompileOptions = {}): Gate {
	const checks = detectChecks(mission.workspace, scout);
	const userSupplied = options.userCommands ?? mission.spec.gateCommands ?? [];
	for (const [index, command] of userSupplied.entries()) {
		checks.push(exitCheck(`user-gate-${index + 1}`, command, "command", "acceptance"));
	}
	const extra = options.extraChecks ?? [];
	checks.push(...extra);

	const rubric = mission.spec.constraints?.map((constraint, index) => ({
		id: `constraint-${index + 1}`,
		criterion: constraint,
		weight: 1,
		severity: "major" as const,
		evidenceHint: "Point to the file or command that shows this holds.",
	}));

	const rationale =
		checks.length === 0
			? "No build, test or lint command was detected. Pass --gate with the command that proves this task is done."
			: `Gate built from the repository's own commands (${checks.map((check) => check.name).join(", ")})${
					userSupplied.length > 0 ? ` plus ${userSupplied.length} user-supplied command(s)` : ""
				}.`;

	return {
		id: `gat_${crypto.randomUUID().replaceAll("-", "")}` as Id<"gate">,
		missionId: mission.id,
		version: 1,
		origin: "compiled",
		createdAt: new Date().toISOString(),
		checks,
		invariants: [
			{
				kind: "paths_untouched",
				globs: options.protectedPaths ?? [".git/**"],
				reason: "git metadata must not be rewritten",
			},
		],
		rubric: rubric ?? [],
		integrity: defaultIntegrity({
			protectedPaths: options.protectedPaths,
			testGlobs: options.testGlobs,
		}),
		userSupplied,
		approved: false,
		rationale,
	};
}
