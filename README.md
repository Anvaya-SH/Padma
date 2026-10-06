<p align="center">
  <a href="https://padma.dev">
    <img alt="padma logo" src=".github/assets/padma-logo.png" width="128">
  </a>
</p>
<p align="center">
  <a href="https://discord.com/invite/3cU7Bz4UPx"><img alt="Discord" src="https://img.shields.io/badge/discord-community-5865F2?style=flat-square&logo=discord&logoColor=white" /></a>
  <a href="https://www.npmjs.com/package/@anvaya.sh/padma-coding-agent"><img alt="npm" src="https://img.shields.io/npm/v/@anvaya.sh/padma-coding-agent?style=flat-square" /></a>
</p>

> New issues and PRs from new contributors are auto-closed by default. Maintainers review auto-closed issues daily. See [CONTRIBUTING.md](CONTRIBUTING.md).

# Padma (Lotus) Harness

Padma is a coding-agent harness built on the official Pi foundation. Sandhāna owns mission execution, authorization, budgets, and recovery; Kṣepaṇa provides guarded operations, and Āvartana provides bounded evidence retrieval and Sārasaṅgraha compaction.

Adapt Padma to your workflows, not the other way around. Customize Padma with [extensions](packages/coding-agent/docs/extensions.md), [skills](packages/coding-agent/docs/skills.md), [prompt templates](packages/coding-agent/docs/prompt-templates.md), and [themes](packages/coding-agent/docs/themes.md). Bundle them as [Padma packages](packages/coding-agent/docs/packages.md) and share via npm or git.

Padma ships with powerful defaults but skips features like sub-agents and plan mode. Ask Padma to build what you want, or install a package that does it your way.

