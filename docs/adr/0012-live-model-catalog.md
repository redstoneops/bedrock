# 0012 — Discover models from the connected provider

Status: accepted (2026-11-26)

## Context

The bundled catalog can lag provider releases and includes entries an individual account cannot
list. Adding an ID to a UI picker alone also leaves routing unable to resolve the new model.

## Decision

Refresh configured providers using pi-ai's model refresh lifecycle and auth mechanisms. Where
pi-ai lacks a refresh hook, add adapters to allowlisted provider catalog endpoints. Publish the
fresh candidate list into the same `Models` collection used by request routing. Keep metadata
for bundled IDs only when the freshly listed ID matches exactly.

## Alternatives considered

- Updating the bundled dependencies regularly still misses releases and account-specific lists.
- A shared metadata feed can be useful, but is not evidence of an account's access and should
  not receive provider credentials.

## Consequences

Catalog calls are time bounded; failed or unsupported discovery uses the bundled catalog.
The successful list represents provider visibility, not a guarantee every listed model handles
tools or that API quotas allow a call. New IDs can lack verified pricing and capability metadata.
