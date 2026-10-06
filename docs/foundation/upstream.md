# Upstream foundation record

## Pin

- **Upstream:** [earendil-works/pi](https://github.com/earendil-works/pi) (the repository URL in the pinned coding-agent package metadata is `git+https://github.com/earendil-works/pi.git`).
- **Integrated source revision:** [`9fba660cf1caca0ade5bea72269352416e595a19`](https://github.com/earendil-works/pi/commit/9fba660cf1caca0ade5bea72269352416e595a19), commit dated 2026-10-02.
- **Package version at that upstream revision:** `1.0.0` (`packages/agent`, `packages/ai`, `packages/coding-agent`, and `packages/tui` package metadata at the pinned commit).
- **Tracking model:** this is a fork with Git history, not a submodule, copied second project, or runtime dependency on upstream published packages. The current `origin` remote points to `https://github.com/Anvaya-SH/padma.git`; it is not the upstream remote. Do not treat `origin/main` as an upstream update mechanism.

The pin identifies the integrated upstream source, not a new local Git commit or the entire current working tree. The committed fork base remains `02eed88fd8912e54a804ddebd409e2e4c08ac5ef`; this integration is uncommitted. The checkout already contains a substantial uncommitted Padma package/import/documentation rebrand and other workspace changes. Review `git diff` before committing or attributing that existing delta; it is not represented by the upstream pin. Phase 1 additions in this work are the controller insertion port, its focused test, the foundation documentation, and restoration of `Math.PI` in the TUI math modules and AI test-image script where the existing rebrand diff had changed it to the invalid `Math.PADMA`.

## License and dependency obligations

The pinned upstream package manifests declare MIT. The root `LICENSE` retains Mario Zechner's copyright and MIT permission/warranty terms; keep that notice and any notices attached to copied upstream or vendored material. Padma's repository and package names do not transfer or remove upstream attribution. Third-party notices present in the source tree (including `packages/mcp/LICENSES/`) must also remain intact.

The lockfile and package manifests are the dependency record. Root development requires Node `>=22.19.0`; the root toolchain pins TypeScript `7.0.2`, Biome `2.3.5`, and `@types/node` `22.19.19`. The reusable agent, model, and CLI workspaces target Node `>=22.19.0`. Direct external package dependencies are pinned to exact versions in package manifests and `package-lock.json`; internal workspace dependencies are version-ranged. Review dependency, lifecycle-script, and license metadata changes as code changes. This file records the upstream license, not a replacement for checking each dependency's own published license.

## Upstream subsystems retained

Padma keeps the source workspaces and useful upstream implementation rather than maintaining a second upstream tree:

- `packages/ai`: provider/model contracts, auth-aware model dispatch, streaming protocol adapters, and model catalogs.
- `packages/agent`: transcript/event state, stock agent loop, provider stream handling, tool schema validation and execution.
- `packages/coding-agent`: model runtime, sessions/JSONL persistence, tools, extensions, configuration, CLI modes, and interactive backend.
- `packages/tui`: terminal primitives and rendering used by the existing interactive mode.

The exact execution locations and ownership boundaries are in [padma-seams.md](./padma-seams.md). Phase 1 introduced the replaceable `AgentLoopController` seam. The subsequent Padma phases retain Sandhāna as the mission controller, Kṣepaṇa as its guarded operation layer, and Āvartana/Sārasaṅgraha as its bounded retrieval and compaction layer. See [Phase 2](./sandhana-phase2.md), [Phase 3](./sandhana-phase3.md), and [Phase 4](./sandhana-phase4.md).

## Local boundary and retained identifiers

Padma-facing product names are `Padma`, `padma`, `.padma`, and the `@anvaya.sh/padma-*` workspace packages. These are workspace-owned package/config identities, not a rewrite of the upstream Git history. The fork intentionally retains technical names such as `Agent`, `AgentSession`, `AgentEvent`, `runAgentLoop`, `ModelRuntime`, provider IDs/protocols, TypeBox/JSONL/TUI/RPC APIs, and upstream source/license references. Do not globally rename them for branding.

In this Phase 1 implementation, `AgentLoopController` is injected into the existing `Agent`; its model streaming, tool declaration, validated tool dispatch, event, session, and TUI paths are reused. The new port's source and focused test are in `packages/agent/src/agent-loop.ts`, `packages/agent/src/agent.ts`, and `packages/agent/test/agent-loop-controller.test.ts`; Padma session SDK forwarding is in `packages/coding-agent/src/core/sdk.ts` and `core/agent-session-services.ts`. Accidental `Math.PADMA` substitutions in `packages/tui/src/colors.ts`, `packages/tui/src/oklab.ts`, and `packages/ai/scripts/generate-test-image.ts` were restored to the JavaScript constant `Math.PI`.

## Config/session compatibility

Padma defaults to `~/.padma/agent` and `PADMA_*` environment variables. Phase 1 does not automatically read or copy a legacy Pi installation's `~/.pi` configuration, credentials, or default session directory, and it does not currently alias legacy `PI_*` variables. This separation avoids silently sharing credentials or session history; keep the old directory untouched and move only the settings or credentials you intend to use. Existing JSONL sessions can be opened explicitly with `padma --session <path>` where the format is supported; default resume discovery stays under Padma's configured session directory. No mission/session records are silently rewritten.

## External service endpoints

The Radius gateway remains an external upstream service at `https://radius.pi.dev`. Replacing that hostname with `radius.padma.dev` produced a TLS handshake failure, while the original endpoint responded successfully. Keep the external service hostname until a Padma-operated replacement is provisioned; this does not change Padma's product or package identity.

## Pi 1.0.0 integration

Source integration used an isolated three-way merge and a hashed backup, not a pull or reset of the modified worktree. Current phase code, phase tests, concurrent RPC changes, existing changelogs, legal notices, and vendored files were excluded from replacement. Existing phase functionality remains on the Padma controller seam; upstream's new experimental durable harness is a separate API, not an alternative owner of a Sandhāna mission.

The superseded upstream experimental agent harness, micro/mini prototypes, and `packages/session-backends/sqlite-node` were removed with user approval. Their upstream replacement is `packages/durable`, including SQLite storage. Sandhāna's own SQLite store, mission history, authorization, accounting, and recovery code were not migrated or deleted.

Internal package versions now follow upstream `1.0.0`. Padma retains its `padma` command, `.padma` configuration, `PADMA_*` variables, package namespace, and pinned shrinkwrap/install-lock checks. The regenerated model catalog uses the updated upstream generator; it is not edited by hand. Guarded shell structured output reuses bounded native stream captures rather than introducing an unreserved post-dispatch file read.

The integration backups and external application journals were deleted at the user's request. No integration commit or release was created.

Follow-up validation: `npm run check` and `git diff --check` pass. A complete selected Phase 2/3/4 run exercised 544 tests in 42 files: 537 passed initially; the seven failures subsequently passed in focused reruns. The two controller/seam files also pass (four tests). This is validation across runs, not a single all-green workspace run or exhaustive compatibility proof.

Launched native evidence now uses bounded retrieval reservations linked to the already running operation. Peer model overruns do not discard its actual output or source observations, and do not admit new actions. The capture tests cover reservation and cumulative token overruns. Model accounting also retains malformed measurements as unknown, records elapsed-time overruns, and settles known zero inference when admission fails before provider dispatch. Retrieval accounting tests include capture reservations; the timeout fixture allows native process startup on loaded Windows hosts.

Dependency review upgraded Vitest to `4.1.11`, including the transitive evaluation runner, and the optional Gondolin example's Undici 6.x to `6.29.0`. Undici release notes were reviewed: `6.28.1` fixes invalid WebSocket handshakes, decompression errors and retry response framing; `6.29.0` fixes terminal retry-body settlement and upgrade diagnostics. Core Undici `8.10.2` remains unchanged. Shrinkwrap and install-lock metadata were regenerated without lifecycle scripts.

Remaining dependency limitations: npm audit reports seven high-severity findings through `braces`/`shx` and `node-forge`/the optional Gondolin example. The registry has no patched `braces` or `node-forge` release; npm's proposed `shx` remedy is a downgrade, which was not applied. Gondolin requires Node `>=23.6.0`, above the installed Node `22.23.2`; the optional evaluation dependency also declares pnpm-only engine metadata. These warnings are not resolved by passing repository checks, and those optional runtimes have not been established compatible.

## Deliberate upstream update procedure

1. Add/fetch a separate `upstream` remote for `https://github.com/earendil-works/pi.git`; do not repoint the Padma `origin`.
2. Select and record an exact upstream commit/tag. Review its source, release notes, dependency/license metadata, lifecycle scripts, and changes against the current pinned base before integration.
3. Port or merge deliberately on a dedicated branch while preserving Padma history and local ownership boundaries. Do not run an updater that follows a moving branch or rewrites Padma automatically.
4. Run the targeted package tests and repository checks, refresh lock/shrinkwrap artifacts only when dependency metadata changes, and update this pin plus the seam map when source responsibilities move.
