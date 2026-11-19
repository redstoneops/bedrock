// @bedrock/context: content-addressed artifact store and output truncation.
//
// Large outputs never enter the prompt whole. They are stored as artifacts and
// replaced with a head, a tail and an explicit note telling the reader how to
// query the rest. This is the difference between a 50 MB test log and a usable
// turn.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Id } from "@bedrock/protocol";

export interface TruncationOptions {
	maxLines?: number;
	maxBytes?: number;
	/** Lines kept from the start and end of the output. */
	headLines?: number;
	tailLines?: number;
}

export interface Truncated {
	text: string;
	truncated: boolean;
	head: string;
	tail: string;
	bytes: number;
	lines: number;
	omittedLines: number;
}

/**
 * Keeps the head and tail of a large output and states plainly what was dropped
 * and how to get it. Deterministic: the same input yields the same note.
 */
export function truncateOutput(output: string, options: TruncationOptions = {}): Truncated {
	const maxBytes = options.maxBytes ?? 32 * 1024;
	const maxLines = options.maxLines ?? 400;
	const headLines = options.headLines ?? Math.ceil(maxLines / 2);
	const tailLines = options.tailLines ?? Math.floor(maxLines / 2);
	const bytes = Buffer.byteLength(output, "utf8");
	const lines = output.split("\n");
	const tooBig = bytes > maxBytes || lines.length > maxLines;
	if (!tooBig) {
		return {
			text: output,
			truncated: false,
			head: output,
			tail: output,
			bytes,
			lines: lines.length,
			omittedLines: 0,
		};
	}
	const head = lines.slice(0, headLines).join("\n");
	const tail = lines.slice(-tailLines).join("\n");
	const omittedLines = Math.max(0, lines.length - headLines - tailLines);
	const note = `\n... [${omittedLines} lines / ${bytes} bytes omitted; full output stored as an artifact. Query it with grep or the read tool instead of re-running the command.] ...\n`;
	return { text: `${head}${note}${tail}`, truncated: true, head, tail, bytes, lines: lines.length, omittedLines };
}

export type ArtifactSink = { kind: "file"; root: string } | { kind: "memory" };

export interface StoredArtifact {
	id: Id<"artifact">;
	/** Path relative to the store root (file sinks) or the key (memory sinks). */
	path: string;
	bytes: number;
	mime: string;
	hash: string;
}

/**
 * Stores artifacts by content hash so running the same command twice does not
 * duplicate a log, and the same evidence always has the same handle.
 */
export class ArtifactStore {
	readonly sink: ArtifactSink;
	#memory = new Map<string, string>();

	constructor(sink: ArtifactSink) {
		this.sink = sink;
		if (sink.kind === "file") mkdirSync(sink.root, { recursive: true });
	}

	put(content: string, mime = "text/plain"): StoredArtifact {
		const bytes = Buffer.byteLength(content, "utf8");
		const hash = createHash("sha256").update(content).digest("hex");
		const id = `art_${hash.slice(0, 32)}` as Id<"artifact">;
		const extension = mime === "application/json" ? "json" : mime.startsWith("text/") ? "txt" : "bin";
		const path = `${hash.slice(0, 2)}/${hash}.${extension}`;
		if (this.sink.kind === "memory") {
			this.#memory.set(hash, content);
		} else {
			const absolute = join(this.sink.root, path);
			if (!existsSync(absolute)) {
				mkdirSync(join(this.sink.root, hash.slice(0, 2)), { recursive: true });
				writeFileSync(absolute, content, "utf8");
			}
		}
		return { id, path, bytes, mime, hash };
	}

	get(hash: string): string | undefined {
		if (this.sink.kind === "memory") return this.#memory.get(hash);
		const absolute = join(this.sink.root, hash.slice(0, 2), `${hash}.txt`);
		const json = join(this.sink.root, hash.slice(0, 2), `${hash}.json`);
		if (existsSync(absolute)) return readFileSync(absolute, "utf8");
		if (existsSync(json)) return readFileSync(json, "utf8");
		const bin = join(this.sink.root, hash.slice(0, 2), `${hash}.bin`);
		return existsSync(bin) ? readFileSync(bin, "utf8") : undefined;
	}
}
