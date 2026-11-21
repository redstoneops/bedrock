import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ai } from "@bedrock/ai";
import { defaultConfig } from "@bedrock/protocol";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { computeMetrics, createMissionRunner, loadSuite, loadTerminalBenchTasks, runSuite } from "../src/index.ts";

const suitePath = join(import.meta.dirname, "..", "..", "..", "evals", "bedrock-hard", "suite.json");
const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scriptedAi(lineFour: string): () => Ai {
	return () => {
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("edit", { patch: `¶range.js\nPUT 4\n${lineFour}` })]),
			fauxAssistantMessage([
				fauxToolCall("finish", { summary: "fixed range", checks: ["npm test"], unverified: [] }),
			]),
		]);
		return new Ai({ config: defaultConfig(), models });
	};
}

describe("mission runner with an independent holdout", () => {
	const suite = loadSuite(suitePath);
	const rangeOnly = { ...suite, tasks: suite.tasks.filter((task) => task.id === "range-off-by-one") };
	const config = defaultConfig();
	config.loop.maxParallelWorkers = 1;

	it("loads the bundled suite with absolute fixture paths", () => {
		expect(suite.tasks.length).toBeGreaterThanOrEqual(3);
		expect(suite.tasks.every((task) => task.fixture?.startsWith("/"))).toBe(true);
	});

	it("scores a general fix as solved", async () => {
		const run = await runSuite({
			suite: rangeOnly,
			config,
			runner: createMissionRunner({
				makeAi: scriptedAi("\tfor (let i = start; i < end; i++) out.push(i);"),
				maxAttempts: 1,
			}),
		});
		expect(run.attempts[0]).toMatchObject({ taskId: "range-off-by-one", finalState: "passed", holdoutPassed: true });
		expect(run.metrics.falseCompletionRate).toBe(0);
	});

	it("counts a special-cased fix as a false completion", async () => {
		const gamed = "\tif (start === 0 && end === 3) return [0, 1, 2]; for (let i = start; i <= end; i++) out.push(i);";
		const run = await runSuite({
			suite: rangeOnly,
			config,
			runner: createMissionRunner({ makeAi: scriptedAi(gamed), maxAttempts: 1 }),
		});
		expect(run.attempts[0]).toMatchObject({ finalState: "passed", holdoutPassed: false });
		expect(computeMetrics(run.attempts).falseCompletionRate).toBe(1);
		expect(run.metrics.bestAtK).toBe(0);
	});
});

describe("Terminal-Bench adapter", () => {
	it("maps task.yaml to a task whose success is entirely holdout", () => {
		const root = mkdtempSync(join(tmpdir(), "bedrock-tb-"));
		dirs.push(root);
		mkdirSync(join(root, "fix-nginx"));
		writeFileSync(
			join(root, "fix-nginx", "task.yaml"),
			"instruction: |\n  Make nginx serve /app on port 8080.\ndifficulty: medium\ncategory: system-administration\ntags: [nginx]\n",
		);
		writeFileSync(join(root, "fix-nginx", "run-tests.sh"), "pytest\n");
		mkdirSync(join(root, "not-a-task"));
		const tasks = loadTerminalBenchTasks(root);
		expect(tasks).toHaveLength(1);
		expect(tasks[0]).toMatchObject({
			id: "fix-nginx",
			goal: "Make nginx serve /app on port 8080.",
			gate: ["true"],
			tags: ["medium", "system-administration", "nginx"],
		});
		expect(tasks[0].holdout?.[0]).toContain("run-tests.sh");
		expect(loadTerminalBenchTasks(root, { tags: ["security"] })).toHaveLength(0);
	});
});
