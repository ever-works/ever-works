---
id: index
title: CLI Overview
sidebar_label: Overview
sidebar_position: 1
description: The ever-works CLI at a glance — the four command groups (auth, work, plugins, kb), the published version and Node requirement, and how the API URL is actually resolved.
---

# Ever Works CLI

The **Ever Works CLI** (`ever-works-cli`) is a command-line interface that allows you to interact with the Ever Works Platform directly from your terminal. It provides convenient commands for managing works, authentication, and content generation workflows.

It installs a single binary — `ever-works` — and talks to the same REST API the dashboard uses, signed in as you. Four command groups are wired in `apps/cli/src/main.ts`: **`auth`**, **`work`**, **`plugins`** and **`kb`**. Anything the CLI has not grown a command for is still reachable over the [API](../api/index.md), the [MCP server](../features/mcp-server.md), or the dashboard.

For a step-by-step walkthrough from install to a deployed site, follow the [CLI Quickstart](../guides/cli-quickstart.md).

## At a glance

| Item             | Value                                                             |
| ---------------- | ----------------------------------------------------------------- |
| npm package      | `ever-works-cli`                                                  |
| Version          | `0.1.5`                                                           |
| Binary           | `ever-works`                                                      |
| Node.js          | `>=20.0.0` (the bundle is built for the `node20` target)          |
| License          | MIT                                                               |
| Command groups   | `auth`, `work`, `plugins`, `kb`                                   |
| Credentials file | `~/.ever-works/.credentials.json` (file `0600`, directory `0700`) |
| Source           | `apps/cli` in the Ever Works monorepo                             |

## Installation

You can install the CLI globally using npm:

```bash
npm install -g ever-works-cli
```

Or run it directly via npx:

```bash
npx ever-works-cli <command>
```

Confirm the install with `ever-works --version`, which prints the published package version (`0.1.5`).

## Basic Usage

The CLI uses the `ever-works` command. To see the available commands:

```bash
ever-works --help
```

Output:

```text
Usage: ever-works [options] [command]

Ever Works CLI - Open Work Builder Platform

Options:
  -V, --version      output the version number
  -h, --help         display help for command

Commands:
  auth               Authentication commands
  work               Work management commands
  plugins [options]  Manage plugins
  kb                 Knowledge Base commands (list, get, upload, lock, unlock)
  help [command]     display help for command
```

Running `ever-works` with no arguments prints the same help and exits `0`. Running `ever-works work` with no subcommand prints that group's own menu of thirteen commands. Every group accepts `--help`, and so does every subcommand — `ever-works kb upload --help`.

## Command groups

| Group     | Invoke                 | Covers                                                                      | Reference                                         |
| --------- | ---------------------- | --------------------------------------------------------------------------- | ------------------------------------------------- |
| `auth`    | `ever-works auth …`    | Browser (OAuth) or manual login, session status, logout                     | [Auth Commands](./auth-commands.md)               |
| `work`    | `ever-works work …`    | Create, generate, update, deploy and delete a Work; submit and remove items | [Work Commands](./work-commands.md)               |
| `plugins` | `ever-works plugins …` | Browse, enable and configure plugins; install distributable ones            | [Plugin Commands](./plugin-commands.md)           |
| `kb`      | `ever-works kb …`      | List, read, upload and lock Knowledge Base documents on a Work              | [MCP & CLI Reference](../kb/mcp-cli-reference.md) |

