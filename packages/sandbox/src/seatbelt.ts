// @bedrock/sandbox: filesystem and network sandbox policy, and the Seatbelt profile that enforces it.
//
// The macOS policy is adapted from OpenAI Codex (Apache-2.0), codex-rs/sandboxing/src/
// seatbelt_base_policy.sbpl and seatbelt.rs. Our version is parameterized: writable roots,
// read roots and network mode are passed with `-D` parameters instead of being generated
// per-path, so the policy text is stable and testable.

import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type FilesystemAccess = "read_only" | "workspace_write" | "danger_full_access";
export type NetworkAccess = "none" | "allowlist" | "all";

export interface SandboxPolicy {
	filesystem: FilesystemAccess;
	network: NetworkAccess;
	/** Roots writable in `workspace_write` mode. The workspace is always included. */
	writableRoots: string[];
	/** Paths that stay read-only even inside writable roots (e.g. `.git`, gate files). */
	protectedPaths: string[];
	/** Hosts allowed in `allowlist` network mode. */
	allowedHosts: string[];
}

export const SEATBELT_EXECUTABLE = "/usr/bin/sandbox-exec";

/**
 * The stable part of the Seatbelt profile. `deny default` first, then just enough
 * process, device and sysctl access for compilers and test runners to work.
 * Adapted from Codex's base policy; keep changes to the minimum that unbreaks tools.
 */
export const SEATBELT_BASE_POLICY = `(version 1)
(deny default)

(allow process-exec)
(allow process-fork)
(allow signal (target same-sandbox))
(allow process-info* (target same-sandbox))
(allow pseudo-tty)
(allow ipc-posix-sem)

; Reads are allowed everywhere, as in Codex's workspace-write mode: toolchains
; live under the home directory and worktrees read their gitdir and shared
; dependency directories. Secret files are kept from the model by the
; permission policy, and writes are what the profile actually restricts.
(allow file-read*)

(allow file-read* file-test-existence
  (subpath "/System/Library")
  (subpath "/Library/Apple")
  (subpath "/Library/Filesystems")
  (subpath "/usr/lib")
  (subpath "/usr/share")
  (subpath "/usr/bin")
  (subpath "/usr/sbin")
  (subpath "/bin")
  (subpath "/sbin")
  (subpath "/opt/homebrew")
  (subpath "/usr/local")
  (subpath "/private/etc")
  (subpath "/etc")
  (literal "/")
  (literal "/dev/null")
  (literal "/dev/zero")
  (literal "/dev/random")
  (literal "/dev/urandom")
  (literal "/dev/tty")
  (literal "/dev/dtracehelper")
  (regex #"^/dev/fd/")
  (regex #"^/dev/ttys[0-9]+$")
  (subpath "/private/var/db"))

(allow file-read-metadata (subpath "/var") (subpath "/private/var") (subpath "/tmp") (subpath "/private/tmp"))
(allow file-read* (subpath "/dev"))
(allow file-write* (literal "/dev/null") (literal "/dev/tty") (literal "/dev/stdout") (literal "/dev/stderr"))
(allow file-write* (regex #"^/dev/fd/(1|2)$"))
(allow file-ioctl (regex #"^/dev/ttys[0-9]+$"))
(allow file-ioctl (literal "/dev/ptmx"))
(allow file-read* file-write* (literal "/dev/ptmx"))

(allow mach-lookup
  (global-name "com.apple.system.opendirectoryd.libinfo")
  (global-name "com.apple.system.opendirectoryd.membership")
  (global-name "com.apple.system.logger")
  (global-name "com.apple.system.notification_center")
  (global-name "com.apple.SecurityServer")
  (global-name "com.apple.trustd")
  (global-name "com.apple.trustd.agent")
  (global-name "com.apple.SystemConfiguration.DNSConfiguration")
  (global-name "com.apple.SystemConfiguration.configd")
  (global-name "com.apple.logd")
  (global-name "com.apple.bsd.dirhelper"))

(allow iokit-open (iokit-registry-entry-class "RootDomainUserClient"))
(allow sysctl-read)
(allow system-mac-syscall (mac-policy-name "vnguard"))
(allow file-read* file-write* (extension "com.apple.app-sandbox.read-write"))
(allow file-read* (extension "com.apple.app-sandbox.read"))
`;

/** Read-only enforcement: everything readable, writes denied except the base device list. */
export const SEATBELT_READ_ONLY_POLICY = `(deny file-write*)
(allow file-write* (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr") (literal "/dev/tty"))
(allow file-write* (regex #"^/dev/fd/(1|2)$"))
`;

