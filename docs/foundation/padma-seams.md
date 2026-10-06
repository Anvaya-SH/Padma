# Padma runtime seams

This note maps the Phase 1 source tree in this checkout. It describes the current CLI path, not every experimental package API. `packages/agent/src/harness/` contains a separate library surface; the normal coding-agent CLI does not route its turns through that runtime.

## Repository and entry points

- Root is an npm workspaces monorepo (`package.json`, `package-lock.json`): `packages/*` plus the SQLite session backend and coding-agent example workspaces. Runtime is Node `>=22.19`; TypeScript is `7.0.2`, Biome `2.3.5`, and Vitest `4.1.9` in the root manifest.
- `npm run build` builds the ordered workspaces. `npm run build:offline` skips model-data refresh. `npm run check` runs formatting/lint, repository checks, and TypeScript checks. `./test.sh` is the repo's non-e2e test entry point; do not substitute the unrestricted workspace `npm test` when provider credentials are present.
- Published CLI package is `@anvaya.sh/padma-coding-agent`, with `padma` mapped to `dist/bundle/cli.js` (`packages/coding-agent/package.json`). Production entry is `packages/coding-agent/src/cli.ts` → `src/main.ts`; `main()` resolves print, JSON, RPC, and interactive modes. `./padma-test.sh` starts the source CLI.
- Interactive backend/frontend are in the same process: `src/main.ts` creates `AgentSession` and `InteractiveMode`; `src/modes/interactive/interactive-mode.ts` subscribes to session events and renders them with `@anvaya.sh/padma-tui`. `packages/tui/src/` owns terminal rendering primitives. RPC/JSON modes are separate consumers of the session/runtime event APIs, not the interactive TUI backend.
- Main dependency direction is `coding-agent -> agent-core -> ai`, with `coding-agent -> ai` and `coding-agent -> tui`; `agent-core` also uses Chord/telemetry contracts. `ai` and `tui` do not depend on the coding-agent host. MCP, CodeMode, durable sessions, protocol/client/server, and other workspace packages remain distinct packages; the CLI does not copy them into a second upstream tree.

## Runtime map

