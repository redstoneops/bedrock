// @bedrock/sandbox: the append-only audit log.

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { AuditRecord } from "@bedrock/protocol";

export interface AuditSink {
	record(record: AuditRecord): void;
}

/** Writes one JSON line per record to a file, creating parent directories. */
export class FileAuditLog implements AuditSink {
	readonly path: string;

	constructor(path: string) {
		this.path = path;
	}

	record(record: AuditRecord): void {
		mkdirSync(dirname(this.path), { recursive: true });
		appendFileSync(this.path, `${JSON.stringify(record)}\n`, "utf8");
	}
}

/** In-memory sink for tests and for surfaces that render the log live. */
export class MemoryAuditLog implements AuditSink {
	readonly records: AuditRecord[] = [];

	record(record: AuditRecord): void {
		this.records.push(record);
	}

	/** Records for one tool, newest first. */
	byTool(tool: string): AuditRecord[] {
		return this.records.filter((record) => record.tool === tool).reverse();
	}
}

/** Discards records; used when auditing is explicitly disabled. */
export class NullAuditLog implements AuditSink {
	record(_record: AuditRecord): void {}
}
