// @bedrock/protocol: shared domain types and event schema for enums and ids.

export const BEDROCK_VERSION = "0.1.0";

/** Stable, prefixed identifiers. The prefix makes logs and ledgers self-describing. */
export const ID_KINDS = [
	"mission",
	"session",
	"gate",
	"check",
	"worker",
	"strategy",
	"entry",
	"evidence",
	"candidate",
	"checkpoint",
	"artifact",
	"playbook",
] as const;

export type IdKind = (typeof ID_KINDS)[number];

/** A prefixed identifier such as `mission_018f...`. */
export type Id<K extends IdKind = IdKind> = `${K}_${string}`;

/** ISO-8601 timestamp with millisecond precision, e.g. `2026-11-19T18:00:00.000Z`. */
export type Timestamp = string;

const ID_PREFIX: Record<IdKind, string> = {
	mission: "mis",
	session: "ses",
	gate: "gat",
	check: "chk",
	worker: "wrk",
	strategy: "str",
	entry: "led",
	evidence: "evd",
	candidate: "cnd",
	checkpoint: "ckp",
	artifact: "art",
	playbook: "pbk",
};

/**
 * Creates a prefixed id. The suffix is random so ids never collide across
 * processes; ordering is carried by `Timestamp`, not by the id.
 */
export function createId<K extends IdKind>(kind: K): Id<K> {
	return `${ID_PREFIX[kind]}_${crypto.randomUUID().replaceAll("-", "")}` as Id<K>;
}

/** True when `value` is a well-formed id of any kind. */
export function isId(value: string): value is Id {
	return /^[a-z]{3}_[0-9a-f]{32}$/.test(value);
}

export function isIdOf<K extends IdKind>(value: string, kind: K): value is Id<K> {
	return value.startsWith(`${ID_PREFIX[kind]}_`) && isId(value);
}

/** Extracts the kind of a well-formed id, or `undefined`. */
export function idKind(value: string): IdKind | undefined {
	if (!isId(value)) return undefined;
	const prefix = value.slice(0, value.indexOf("_"));
	return ID_KINDS.find((kind) => ID_PREFIX[kind] === prefix);
}

/** Short, log-friendly rendering of an id (`mis_1a2b3c4d`). */
export function shortId(value: string): string {
	const underscore = value.indexOf("_");
	if (underscore < 0) return value.slice(0, 12);
	return `${value.slice(0, underscore)}_${value.slice(underscore + 1, underscore + 9)}`;
}
