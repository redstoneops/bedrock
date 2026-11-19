// @bedrock/sandbox: keeping secrets out of logs, ledgers and prompts.

/** Redacts credential-shaped strings while keeping enough context to debug. */
const RULES: Array<{ name: string; pattern: RegExp; replace: (match: string, ...groups: string[]) => string }> = [
	// Provider API keys with known prefixes.
	{
		name: "anthropic",
		pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}/g,
		replace: (match) => `sk-ant-***${match.slice(-4)}`,
	},
	{ name: "openai", pattern: /\bsk-(?!ant-)[A-Za-z0-9_-]{16,}/g, replace: (match) => `sk-***${match.slice(-4)}` },
	{ name: "github", pattern: /\b(gh[pousr]_[A-Za-z0-9]{20,})/g, replace: (match) => `gh_***${match.slice(-4)}` },
	{
		name: "aws",
		pattern: /\b(AKIA|ASIA)[A-Z0-9]{16}\b/g,
		replace: (match) => `${match.slice(0, 4)}***${match.slice(-4)}`,
	},
	{ name: "google", pattern: /\bAIza[0-9A-Za-z_-]{30,}/g, replace: (match) => `AIza***${match.slice(-4)}` },
	{ name: "slack", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, replace: (match) => `xox*-***${match.slice(-4)}` },
	{
		name: "jwt",
		pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
		replace: () => "eyJ***.eyJ***.***",
	},
	{
		name: "private-key",
		pattern:
			/-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g,
		replace: () => "-----BEGIN PRIVATE KEY-----***-----END PRIVATE KEY-----",
	},
	// `NAME=value` / `NAME: value` where the name looks secret.
	{
		name: "assignment",
		pattern:
			/\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|APIKEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIAL)[A-Z0-9_]*)\s*[:=]\s*["']?([^\s"',]{6,})["']?/gi,
		replace: (match, name: string) => `${name}=***`,
	},
	// Authorization headers.
	{
		name: "bearer",
		pattern: /\b(Authorization:\s*(?:Bearer|Basic)\s+)[A-Za-z0-9._~+/=-]{8,}/gi,
		replace: (_match, prefix: string) => `${prefix}***`,
	},
];

export interface RedactionResult {
	text: string;
	/** Names of the rules that fired, for the audit log. */
	rules: string[];
}

/** Replaces secrets with safe placeholders and reports which rules fired. */
export function redact(text: string): RedactionResult {
	let output = text;
	const rules: string[] = [];
	for (const rule of RULES) {
		if (!rule.pattern.test(output)) {
			rule.pattern.lastIndex = 0;
			continue;
		}
		rule.pattern.lastIndex = 0;
		rules.push(rule.name);
		output = output.replace(rule.pattern, (match, ...groups: string[]) => rule.replace(match, ...groups));
	}
	return { text: output, rules };
}

/** True when `text` appears to contain a secret. Used to refuse writing it into the ledger. */
export function containsSecret(text: string): boolean {
	return redact(text).rules.length > 0;
}

/** Redacts the environment variables most likely to hold credentials, keeping names. */
export function redactEnv(env: Record<string, string>): Record<string, string> {
	const output: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		output[key] = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(key) ? "***" : value;
	}
	return output;
}
