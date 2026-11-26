# 0011 — Separate web research from shell network access

Status: accepted (2026-11-26)

## Context

An agent needs public API documentation, but allowing `curl` or enabling general network access
also lets arbitrary code connect to hosts or send project data without visibility.

## Decision

Ship two opt-in host-side tools: search calls only Brave's fixed HTTPS endpoint, and fetch
requires an explicit, exact host allowlist. The transport pins a public IPv4 DNS answer for
the TLS request, checks the original hostname, rejects mixed/private answers and redirects,
and caps the body at 256 KiB and the request at 12 seconds. The shell sandbox is unchanged.
Strict mode does not auto-approve host-side web calls.

## Alternatives considered

- Shell networking gives flexibility but integrates poorly with permissions and source tracking.
- A headless browser covers JavaScript-heavy sites, but grants more capability than needed for
  text documentation and carries larger dependency and isolation costs.

## Consequences

Users can query public documentation and inspect source URLs, but need a Brave API key for search.
Fetch returns source without executing JavaScript and does not support redirects, IPv6-only
sites, compressed or binary responses, proxies, or custom headers supplied by the agent.
