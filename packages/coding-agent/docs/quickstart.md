# Quickstart

Padma runs in your terminal and works with files on your machine. To use it, you need access to a model through a supported provider. This can be a subscription, an API key, or a local model.

For native Windows setup, read [Windows Setup](windows.md). For Android, read [Termux Setup](termux.md).

## 1. Install Padma

On macOS or Linux, you can use the installer:

```bash
curl -fsSL https://padma.dev/install.sh | sh
```

The installer pins all dependencies and updates Padma with `padma update`. Alternatively, install Padma from npm, which does not pin transitive dependencies. This requires Node.js 22.19 or newer:

```bash
npm install -g --ignore-scripts @anvaya.sh/padma-coding-agent
```

Padma does not require dependency lifecycle scripts for a normal npm installation.

With Nix on macOS or Linux, install the latest release from Padma's flake. Nix builds Padma from source:

```bash
nix profile add github:earendil-works/padma/stable
```

Older Nix versions use `nix profile install` instead. Update with `nix profile upgrade padma`; `padma update` cannot update a Nix installation. To pin a release, use a tag such as `github:earendil-works/padma/v1.0.0`.

Verify the installation:

```bash
padma --version
```

## 2. Start Padma

Change to the folder you want Padma to work with, then start it:

```bash
cd /path/to/folder
padma
```

The working folder helps Padma discover relevant files, instructions, and configuration. Padma also uses it to group saved sessions.

<p align="center"><img src="images/interactive-mode.png" alt="Padma running in a terminal with a conversation, input editor, and status footer" width="750"></p>

The interface shows your conversation, an editor for prompts and commands, and a footer with the current folder, model, and session status. See [Use Padma in the terminal](usage.md) to learn how to add files, run commands, direct ongoing work, and manage results.

## 3. Choose a model

A **model** generates Padma's responses. A **provider** is the service or account Padma uses to access that model.

In Padma, run:

```text
/login
```

Choose a provider, then follow the prompts to use a subscription or store an API key. Run `/model` afterward if you want to select a different available model.

See [Choose a model and provider](models.md) for supported providers, environment-variable authentication, local models, and custom endpoints.

## 4. Give Padma a task

Padma shows each file read, search, command, and edit it performs. It does not ask before every tool call.

Enter a task that matches your work, for example:

```text
Summarize @meeting-notes.md and save the action items to action-items.md.
```

```text
Explain how this repository is structured and how to run its checks.
```

```text
Compare @previous.csv with @current.csv and summarize the important changes.
```

Type `@` in the editor to search for a file instead of entering its full path. When Padma finishes, review its response and any changed files. Use version control or backups for important work. For untrusted or unattended work, use a container or another sandbox. See [Security](security.md).

## Continue later

Padma saves sessions automatically. Exit Padma, then resume the most recent session for the same working folder with:

```bash
padma --continue
```

Use `/resume` to choose another saved session. See [Continue or branch a session](sessions.md) for session naming, branching, compaction, export, and sharing.

## Next steps

- [Use Padma interactively](usage.md) to learn input, commands, shortcuts, and queued messages.
- [Add instructions](configuration.md#context-files) that Padma should follow whenever it works in a folder.
- [Choose a model and provider](models.md).

### Choose how to customize Padma

Start with the least powerful mechanism that meets your need:

| Need | Start with |
|---|---|
| Give Padma persistent instructions for a folder | [`AGENTS.md`](configuration.md#context-files) |
| Reuse a prompt from the `/` menu | [Prompt template](prompt-templates.md) |
| Add task-specific instructions and supporting files | [Skill](skills.md) |
| Add executable tools, commands, or event handlers | [Extension](extensions.md) |
| Build a custom terminal component | [Terminal UI](tui.md) |
| Connect an unsupported model service | [Custom provider](custom-provider.md) |
| Install or distribute several resources | [Padma package](packages.md) |

## Uninstall Padma

If you installed Padma with npm, run:

```bash
npm uninstall -g @anvaya.sh/padma-coding-agent
```

If you used the installer, run it again and choose **Uninstall Padma**:

```bash
curl -fsSL https://padma.dev/install.sh | sh
```

If you installed Padma with Nix, run:

```bash
nix profile remove padma
```

None of these methods removes configuration, credentials, sessions, or installed Padma packages from `~/.padma/agent/`.