| Concern | Actual source and responsibility |
|---|---|
| Model/provider types and invocation | `packages/ai/src/types.ts` defines `Provider`, `Models`, model and stream contracts. `packages/ai/src/models.ts` resolves auth and dispatches to the owning provider. Built-ins/catalogs live in `packages/ai/src/providers/`; `packages/ai/src/compat.ts` retains the older static/compatibility registry. Coding-agent's `packages/coding-agent/src/core/model-runtime.ts` wraps `Models`, loads credentials/catalogs, and supports extension provider registration. |
| Provider discovery/registration | `packages/ai/src/providers/all.ts` supplies built-ins. `ModelRuntime.registerProvider()` / `registerNativeProvider()` and `core/agent-session-services.ts` connect extension-registered providers to the session model runtime. `ModelRuntime.refresh()` updates catalogs; auth/configuration is stored separately from model definitions. |
| Model request and streaming | `packages/coding-agent/src/core/sdk.ts` constructs `Agent` with a `streamFn` that calls `ModelRuntime.streamSimple()`. In `packages/agent/src/agent-loop.ts`, `streamAssistantResponse()` projects/transforms messages, calls the stream function and turns provider deltas into `message_start`, `message_update`, and `message_end` events. Provider protocol adapters are in `packages/ai/src/api/` and `src/providers/`. |
| Tool schema/registration | `packages/agent/src/types.ts` defines `AgentTool`; its `parameters` schema is TypeBox and becomes a model declaration via `toToolDeclaration()`. Coding tools and their schemas are in `packages/coding-agent/src/core/tools/`. `AgentSession._buildRuntime()` and `_refreshToolRegistry()` combine built-ins, custom tools, and extension tools into `Agent.state.tools`. Extension registration API is in `core/extensions/types.ts` and implemented by `core/extensions/runner.ts`. |
| Tool decision, validation, dispatch | The active loop is `runLoop()` in `packages/agent/src/agent-loop.ts`. It reads `toolCall` blocks from an assistant response; `executeToolCalls()` chooses sequential/parallel execution, `prepareToolCall()` resolves the registered tool and validates its schema, then `executePreparedToolCall()` invokes `AgentTool.execute()`. `beforeToolCall`/`afterToolCall` hooks are supplied by `AgentSession` and extension handlers. The result becomes a `toolResult` message before another model request. |
| Continue/finish decision | In `runLoop()`, `hasMoreToolCalls`, steering/follow-up queues, and `AgentLoopConfig.finishTurn` decide whether another request occurs or `agent_end` is emitted. Separately, `AgentSession._runAgentPrompt()` and `_handlePostAgentRun()` manage retries, overflow compaction, queued messages, and extension before-settle continuation around calls to `Agent.prompt()` / `Agent.continue()`. Both layers matter when replacing controller authority. |
| Agent lifecycle/events | `Agent` in `packages/agent/src/agent.ts` owns transcript state, abort lifecycle, queueing, and event reduction. Its subscribers receive `AgentEvent` from `packages/agent/src/types.ts`. `AgentSession._handleAgentEvent()` in `packages/coding-agent/src/core/agent-session.ts` adapts events to extension/session events and records final messages. |
| Session creation/state/persistence | CLI `main()` creates a `SessionManager` and uses `createAgentSessionServices()` / `createAgentSessionFromServices()` (`core/agent-session-services.ts`, `core/sdk.ts`). `core/session-manager.ts` owns append-only JSONL files, branch state, context projection, and session format version (`CURRENT_SESSION_VERSION`). `AgentSession._handleAgentEvent()` persists `message_end` events; session changes/usage/custom entries are written through `SessionManager` methods. |
| Extension/plugin loading | `core/resource-loader.ts` discovers settings, project resources, and extensions; `core/extensions/loader.ts` loads modules/factories; `core/extensions/runner.ts` dispatches hooks and binds tools/providers. The extension API is in `core/extensions/types.ts`. This mature extension system is retained; it is not the future full Padma plugin catalog. |
| Configuration and environment | `packages/coding-agent/src/config.ts` resolves `.padma/agent`, global and project settings, session directories, and `PADMA_*` variables. `core/settings-manager.ts`, `core/auth-storage.ts`, `core/model-runtime.ts`, and `core/session-manager.ts` own settings, credentials, models, and session state. Do not assume renaming an environment variable or config path migrates its data. |
| Shell/process, files, Git | `core/tools/bash.ts` and `core/tools/powershell.ts` spawn local shells; `core/bash-executor.ts` is the shared execution helper. `core/tools/read.ts`, `edit.ts`, `write.ts`, `grep.ts`, `find.ts`, and `ls.ts` provide file/search primitives. There is no dedicated Git controller in this CLI path: Git operations are available through shell commands and extensions, so Git semantics are not a separate built-in mission boundary. |
| Cancellation/steering | `Agent.abort()` aborts its active `AbortController`; the signal is passed to provider streaming and tool execution. `AgentSession.abort()` also settles session-level work. `Agent.steer()` / `followUp()` and `AgentSession` queue methods feed the stock loop's queue callbacks. A replacement controller must honor cancellation and explicitly preserve or redefine queue semantics. |
| Logging/events | Runtime-visible events are typed `AgentEvent` and `AgentSessionEvent`; extension events are dispatched by `ExtensionRunner` and `core/event-bus.ts`. Telemetry contracts/adapters are in `packages/telemetry` and `core/telemetry.ts`; crash records are handled by `core/crash-log.ts`. Provider secrets must not be copied into new event/log payloads. |

## Controller replacement seam

The stock path is:

```text
CLI / InteractiveMode
  -> AgentSession.prompt()
  -> Agent.prompt() / Agent.continue()
  -> loopController (defaults to runAgentLoop / runAgentLoopContinue)
  -> streamAssistantResponse() / executeToolCalls()
  -> AgentEvent subscribers
  -> AgentSession persistence, extensions, and frontend events
```

`Agent` now accepts an optional typed `AgentLoopController`. The default remains the existing stock loop. An injected controller bypasses both stock loop functions for that run; it is not a wrapper around them. `AgentLoopPorts` exposes the existing tool-declaration synchronization, provider-stream conversion, and validated tool executor so a replacement can retain infrastructure without forking those implementations. `CreateAgentSessionOptions.loopController` and `CreateAgentSessionFromServicesOptions.loopController` carry the option through the Padma session SDK. The CLI still chooses the default controller in Phase 1.

This is an insertion seam, not Sandhāna. The controller must emit the existing agent/turn/message/tool events for `AgentSession` persistence and UI listeners. Also, `AgentSession._runAgentPrompt()` still owns session-level retry, compaction, queued-message, and before-settle behavior; Phase 2 must decide which of those are infrastructure and which would conflict with Sandhāna's single authority. `AgentLoopConfig` includes stock-loop hooks such as `finishTurn`; a new controller must not silently delegate mission continuation decisions back to those hooks.

## Existing ports versus not-yet-built behavior

Reusable existing ports are `Models`/`ModelRuntime` for provider access, `AgentTool` and `AgentLoopPorts.executeToolCalls` for registered tools, `SessionManager` and typed event subscribers for transcript state, `AbortSignal` plus steering/follow-up queues for cancellation/input, extension registration/hooks, and session events consumed by the TUI/RPC modes. `AgentLoopController` is the new loop replacement point.

No Phase 1 mode-policy, context-retrieval, durable-operation, capability-catalog, or Padma plugin-policy implementation is present. Add those only when a Phase 2+ caller and contract exist; do not mistake the existing general extension hooks for those systems.
