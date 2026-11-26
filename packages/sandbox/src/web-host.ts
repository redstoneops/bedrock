import { isIP } from "node:net";

/** Normalizes a DNS hostname from a user-supplied web allowlist or a parsed URL. */
export function validateWebHost(host: string): string {
	const normalized = host.toLowerCase();
	if (
		normalized.length > 253 ||
		!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(normalized) ||
		isIP(normalized)
	)
		throw new Error("expected a DNS host such as docs.example.com (no scheme, path, wildcard, or IP address)");
	return normalized;
}
