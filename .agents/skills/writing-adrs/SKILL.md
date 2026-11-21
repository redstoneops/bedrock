---
name: writing-adrs
description: When and how to record an architecture decision in docs/adr. Load when a change picks between real alternatives or changes a default users depend on.
---

# Writing ADRs

Write one when you choose between real alternatives, change a default (models, isolation, final-state rules,
edit format), add a dependency or a fork, or deviate from the PRD.

1. Copy `docs/adr/0000-template.md` to the next number: `docs/adr/NNNN-kebab-title.md`.
2. Sections: Context (the problem, with a concrete example), Decision, Alternatives considered (why each
   lost), Consequences (what gets harder, when to revisit).
3. Keep it under a page. Link it from the commit body (`Refs: docs/adr/NNNN-...`) and from the doc it affects.
4. Superseding: set the old ADR's status to `superseded by NNNN`; never delete it.
