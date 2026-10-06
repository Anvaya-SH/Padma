<p align="center">
  <a href="https://padma.dev">
    <img alt="Padma logo" src="https://padma.dev/logo-auto.svg" width="128">
  </a>
</p>
<p align="center">
  <a href="https://discord.com/invite/3cU7Bz4UPx"><img alt="Discord" src="https://img.shields.io/badge/discord-community-5865F2?style=flat-square&logo=discord&logoColor=white" /></a>
  <a href="https://www.npmjs.com/package/@anvaya.sh/padma-coding-agent"><img alt="npm" src="https://img.shields.io/npm/v/@anvaya.sh/padma-coding-agent?style=flat-square&logo=npm&logoColor=white" /></a>
</p>

> New issues and PRs from new contributors are closed automatically. Maintainers review closed submissions daily. See [CONTRIBUTING.md](https://github.com/Anvaya-SH/padma/blob/main/CONTRIBUTING.md).

# Padma

Padma is an extensible coding-agent harness built on Pi 1.0.0. Its Sandhāna controller owns mission authorization, accounting, and recovery; Kṣepaṇa, Āvartana, and Sārasaṅgraha remain subordinate operation, retrieval, and compaction layers.

Adapt Padma to your workflows, not the other way around. Customize Padma with [extensions](docs/extensions.md), [skills](docs/skills.md), [prompt templates](docs/prompt-templates.md), and [themes](docs/themes.md). Bundle them as [Padma packages](docs/packages.md) and share via npm or git.

Padma ships with powerful defaults but skips features like sub-agents and plan mode. Ask Padma to build what you want, or install a package that does it your way.

Use Padma [interactively](docs/usage.md), automate it in [print or JSON mode](docs/cli.md), control it over [RPC](docs/rpc.md), or build apps with the [Padma TypeScript SDK](docs/sdk.md). See [OpenClaw](https://github.com/OpenClaw/OpenClaw) for a real-world integration.

## Getting started

Install the published CLI with npm, or run this checkout using the Development instructions below. Upstream installers at `pi.dev` install Pi, not Padma.

```bash
npm install -g --ignore-scripts @anvaya.sh/padma-coding-agent
```

Padma requires Node.js 22.19 or newer. Normal npm installation does not require dependency lifecycle scripts. Nix users can run `nix run .` from the repository checkout; no release or stable branch is created by this integration.

Start Padma in the directory where you want it to work:

```bash
cd /path/to/project
padma
```

For a built-in AI provider, run `/login` inside Padma to connect a subscription or API key. Then give Padma a task.

See the [documentation](docs/index.md) for full setup and usage instructions.

## Share your OSS coding agent sessions

If you use Padma for open source work, please share your coding agent sessions.

Public OSS session data helps improve models, prompts, tools, and evaluations using real development workflows.

For the full explanation, see [this post on X](https://x.com/badlogicgames/status/2037811643774652911).

Upstream's session-sharing tool is [`badlogic/pi-share-hf`](https://github.com/badlogic/pi-share-hf). Read its compatibility and publication instructions before sharing Padma sessions or mission data.

- [Upstream demo video](https://x.com/badlogicgames/status/2041151967695634619)
- Published upstream Pi development sessions: [`badlogicgames/pi-mono` on Hugging Face](https://huggingface.co/datasets/badlogicgames/pi-mono).

## Development

Clone the repository, install its dependencies, and run Padma from source:

```bash
git clone https://github.com/Anvaya-SH/padma
cd padma
npm install --ignore-scripts
./padma-test.sh
```

`padma-test.sh` can be called from any directory and preserves the caller's working directory.

Before submitting changes, run:

```bash
npm run check
./test.sh
```

Read [CONTRIBUTING.md](https://github.com/Anvaya-SH/padma/blob/main/CONTRIBUTING.md) before opening an issue or pull request. It defines the contribution gate, issue quality bar, and required checks. Read [AGENTS.md](https://github.com/Anvaya-SH/padma/blob/main/AGENTS.md) for repository-specific implementation, testing, dependency, and release rules.

## License

MIT