Most `work` and `plugins` commands are **interactive** — they prompt with a searchable list instead of taking flags, so they will hang on a non-TTY. The non-interactive subset (`work list`, `work register`, all of `kb`, the `plugins` distribution subcommands, `auth status`, `auth logout`) is the part you can safely put in a script; see [Scripting the CLI](../guides/cli-quickstart.md#scripting-the-cli).

### `auth`

| Command                  | Options                       | What it does                                                                                  |
| ------------------------ | ----------------------------- | --------------------------------------------------------------------------------------------- |
| `ever-works auth login`  | `--api-url <url>`, `--manual` | OAuth in the browser by default; `--manual` prompts for a pasted token instead                |
| `ever-works auth logout` | —                             | Deletes `~/.ever-works/.credentials.json`                                                     |
| `ever-works auth status` | —                             | Prints the stored identity, API URL and token expiry, then verifies the token against the API |

### `work`

| Command                               | Arguments and options                                                                                                                          | What it does                                                       |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `ever-works work create`              | interactive                                                                                                                                    | Creates a Work and its repository                                  |
| `ever-works work list`                | `--limit <limit>` (default `20`)                                                                                                               | Lists the Works you own or share                                   |
| `ever-works work generate`            | interactive                                                                                                                                    | Starts the content-generation pipeline for a Work                  |
| `ever-works work status`              | interactive                                                                                                                                    | Shows the current pipeline state for a Work                        |
| `ever-works work update`              | interactive                                                                                                                                    | Updates a Work and syncs its repository                            |
| `ever-works work update-website`      | interactive                                                                                                                                    | Updates only the website repository                                |
| `ever-works work deploy`              | interactive                                                                                                                                    | Triggers a deployment of the Work's website                        |
| `ever-works work submit-item`         | interactive                                                                                                                                    | Submits a single item to a Work                                    |
| `ever-works work remove-item`         | interactive                                                                                                                                    | Removes an item from a Work                                        |
| `ever-works work regenerate-markdown` | interactive                                                                                                                                    | Regenerates the Work's readme markdown                             |
| `ever-works work plugins`             | interactive                                                                                                                                    | Enables, disables and configures plugins for one Work              |
| `ever-works work delete`              | interactive                                                                                                                                    | Deletes a Work                                                     |
| `ever-works work register`            | `--repo <url>` (required), `--github-token <token>`, `--email`, `--agent-id`, `--webhook-url`, `--subdomain`, `--idempotency-key`, `--api-url` | Zero-friction registration from a repo carrying `.works/works.yml` |

`work register` is the only fully non-interactive `work` command. It falls back to `$GITHUB_TOKEN` when `--github-token` is omitted, and refuses to send that token over plain `http:` to anything but a loopback host.

### `plugins`

| Command                                        | Arguments and options                                                                           | What it does                                                   |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `ever-works plugins`                           | `-c, --category <category>`                                                                     | Searchable browser: enable, disable and configure your plugins |
| `ever-works plugins catalog`                   | —                                                                                               | Lists distributable plugins offered by the registry            |
| `ever-works plugins install <pluginId>`        | `--version <semver>`, `--integrity <sha512>`, `--source <npm\|github-packages>` (default `npm`) | Installs a distributable plugin                                |
| `ever-works plugins uninstall <pluginId>`      | —                                                                                               | Uninstalls a distributable plugin                              |
| `ever-works plugins install-status <pluginId>` | —                                                                                               | Shows the install-lifecycle row for a plugin                   |

The four distribution subcommands only return results when the platform runs in dynamic plugin mode (`PLUGIN_DISTRIBUTION_MODE=dynamic`); in bundled mode `catalog` reports an empty list rather than failing.

### `kb`

| Command                                    | Arguments and options                                                                                       | What it does                                           |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `ever-works kb list <workId>`              | `--class <class>`, `--tag <tag>`, `--q <query>`, `--limit <n>` (default `20`), `--offset <n>` (default `0`) | Lists Knowledge Base documents, with blended search    |
| `ever-works kb get <workId> <idOrPath>`    | `--json`                                                                                                    | Prints a document as rendered markdown, or the raw DTO |
| `ever-works kb upload <workId> <filePath>` | `--title <title>`, `--class <class>`                                                                        | Uploads a local file into the Work's Knowledge Base    |
| `ever-works kb lock <workId> <idOrPath>`   | `--mode <full\|content>` (required)                                                                         | Locks a document, fully or content-only                |
| `ever-works kb unlock <workId> <idOrPath>` | —                                                                                                           | Removes the lock                                       |

`<idOrPath>` accepts either the document UUID or its path, for example `runbooks/deploy.md`.

## Configuration

By default, the CLI tries to connect to the platform API at `http://localhost:3100`. You can override this during login:

```bash
ever-works auth login --api-url https://api.your-platform.com
```

More precisely, `--api-url` defaults to the `API_URL` value **compiled into the build**. The source default is `http://localhost:3100` (`apps/cli/src/utils/constants.ts`), and `apps/cli/build.js` inlines whatever `$API_URL` and `$WEB_URL` are set at build time — so a build produced for the hosted platform ships hosted defaults, while the repo default targets a local stack. Point it at the hosted API explicitly with:

```bash
ever-works auth login --api-url https://api.ever.works
```

How the API URL is resolved, in order:

| Source                            | Applies to                    | Notes                                                               |
| --------------------------------- | ----------------------------- | ------------------------------------------------------------------- |
| `credentials.apiUrl`              | every authenticated request   | Written at login; the HTTP client switches the base URL to it       |
| `--api-url`                       | `auth login`, `work register` | Sets the URL for that command and, on login, for the stored session |
| `$EVER_WORKS_API_URL`             | `work register` only          | Read at runtime; falls back to `https://api.ever.works`             |
| `API_URL` compiled into the build | everything else               | Repo default `http://localhost:3100`                                |

Two details worth knowing:

- **Pass the origin only.** `https://api.ever.works`, not `https://api.ever.works/api` — the HTTP client appends `/api` itself, and doubling it produces 404s.
- **Tokens are never sent in cleartext off-box.** Login, `work register` and the shared HTTP client all refuse to attach the bearer token when the URL is `http:` and the host is not loopback. Use an `https://` URL for anything remote.

Credentials live in `~/.ever-works/.credentials.json`, written with mode `0600` inside a `0700` directory. They are validated on every load — a malformed or expired JWT is removed and you are asked to log in again. Requests time out after 30 seconds, and any `401` prints `Authentication failed. Please login again with "ever-works auth login".` before exiting `1`.

The `WEB_URL` compiled into the build decides which web app the OAuth page opens against (repo default `http://localhost:3000`); there is no flag for it.

## Prerequisites

- **Node.js** v20 or higher — the published package declares `engines.node: ">=20.0.0"` and the bundle targets `node20`
- A running instance of the **Ever Works Platform API** (locally or remote)
- A **git provider** connected in the dashboard at `/settings/plugins/git-provider` before `work create` or `work generate`
- An **AI provider** connected at `/settings/plugins/ai-provider` before `work generate`
- The **editor** role or higher on a Work for write commands; `work delete` is owner-only

## How to install and run your first command

1. Install the binary and confirm the version: `npm install -g ever-works-cli && ever-works --version`.
2. In the dashboard, open `/settings/plugins/git-provider` and enable a git provider, then `/settings/plugins/ai-provider` and enable an AI provider with your key.
3. Sign in: `ever-works auth login --api-url https://api.ever.works`. A browser tab opens, you authenticate, and the tab closes itself a few seconds after the success page.
4. Verify the session: `ever-works auth status` — it prints your email, the API URL and the remaining token lifetime, then checks the token against the API.
5. List what you already have: `ever-works work list --limit 5`.
6. Create a Work: `ever-works work create`, answering the prompts for name, slug and repository.
7. Generate its content: `ever-works work generate`, then poll with `ever-works work status` or watch the run at `/works/:id` in the dashboard.
8. Publish it: `ever-works work deploy`.
9. Optionally seed its Knowledge Base: `ever-works kb upload <workId> ./brand/voice.md --class brand`.

## What the CLI does not cover yet

The command tree is `auth`, `work`, `plugins`, `kb` — and nothing else. There are no commands for Agents, Tasks, Missions, Ideas, Teams or Memory, no `work import`, and no `kb create` / `kb update`; drive those from the dashboard, the [API](../api/index.md), or the [MCP server](../features/mcp-server.md). `auth login --manual` also expects a JWT, so platform API keys belong in `curl`, CI and MCP configuration rather than the CLI credential store. The full list of gaps, each with its supported alternative, is in [CLI Quickstart](../guides/cli-quickstart.md#what-the-cli-cannot-do-yet).

## Related

- [CLI Quickstart](../guides/cli-quickstart.md) · [CLI Commands](./commands.md) · [Auth Commands](./auth-commands.md) · [Work Commands](./work-commands.md)
- [Plugin Commands](./plugin-commands.md) · [Generation Commands](./generation-commands.md) · [Internal CLI Reference](./internal-cli.md)
- [Knowledge Base — MCP & CLI Reference](../kb/mcp-cli-reference.md) · [Knowledge Base — User Guide](../kb/user-guide.md) · [Knowledge Base & Memory](../features/knowledge-base.md)
- [API Overview](../api/index.md) · [MCP Server](../features/mcp-server.md) · [MCP Server Setup](../guides/mcp-server-setup.md) · [Plugins](../features/plugins.md)
- [Creating a Work](../features/creating-a-work.md) · [Self-Host with Docker & Kubernetes](../guides/self-host-docker-kubernetes.md)
