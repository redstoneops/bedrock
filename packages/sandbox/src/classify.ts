// @bedrock/sandbox: classifying shell commands before they run.
//
// A command is "safe" only when it is provably read-only. The classifier is
// deliberately conservative: unrecognized commands, redirections, command
// substitution and background jobs make a command unknown. An unknown command in
// `standard` mode asks; in autonomous mode it runs, but still inside the sandbox.

export type CommandClass = "read_only" | "writes_workspace" | "destructive" | "network" | "unknown";

export interface Classification {
	class: CommandClass;
	reason: string;
	/** The first word of every simple command in the pipeline, for logging. */
	programs: string[];
}

/** Programs that only read. Must not write files, network, or global state. */
const READ_ONLY = new Set([
	"ls",
	"cat",
	"head",
	"tail",
	"wc",
	"grep",
	"egrep",
	"rg",
	"fd",
	"find",
	"file",
	"stat",
	"du",
	"df",
	"tree",
	"pwd",
	"echo",
	"printf",
	"which",
	"type",
	"whoami",
	"id",
	"uname",
	"date",
	"cal",
	"env",
	"printenv",
	"sort",
	"uniq",
	"cut",
	"tr",
	"awk",
	"sed",
	"diff",
	"cmp",
	"comm",
	"jq",
	"yq",
	"bat",
	"less",
	"more",
	"realpath",
	"readlink",
	"basename",
	"dirname",
	"md5sum",
	"shasum",
	"sha256sum",
	"hexdump",
	"xxd",
	"strings",
	"nm",
	"objdump",
	"git",
	"node",
	"npm",
	"python",
	"python3",
	"tsc",
]);

/** Subcommands that make an otherwise-read-only program write. */
const WRITING_SUBCOMMANDS: Record<string, Set<string>> = {
	git: new Set([
		"add",
		"commit",
		"push",
		"pull",
		"fetch",
		"merge",
		"rebase",
		"reset",
		"checkout",
		"switch",
		"restore",
		"clean",
		"stash",
		"apply",
		"am",
		"cherry-pick",
		"revert",
		"tag",
		"branch",
		"init",
		"clone",
		"rm",
		"mv",
		"gc",
		"prune",
		"filter-branch",
		"update-ref",
		"worktree",
		"submodule",
	]),
	npm: new Set([
		"install",
		"i",
		"ci",
		"uninstall",
		"update",
		"publish",
		"link",
		"exec",
		"x",
		"run-script",
		"test",
		"start",
		"build",
		"run",
		"create",
		"init",
	]),
	node: new Set(["--eval", "-e", "--print", "-p"]),
	python: new Set(["-c"]),
	python3: new Set(["-c"]),
	tsc: new Set(["--build", "-b"]),
};

const DESTRUCTIVE = new Set([
	"rm",
	"rmdir",
	"mkfs",
	"dd",
	"shred",
	"truncate",
	"chmod",
	"chown",
	"chgrp",
	"kill",
	"pkill",
	"killall",
	"reboot",
	"shutdown",
]);
const NETWORK = new Set([
	"curl",
	"wget",
	"ssh",
	"scp",
	"sftp",
	"rsync",
	"nc",
	"netcat",
	"telnet",
	"ftp",
	"dig",
	"nslookup",
	"ping",
	"npx",
	"pip",
	"pip3",
	"brew",
	"apt",
	"apt-get",
]);

/**
 * Classifies a shell command. Detects the constructs that make per-program
 * classification unsound: chaining (`;`, `&&`, `||`), pipes are fine only if both
 * sides are read-only, redirections that write, subshells, and backgrounding.
 */
export function classifyCommand(command: string): Classification {
	const trimmed = command.trim();
	if (trimmed.length === 0) return { class: "unknown", reason: "empty command", programs: [] };

	const programs = extractPrograms(trimmed);
	const segments = splitSegments(trimmed);
	const classes: CommandClass[] = [];
	for (const segment of segments) {
		classes.push(classifySegment(segment));
	}

	// A command is only as safe as its most dangerous segment or operator.
	if (/\$\(|`/.test(trimmed)) {
		return { class: "unknown", reason: "command substitution hides the real effect", programs };
	}
	if (/>[^&]|>>|\btee\b/.test(trimmed)) {
		return { class: "writes_workspace", reason: "output redirection writes a file", programs };
	}
	if (/(^|[\s;])&(\s|$)/.test(trimmed)) {
		return { class: "unknown", reason: "background job", programs };
	}
	if (classes.includes("destructive")) return { class: "destructive", reason: "destructive program", programs };
	if (classes.includes("network")) return { class: "network", reason: "network program", programs };
	if (classes.includes("writes_workspace")) return { class: "writes_workspace", reason: "program writes", programs };
	if (classes.includes("unknown")) return { class: "unknown", reason: "unrecognized program or construct", programs };
	return { class: "read_only", reason: "all programs are read-only", programs };
}

function splitSegments(command: string): string[] {
	return command
		.split(/;|&&|\|\||\||\n/)
		.map((part) => part.trim())
		.filter((part) => part.length > 0);
}

function extractPrograms(command: string): string[] {
	return splitSegments(command)
		.map((segment) => firstWord(segment))
		.filter((word) => word.length > 0);
}

function firstWord(segment: string): string {
	const match = /^(?:[A-Z_][A-Z0-9_]*=\S+\s+)*([^\s]+)/i.exec(segment);
	if (!match) return "";
	return match[1].replace(/^["']|["']$/g, "");
}

function classifySegment(segment: string): CommandClass {
	const words = segment.split(/\s+/).filter((word) => word.length > 0);
	// Skip leading env assignments and wrappers.
	let index = 0;
	while (index < words.length && /^[A-Z_][A-Z0-9_]*=/.test(words[index])) index++;
	if (words[index] === "sudo" || words[index] === "doas") return "destructive";
	const program = words[index]?.replace(/^["']|["']$/g, "") ?? "";
	if (program.length === 0) return "unknown";
	if (DESTRUCTIVE.has(program)) return "destructive";
	if (NETWORK.has(program)) return "network";
	if (!READ_ONLY.has(program)) return "unknown";

	const subcommand = words[index + 1]?.replace(/^["']|["']$/g, "");
	const writers = WRITING_SUBCOMMANDS[program];
	if (writers && subcommand && writers.has(subcommand)) {
		// `git log`, `git status`, `git diff` are reads even though `git branch` is not.
		return "writes_workspace";
	}
	// A bare `find -delete` or `sed -i` writes.
	if (program === "find" && words.includes("-delete")) return "writes_workspace";
	if (program === "sed" && words.some((word) => word === "-i" || word.startsWith("-i"))) return "writes_workspace";
	if (program === "awk" && words.some((word) => word.includes("print >") || word.includes("system(")))
		return "writes_workspace";
	return "read_only";
}
