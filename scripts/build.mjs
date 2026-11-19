// Builds publishable `dist/` output per package, or typechecks when emission is not ready.
//
// Development, tests and the CLI run from TypeScript source through the `bedrock-source`
// export condition (ADR-0003), so `dist/` is only needed for publishing.
// Until the per-package emission layout is settled (cross-package types must be published,
// not inlined), this script verifies the whole repo typechecks and reports the gap.

import { execFileSync } from "node:child_process";

execFileSync("npx", ["tsc", "--noEmit", "-p", "tsconfig.json"], { stdio: "inherit" });
console.log("typecheck ok; dist emission pending (see docs/adr/0003-run-from-source.md)");
