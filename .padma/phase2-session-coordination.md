# Current Phase 2 implementation ownership

This file is temporary coordination for scoped subagent work in this session; it is not runtime configuration or authority.

- Lead: compiler.ts, sandhana-compiler.test.ts, specification/foundation notes.
- Credentialless exact-command implementation: agent-session.ts, suite/sandhana-exact-no-auth.test.ts.
- Finalization freshness implementation: sandhana/kernel.ts, sandhana-finalization.test.ts.
- Routing validation implementation: sandhana/store.ts, optional sandhana/routing.ts, sandhana-routing-proof.test.ts, existing sandhana.test.ts.

## Exact command syntax API is ready

`parseExactCommand(instruction)` is now exported from `packages/coding-agent/src/core/sandhana/compiler.ts`. `compile()` calls the same parser. Return type is `CompiledCommand["exact"]`; recognition alone supplies no binding, registration or authority. Use the immutable original USER input to decide only whether inference auth preflight is needed. Preserve ordinary nonexact prompt auth rejection and all kernel policy checks. Do not introduce another grammar in AgentSession. A configured model with no provider credential must support deterministic exact commands; no-selected-model remains an explicit limitation unless safely resolved without another controller.

## Current kernel function ownership

The freshness implementation is done (14 new tests passed); its owner may run the existing acceptance/vitest/reporting regression now. Baseline pwsh-22 is collected. Please report handoff when done. Do not start other edits to unrelated kernel functions.

Shell owner 150df5ee-e603-4d5f-80ed-e337cb6c325f is assigned only exact registry eligibility, prepareOperation shell identity, amend shell revocation and native shell dispatch. It will FIRST add `kernel.isExactAdapterEligible(tool: "read" | "ls" | "status"): boolean`, using exactly the existing private adapter.kind check. Session owner can then import `parseExactCommand` from compiler.ts and use this getter plus original USER input/live active loadout to bypass only inference auth for exact commands. Parser export exists and is reused by compile. Shell owner must not alter assessCandidate/processCheck/quality/refinement while finalization regression is being handed off.

Routing owner may add store validation and routing module; it will not edit kernel.ts. Its requested governor applicability filter remains Lead follow-up after these scopes settle.


The initial serialized baseline job pwsh-22 has finished and been collected: 126 passed, 5 failed across nine files. Four failures are 30-second session timeouts; the zero-output session fixture expects a public failure event despite zero view capacity and needs actual-policy investigation. Root npm run check waits until implementations settle. Further focused tests can now run serialized.

The compiler parser is already available, not pending: import `parseExactCommand` from sandhana/compiler.ts. Session registration eligibility can use exactly the existing `_toolRegistry` registration rule at its construction (original `_baseToolDefinitions` identity and no `_baseToolsOverride`), together with the live active loadout; alternatively request one kernel read-only eligibility getter after the freshness owner completes. Preserve nonexact API rejection and post-hook inference auth checks.

