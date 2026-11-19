# 0004 — One product spec from two drafts; functional package names

Status: accepted (2026-11-19)

## Context

Bedrock was specified in two documents that overlap and disagree in places:

- Draft A ("Bedrock — PRD") is research-heavy: kernel/RLM, ledger, budget controller, playbook,
  daemon, meta-harness, Mission Control TUI, and a 16-package layout with functional names
  (`gate`, `verify`, `ledger`, `context`, ...).
- Draft B ("Product requirements & build instructions") is component-heavy: Recipe/Observer/
  Comparator/Repeater/Anvil, test-time-compute tiers 0–3, sandbox and injection defense,
  ImpossibleBench cheat-rate evaluation, and Minecraft codenames for components.

Both agree on the core premise (verification first, evidence over assertion, context outside the
transcript, adaptive compute, durability, guarded self-improvement, excellent TUI). They disagree on
runtime (Bun vs Node, resolved in ADR-0002), package names, and some vocabulary.

## Decision

1. **One consolidated spec** in `PRD.md`, with both original drafts preserved verbatim in
   `docs/prd/draft-a.md` and `docs/prd/draft-b.md` for traceability. Where they conflict, `PRD.md`
   states the resolution and this ADR explains it.
2. **Functional package names**, one component per package (Draft A's layout), because packages are
   what agents grep and import; playful names do not survive `rg @bedrock/observer`.
3. **Component codenames survive as vocabulary** in docs and class names where they aid recall:
   Recipe → `@bedrock/gate`, Crafter/Repeater/Pistons → `@bedrock/core`, Observer/Comparator →
   `@bedrock/verify`, Chest/Bookshelf → `@bedrock/memory`, Hopper → `@bedrock/context`,
   Obsidian → `@bedrock/sandbox`, Beacon/Anvil → `@bedrock/lab`.
4. **Both models of compute scaling are kept**, reconciled: Draft B's tiers are the *strategy* layer
   (`single`, `best_of_n`, `tree_search`, `evolutionary`), Draft A's budget actions are the *control*
   layer that moves between them (`continue`, `widen`, `branch`, `escalate`, ...). A `BudgetPolicy`
   returns actions; the mission loop maps actions to tiers.
5. **Verification levels from Draft A (L0–L4)** are the implementation detail; Draft B's
   Observer/Comparator vocabulary names the roles that run them.

## Alternatives considered

- Keep two specs. Rejected: agents would implement contradictory behavior.
- Adopt codenames as package names. Rejected for grep-ability and import ergonomics.
- Adopt tiers as the only control model. Rejected: tiers alone cannot express "escalate the model"
  or "ask the human", which long runs need.

## Consequences

- `docs/architecture.md` carries the codename mapping; `PRD.md` is the single source of truth.
- New components get functional names; a codename may be used in prose only if it adds clarity.
- The lab can evolve `BudgetPolicy` without changing package boundaries.
