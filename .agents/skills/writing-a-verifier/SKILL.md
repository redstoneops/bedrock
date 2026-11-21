---
name: writing-a-verifier
description: Add or change a verification layer, selection strategy or final-state rule. Load before touching packages/verify or the Verifier/SelectionStrategy interfaces.
---

# Verifiers

Interface (`packages/protocol/src/interfaces.ts`):

```ts
interface Verifier {
  readonly level: 0 | 1 | 2 | 3 | 4;
  readonly name: string;
  applies(candidate: CandidateView, gate: Gate): boolean;
  verify(candidate: CandidateView, gate: Gate, context?: VerifyContext): Promise<GateResult>;
}
```

1. Implement it in `packages/verify/src/stack.ts` (or a new file exported from `index.ts`).
2. Return a full `GateResult`; start from `runGateAsync` with the checks you need (empty for model-only
   layers) so tree hash and integrity are filled.
3. A model-based layer may **block** (set `passed: false`, add a critical suspicion) but must never turn a
   failing gate into a pass. Unparseable model output means "unverified", not "passed".
4. Add it to `defaultVerifiers` only if it is cheap or gated by an option; `verifyStack` sorts by level.
5. Tests in `packages/verify/test/verify.test.ts` with a faux provider for model layers.

Final state lives in `selection.ts#computeFinalState`; it reads gate results only. Changing it changes what
"passed" means for every user: write an ADR.
