// Host-side HTTPS transport. A vetted IPv4 address is pinned for each TLS request.

import { Resolver } from "node:dns/promises";
import { request } from "node:https";
import { BlockList, isIP } from "node:net";
import { validateWebHost } from "@bedrock/sandbox";

const NON_PUBLIC = new BlockList();
for (const [address, prefix] of [
	["0.0.0.0", 8],
	["10.0.0.0", 8],
	["100.64.0.0", 10],
	["127.0.0.0", 8],
	["168.63.129.16", 32],
	["169.254.0.0", 16],
	["172.16.0.0", 12],
	["192.0.0.0", 24],
	["192.0.2.0", 24],
	["192.88.99.0", 24],
	["192.168.0.0", 16],
	["198.18.0.0", 15],
	["198.51.100.0", 24],
	["203.0.113.0", 24],
	["224.0.0.0", 3],
] as const)
	NON_PUBLIC.addSubnet(address, prefix, "ipv4");

export const WEB_MAX_BYTES = 256 * 1024;

export interface WebResponse {
	status: number;
	contentType: string;
	body: string;
}

export type WebRequest = (url: URL, headers: Record<string, string>, signal?: AbortSignal) => Promise<WebResponse>;

export function publicWebUrl(input: string): URL {
	const url = new URL(input);
	if (url.protocol !== "https:" || url.username || url.password || url.port)
		throw new Error("use an HTTPS URL without credentials or a custom port");
	validateWebHost(url.hostname);
	url.hash = "";
	return url;
}

export function publicAddress(addresses: readonly string[]): string {
	if (!addresses.length || addresses.some((address) => isIP(address) !== 4 || NON_PUBLIC.check(address, "ipv4")))
		throw new Error("host does not resolve exclusively to public IPv4 addresses");
	return addresses[0];
}

export const requestPublicWeb: WebRequest = async (url, headers, externalSignal) => {
	const target = publicWebUrl(url.href);
	const timeout = AbortSignal.timeout(12_000);
	const signal = externalSignal ? AbortSignal.any([externalSignal, timeout]) : timeout;
	signal.throwIfAborted();
	const resolver = new Resolver();
	const cancel = () => resolver.cancel();
	signal.addEventListener("abort", cancel, { once: true });
	let address: string;
	try {
		address = publicAddress(await resolver.resolve4(target.hostname));
	} finally {
		signal.removeEventListener("abort", cancel);
	}
	signal.throwIfAborted();

	return new Promise((resolve, reject) => {
		const req = request(
			{
				hostname: address,
				servername: target.hostname,
				path: `${target.pathname}${target.search}`,
				method: "GET",
				rejectUnauthorized: true,
				agent: false,
				headers: { ...headers, host: target.hostname, "accept-encoding": "identity" },
				signal,
			},
			(response) => {
				response.on("error", reject);
				const status = response.statusCode ?? 0;
				const contentType = (response.headers["content-type"] ?? "").toLowerCase();
				if (status < 200 || status >= 300) {
					response.destroy();
					resolve({ status, contentType, body: "" });
					return;
				}
				const encoding = response.headers["content-encoding"];
				if (encoding && encoding !== "identity") {
					reject(new Error("compressed responses are not supported"));
					response.destroy();
					return;
				}
				const chunks: Buffer[] = [];
				let bytes = 0;
				response.on("data", (chunk: Buffer) => {
					bytes += chunk.length;
					if (bytes > WEB_MAX_BYTES) {
						reject(new Error("response exceeds 256 KiB"));
						response.destroy();
						return;
					}
					chunks.push(chunk);
				});
				response.on("end", () => resolve({ status, contentType, body: Buffer.concat(chunks).toString("utf8") }));
			},
		);
		req.on("error", reject);
		req.end();
	});
};
