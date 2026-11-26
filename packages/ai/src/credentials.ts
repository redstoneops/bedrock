// @bedrock/ai: a file-backed credential store for provider logins.
//
// Credentials (API keys and OAuth tokens) live in one JSON file, by default
// `~/.bedrock/auth.json`, written atomically with mode 0600. Writes are
// serialized across processes so token refresh and login cannot interleave.

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";

/** Default location of the credential file. `BEDROCK_HOME` overrides `~/.bedrock`. */
export function defaultAuthPath(): string {
	return join(resolve(process.env.BEDROCK_HOME ?? join(homedir(), ".bedrock")), "auth.json");
}

export class FileCredentialStore implements CredentialStore {
	readonly path: string;

	constructor(path = defaultAuthPath()) {
		this.path = resolve(path);
	}

	#readAll(): Record<string, Credential> {
		try {
			const parsed = JSON.parse(readFileSync(this.path, "utf8")) as {
				version: unknown;
				credentials: Record<string, Credential>;
			};
			if (
				parsed.version !== 1 ||
				!parsed.credentials ||
				typeof parsed.credentials !== "object" ||
				Array.isArray(parsed.credentials)
			)
				throw new Error("invalid credential file");
			const result: Record<string, Credential> = Object.create(null);
			for (const [id, credential] of Object.entries(parsed.credentials)) {
				if (
					credential?.type === "oauth" &&
					typeof credential.access === "string" &&
					typeof credential.refresh === "string" &&
					Number.isFinite(credential.expires)
				) {
					result[id] = credential;
				} else if (
					credential?.type === "api_key" &&
					(credential.key === undefined || typeof credential.key === "string")
				) {
					result[id] = credential;
				} else {
					throw new Error("invalid credential entry");
				}
			}
			return result;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return Object.create(null);
			throw new Error(`cannot read credentials at ${this.path}; check permissions and file format`);
		}
	}

	#writeAll(credentials: Record<string, Credential>): void {
		const temporary = join(`${this.path}.lock`, `${randomUUID()}.tmp`);
		try {
			writeFileSync(temporary, `${JSON.stringify({ version: 1, credentials }, null, 2)}\n`, {
				mode: 0o600,
				flag: "wx",
			});
			renameSync(temporary, this.path);
		} finally {
			rmSync(temporary, { force: true });
		}
	}

	async #locked<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
		const lock = `${this.path}.lock`;
		mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
		const deadline = Date.now() + 15_000;
		while (true) {
			signal?.throwIfAborted();
			try {
				mkdirSync(lock, { mode: 0o700 });
				break;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				if (Date.now() >= deadline) throw new Error(`credential store is busy: ${lock}`);
				await setTimeout(50, undefined, { signal });
			}
		}
		try {
			return await task();
		} finally {
			rmdirSync(lock);
		}
	}

	async read(providerId: string): Promise<Credential | undefined> {
		return this.#readAll()[providerId];
	}

	async list(): Promise<readonly CredentialInfo[]> {
		return Object.entries(this.#readAll()).map(([providerId, credential]) => ({ providerId, type: credential.type }));
	}

	modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		options?: AuthOperationOptions,
	): Promise<Credential | undefined> {
		return this.#locked(async () => {
			const all = this.#readAll();
			const next = await fn(all[providerId]);
			if (next === undefined) return all[providerId];
			all[providerId] = next;
			this.#writeAll(all);
			return next;
		}, options?.signal);
	}

	delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
		return this.#locked(async () => {
			const all = this.#readAll();
			if (!(providerId in all)) return;
			delete all[providerId];
			this.#writeAll(all);
		}, options?.signal);
	}
}
