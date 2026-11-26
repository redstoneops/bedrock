# 0010 — Activate installed skills explicitly

Status: accepted (2026-11-26)

## Context

A workflow such as a test review should be reusable across projects. Installing an instructions
file should not, by itself, cause its contents to be sent to a provider or used by every worker.

## Decision

Install only a local Markdown document under the user's Bedrock home. Activation is explicit per
session or invocation. Inject bounded skill text as guidance while leaving the gate, sandbox, and
verification configuration untouched.

## Alternatives considered

- Automatically load all installed and project skills. Convenient, but increases prompt cost
  and gives unrelated or untrusted documents influence without explicit selection.
- Copy complete skill bundles. Enables portable scripts and references, but requires a separate
  trust and dependency model.

## Consequences

Users select skills when needed. Companion scripts, registries, and project-level skill discovery
are not supported by this local Markdown store.