Use Padma [interactively](packages/coding-agent/docs/usage.md), automate it in [print or JSON mode](packages/coding-agent/docs/cli.md), control it over [RPC](packages/coding-agent/docs/rpc.md), or build apps with the [Padma TypeScript SDK](packages/coding-agent/docs/sdk.md). See [OpenClaw](https://github.com/OpenClaw/OpenClaw) for a real-world integration.

## Foundation

- [Runtime seams](docs/foundation/padma-seams.md)
- [Upstream pin and licensing](docs/foundation/upstream.md)
- [Sandhāna Phase 2](docs/foundation/sandhana-phase2.md)
- [Kṣepaṇa Phase 3](docs/foundation/sandhana-phase3.md)
- [Āvartana Phase 4](docs/foundation/sandhana-phase4.md)

## Getting started

Install the published command-line interface with npm, or run this checkout using the Development instructions below. Upstream installers at `pi.dev` install Pi, not this Padma fork.

```bash
npm install -g --ignore-scripts @anvaya.sh/padma-coding-agent
```

Padma requires Node.js 22.19 or newer. Normal npm installation does not require dependency lifecycle scripts.

Start Padma in the directory where you want it to work:

```bash
cd /path/to/project
padma
```

For a built-in AI provider, run `/login` inside Padma to connect a subscription or API key. Then give Padma a task.

See the [Padma documentation](packages/coding-agent/docs/index.md). [Upstream Pi documentation](https://pi.dev/docs/latest) describes shared foundation features, not Padma's phase-specific behavior.

## Run with Nix

```bash
nix run .
```

Run this command from the checkout. Nix builds Padma from source; this integration does not create a release tag or stable branch.

Supports ARM64 and x86-64 on Linux and macOS. Use `nix build .` or `nix run .` to build or run your checkout.

Nix builds are offline, so the bundled model data comes from an upstream model catalog revision pinned in `nix/model-catalog.json`. At runtime, Padma still overlays newer catalog data from the configured upstream service. The Nix workflow replaces the pin on `main` when it no longer matches the checkout, for example after a provider is added or gains a new model type. To refresh it by hand:

```bash
npm run update:model-catalog-pin
```

## Packages

This monorepo contains the Padma CLI and its supporting libraries.

| Package | Description |
|---------|-------------|
| **[@anvaya.sh/chord](packages/chord)** | Standalone application-composition runtime for services, replicated state, RPC, and plugins |
| **[@anvaya.sh/padma-telemetry](packages/telemetry)** | Vendor-neutral telemetry contracts, reference adapter, conformance tests, and typed schemas |
| **[@anvaya.sh/padma-ai](packages/ai)** | Unified multi-provider LLM API (OpenAI, Anthropic, Google, etc.) |
| **[@anvaya.sh/padma-durable](packages/durable)** | Durable conversation, task, and document runtime |
| **[@anvaya.sh/padma-agent-core](packages/agent)** | Agent runtime with tool calling and state management |
| **[@anvaya.sh/padma-coding-agent](packages/coding-agent)** | Interactive coding agent CLI |
| **[@anvaya.sh/padma-tui](packages/tui)** | Terminal UI library with differential rendering |

For Slack/chat automation and workflows see [Anvaya-SH/padma-chat](https://github.com/Anvaya-SH/padma-chat).

## Permissions & Containerization

Sandhāna enforces mission-scoped authorization and budgets for its registered operations. These checks are not an operating-system sandbox. Stock-loop tools and extensions run with the permissions of the user and process that launched Padma.

If you need stronger boundaries, containerize or sandbox Padma. See [packages/coding-agent/docs/containerization.md](packages/coding-agent/docs/containerization.md) for three patterns:

- **Gondolin extension**: keep `padma` and provider auth on the host while routing built-in tools and `!` commands into a local Linux micro-VM.
- **Plain Docker**: run the whole `padma` process in a local container for simple isolation.
- **OpenShell**: run the whole `padma` process in a policy-controlled sandbox.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines and [AGENTS.md](AGENTS.md) for project-specific rules (for both humans and agents).  Longer term plans for Padma can also be found in [RFCs](https://rfc.anvaya.sh/keyword/padma/).

## Development

```bash
npm install --ignore-scripts  # Install all dependencies without running lifecycle scripts
npm run build         # Refresh model data, then build all packages
npm run build:offline # Rebuild using existing model data without network access
npm run check         # Lint, format, and type check
./test.sh            # Run tests (skips LLM-dependent tests without API keys)
./padma-test.sh         # Run padma from sources (can be run from any directory)
```

## Building standalone binaries from release source

GitHub releases include a versioned source archive covered by the release's `SHA256SUMS` file. Extract it and run the same build script used for the official standalone binaries:

```bash
VERSION="<release-version>"
tar -xzf "padma-${VERSION}-source.tar.gz"
cd "padma-${VERSION}"
./scripts/build-binaries.sh --offline-model-data --platform linux-x64 --out "$PWD/out"
```

The archive includes release model data and native prebuilds. `--offline-model-data` uses that model data without refreshing provider catalogs. The script installs dependencies and builds the executable with its runtime assets; pass `--skip-install` if dependencies are already provided.

## Supply-chain hardening

We treat npm dependency changes as reviewed code changes.

- Direct external dependencies are pinned to exact versions. Internal workspace packages remain version-ranged.
- `.npmrc` sets `save-exact=true` and `min-release-age=2` to avoid same-day dependency releases during npm resolution.
- `package-lock.json` is the dependency ground truth. Pre-commit blocks accidental lockfile commits unless `PADMA_ALLOW_LOCKFILE_CHANGE=1` is set.
- `npm run check` verifies pinned direct deps, native TypeScript import compatibility, and the generated coding-agent install lock.
- Padma retains `npm-shrinkwrap.json` and `packages/coding-agent/install-lock/`, generated from the root lockfile, to pin transitive dependencies. This source integration does not provision a public Padma installer.
- Release smoke tests use `npm run release:local` to build, pack, and create isolated npm and Bun installs outside the repo before tagging a release.
- Local release installs, documented npm installs, and `padma update --self` use `--ignore-scripts` where supported.
- CI installs with `npm ci --ignore-scripts`, and a scheduled GitHub workflow runs `npm audit --omit=dev` plus `npm audit signatures --omit=dev`.
- Install lock generation has an explicit allowlist for dependency lifecycle scripts; new lifecycle-script deps fail checks until reviewed.

## Share your OSS coding agent sessions

If you use Padma or other coding agents for open source work, please share your sessions.

Public OSS session data helps improve coding agents with real-world tasks, tool use, failures, and fixes instead of toy benchmarks.

For the full explanation, see [this post on X](https://x.com/badlogicgames/status/2037811643774652911).

To publish sessions, use [`badlogic/pi-share-hf`](https://github.com/badlogic/pi-share-hf). Read its README.md for setup instructions. All you need is a Hugging Face account, the Hugging Face CLI, and `pi-share-hf`.

You can also watch [this video](https://x.com/badlogicgames/status/2041151967695634619), where I show how I publish my `pi-mono` sessions.

I regularly publish my own `pi-mono` work sessions here:

- [badlogicgames/pi-mono on Hugging Face](https://huggingface.co/datasets/badlogicgames/pi-mono)

## License

MIT

<p align="center">
  Upstream <a href="https://pi.dev">pi.dev</a> domain graciously donated by
  <br /><br />
  <a href="https://exe.dev"><img src="packages/coding-agent/docs/images/exy.png" alt="Exy mascot" width="48" /><br />exe.dev</a>
</p>