export interface SeatbeltProfile {
	/** `-D` parameter values, passed as `-DKEY=value`. */
	params: Record<string, string>;
	profile: string;
}

/**
 * Builds a Seatbelt profile plus its parameters for the given policy. In
 * `workspace_write` mode every writable root is a `(subpath (param "WRITE_n"))`
 * clause; protected paths add a nested deny so a worker cannot rewrite its own
 * gate material or `.git` internals.
 */
export function seatbeltProfile(policy: SandboxPolicy): SeatbeltProfile {
	const params: Record<string, string> = {};
	if (policy.filesystem === "danger_full_access") {
		return { params, profile: "(version 1)\n(allow default)\n" };
	}

	let profile = SEATBELT_BASE_POLICY;
	if (policy.filesystem === "read_only") {
		profile += SEATBELT_READ_ONLY_POLICY;
	} else {
		policy.writableRoots.forEach((root, index) => {
			params[`WRITE_${index}`] = root;
			profile +=
				`(allow file-write* file-read* file-test-existence (subpath (param "WRITE_${index}")))\n` +
				`(allow file-write-unlink (subpath (param "WRITE_${index}")))\n`;
		});
		policy.protectedPaths.forEach((path, index) => {
			params[`PROTECT_${index}`] = path;
			profile += `(deny file-write* (subpath (param "PROTECT_${index}")))\n`;
			profile += `(deny file-write-unlink (require-all (subpath (param "PROTECT_${index}")) (vnode-type DIRECTORY)))\n`;
		});
	}

	if (policy.network === "none") {
		profile += "(deny network*)\n";
	}
	// `allowlist` is enforced by the network proxy, not by Seatbelt: Seatbelt cannot
	// match hostnames. The proxy runs in-process and refuses unlisted hosts.
	return { params, profile };
}

/** True when the platform can actually enforce a Seatbelt policy right now. */
export function seatbeltAvailable(): boolean {
	return process.platform === "darwin" && existsSync(SEATBELT_EXECUTABLE);
}

export interface SandboxCommand {
	command: string;
	args: string[];
	/** Absolute path used as the process cwd. */
	cwd: string;
}

/** Wraps a shell command in `sandbox-exec` for macOS. Returns null when unavailable. */
export function wrapWithSeatbelt(
	command: string,
	shell: string,
	policy: SandboxPolicy,
	cwd = process.cwd(),
): SandboxCommand | null {
	if (!seatbeltAvailable()) return null;
	const { params, profile } = seatbeltProfile(policy);
	const args: string[] = [];
	for (const [key, value] of Object.entries(params)) {
		args.push("-D", `${key}=${value}`);
	}
	args.push("-p", profile, "--", shell, "-lc", command);
	return { command: SEATBELT_EXECUTABLE, args, cwd };
}

/**
 * Builds the `docker run` argument list for container isolation. The container is
 * the only sandbox that covers network, filesystem and process limits consistently
 * across platforms, so autonomous mode defaults to it when Docker is available.
 */
export function containerArgs(options: {
	image: string;
	workspace: string;
	hostWorkspace: string;
	network: NetworkAccess;
	env?: Record<string, string>;
	name?: string;
}): string[] {
	const args = ["run", "--rm", "-i"];
	if (options.name) args.push("--name", options.name);
	args.push("--network", options.network === "none" ? "none" : "bridge");
	args.push("-v", `${options.hostWorkspace}:${options.workspace}`);
	args.push("-w", options.workspace);
	for (const [key, value] of Object.entries(options.env ?? {})) args.push("-e", `${key}=${value}`);
	args.push(options.image);
	return args;
}

/** Temporary directories test runners and compilers expect to write to. */
function tempRoots(): string[] {
	const roots = [tmpdir(), "/tmp", "/private/tmp"];
	const resolved: string[] = [];
	for (const root of roots) {
		resolved.push(root);
		try {
			resolved.push(realpathSync(root));
		} catch {
			// A missing temp root is simply not writable.
		}
	}
	return resolved;
}

/** Default workspace-write policy for a mission running in `workspace`. */
export function workspacePolicy(workspace: string, extra: Partial<SandboxPolicy> = {}): SandboxPolicy {
	return {
		filesystem: "workspace_write",
		network: "none",
		writableRoots: [workspace, join(workspace, ".bedrock"), ...tempRoots()].filter(
			(path, index, all) => all.indexOf(path) === index,
		),
		protectedPaths: [join(workspace, ".git"), join(workspace, ".bedrock", "gate")],
		allowedHosts: [],
		...extra,
	};
}
