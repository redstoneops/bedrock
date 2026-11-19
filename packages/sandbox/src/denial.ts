// @bedrock/sandbox: detecting when the OS sandbox (not the code) blocked something.

import type { SandboxDenial } from "@bedrock/protocol";

/** Signatures produced by an enforced sandbox when a write, exec or network call is refused. */
const SIGNATURES: Array<{ signal: string; pattern: RegExp; detail: string }> = [
	{
		signal: "seatbelt",
		pattern: /sandbox-exec: sandbox_apply|deny file-write|Operation not permitted.*sandbox/i,
		detail: "macOS Seatbelt denied the operation",
	},
	{
		signal: "landlock",
		pattern: /landlock|Permission denied.*landlock/i,
		detail: "Linux Landlock denied the operation",
	},
	{
		signal: "seccomp",
		pattern: /seccomp.*(denied|blocked)|Operation not permitted.*seccomp/i,
		detail: "seccomp denied the syscall",
	},
	{ signal: "bwrap", pattern: /bwrap:|bubblewrap/i, detail: "bubblewrap denied the operation" },
	{
		signal: "docker-network",
		pattern: /Could not resolve host|Temporary failure in name resolution|Network is unreachable/,
		detail: "network access was blocked",
	},
	{ signal: "readonly-fs", pattern: /Read-only file system|EROFS/, detail: "filesystem is read-only in this sandbox" },
];

/**
 * Inspects a failed command's output. A denial is a reason to ask the human to
 * widen the policy, not a reason to retry the same command.
 */
export function detectSandboxDenial(exitCode: number, output: string): SandboxDenial {
	if (exitCode === 0) return { detected: false };
	for (const signature of SIGNATURES) {
		if (signature.pattern.test(output)) {
			return { detected: true, signal: signature.signal, detail: signature.detail };
		}
	}
	return { detected: false };
}
