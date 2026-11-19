#!/usr/bin/env node
// The bedrock launcher: runs the compiled CLI when present, otherwise the
// TypeScript source with the bedrock-source condition (ADR-0003).
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const built = join(here, "..", "dist", "main.js");
const source = join(here, "..", "src", "main.ts");

const args = existsSync(built)
	? [built, ...process.argv.slice(2)]
	: ["--conditions=bedrock-source", "--disable-warning=ExperimentalWarning", source, ...process.argv.slice(2)];
const result = spawnSync(process.execPath, args, { stdio: "inherit" });
process.exit(result.status ?? 1);
