// @bedrock/lab: reading Terminal-Bench tasks.
//
// A Terminal-Bench task is a directory with task.yaml (the instruction), a
// Dockerfile for its environment and tests that are copied in only after the
// agent finishes: a true holdout. This adapter maps tasks onto BenchTask so
// suites, splits and metrics work the same way; executing them needs the
// container isolation mode (the environment is the Docker image).

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import type { BenchTask } from "./bench.ts";

interface TaskYaml {
	instruction?: string;
	difficulty?: string;
	category?: string;
	tags?: string[];
	max_agent_timeout_sec?: number;
}

/** Reads one task directory, or returns undefined when it is not a task. */
export function loadTerminalBenchTask(dir: string): BenchTask | undefined {
	const yamlPath = join(dir, "task.yaml");
	if (!existsSync(yamlPath)) return undefined;
	const task = parse(readFileSync(yamlPath, "utf8")) as TaskYaml;
	if (!task.instruction) return undefined;
	const id =
		dir
			.split("/")
			.filter((part) => part.length > 0)
			.at(-1) ?? dir;
	const tags = [task.difficulty, task.category, ...(task.tags ?? [])].filter(
		(tag): tag is string => typeof tag === "string" && tag.length > 0,
	);
	return {
		id,
		goal: task.instruction.trim(),
		// The agent sees no tests: everything that decides success is holdout.
		gate: ["true"],
		holdout: existsSync(join(dir, "run-tests.sh")) ? [`bash ${join(dir, "run-tests.sh")}`] : [],
		tags,
		source: { kind: "terminal-bench", dir },
	};
}

/** Reads every task under a Terminal-Bench `tasks/` (or `original-tasks/`) directory. */
export function loadTerminalBenchTasks(root: string, filter?: { tags?: string[]; limit?: number }): BenchTask[] {
	const tasks: BenchTask[] = [];
	for (const name of readdirSync(root).sort()) {
		const task = loadTerminalBenchTask(join(root, name));
		if (!task) continue;
		if (filter?.tags?.length && !task.tags?.some((tag) => filter.tags?.includes(tag))) continue;
		tasks.push(task);
		if (filter?.limit && tasks.length >= filter.limit) break;
	}
	return tasks;
}
