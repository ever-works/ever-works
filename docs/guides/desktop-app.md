---
id: desktop-app
title: 'Desktop App: Local Stack or Client Mode'
sidebar_label: 'Desktop App'
description: Install the Ever Works desktop shell — run the whole platform on your own machine through the install wizard, or point it at an instance that already runs somewhere else and use it as a native client.
---

# Desktop App: Local Stack or Client Mode

The **Ever Works Desktop App** is an Electron shell around the platform, and it does one of two things — you choose which the first time you launch it. Either it **runs Ever Works on this machine**, supervising its own API and web processes, its own job runtime and its own database; or it becomes a **native client** onto an instance that already runs somewhere else — your self-hosted deployment, a team server, the hosted platform.

A second, smaller app ships beside it: the **Desktop Node**, which lends this machine to a platform you already use as an execution node. Both are covered below.

:::caution Status: built in CI, no public installer yet

The desktop shell (`apps/desktop`) and the desktop node (`apps/desktop-node`) are implemented and unit-tested, and `.github/workflows/desktop-build.yml` packages Windows, macOS and Linux installers on every push and pull request that touches `apps/desktop/**`. Those installers are uploaded as **workflow artifacts** — `ever-works-desktop-windows`, `ever-works-desktop-macos`, `ever-works-desktop-linux`, retained 14 days — and at the time of writing there is no public download page for them. So today you either take an artifact from a workflow run or [build it yourself](#build-it-yourself). The concept page [Desktop App](../features/desktop-app.md) describes where the local experience is headed.

:::

## The two modes

| Mode                                                  | What runs on your machine                                                                                                            | What it needs                                                                       | Pick it when                                                                                                     |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| **Run Ever Works on this machine** (`local-stack`)    | The shell supervises its own **API on `:3100`** and **web UI on `:3000`**, plus the job runtime and database you pick in the wizard. | A bundled runtime payload inside the installer, or an Ever Works monorepo checkout. | You want the whole platform local — your data, your repositories, your machine, nothing to sign in to elsewhere. |
| **Connect to an existing instance** (`remote-client`) | Nothing. The window is a native client onto an instance that already runs.                                                           | The instance URL, reachable from this machine.                                      | The platform already runs somewhere — a self-hosted deployment, your team's server, the hosted platform.         |

The choice is made in the wizard's **mode** step and stored in the desktop config file, so it survives restarts; a config written before client mode existed resolves to `local-stack`, which is exactly what it was. The local-stack card is **disabled, with the reason printed underneath**, on an install that has neither a bundled runtime nor a checkout — client mode still works, so the app never becomes useless.

## Where the local stack comes from

Before the wizard offers anything, the shell resolves _where the API and web services would come from_. It tries three things in order and reports the first that answers:

| Layout        | What it is                                                                                                                                                                                  | Toolchain on your machine                                                                                  |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `bundled`     | The runtime payload shipped inside the installer at `resources/app-bundle` — built API, Next.js standalone server and their production dependencies, described by a `bundle-manifest.json`. | **None.** Both services run on Electron's own Node.js, so no checkout, no Node.js, no pnpm.                |
| `repo`        | A monorepo checkout: an explicit `EVER_WORKS_REPO_ROOT`, or the development checkout two levels above the app path (recognised by its `pnpm-workspace.yaml`).                               | **Node.js 22+ and pnpm on `PATH`** — the wizard's prerequisite step makes both blocking.                   |
| `unavailable` | Neither of the above.                                                                                                                                                                       | Local-stack mode is disabled and the wizard says why, instead of spawning a command that will never exist. |

The mode card tells you which one you got: a green **Bundled runtime** badge (with the bundle version), an amber **From source checkout** badge (with the resolved repo path), or a red **Unavailable** badge.

:::note Fast PR builds ship without the payload

Staging the runtime payload needs a full platform build, so CI does it on the Linux cell for pushes and on all three only when a `workflow_dispatch` run sets `bundle_runtime: true`. Pull-request builds package the shell alone: they carry a `bundled: false` manifest, and the app that comes out offers **client mode only**. That is expected, not a broken build.

:::

## The install wizard

The wizard branches on the mode you choose, and only on that:

```mermaid
flowchart TD
    W[welcome] --> M[mode]
    M -->|Run on this machine| P[prereq]
    P --> R[runtime]
    R --> E[env]
    E --> B[boot]
    B --> O[open]
    M -->|Connect to an instance| RC[remote]
    RC --> O
```

**Continue** is disabled until the current step's condition is met, and a wizard you closed halfway reopens on the first step whose condition is still unmet:

| Step                  | You can advance when                                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------------------------- |
| **welcome**           | Always.                                                                                                             |
| **mode**              | A mode is selected.                                                                                                 |
| **remote** _(client)_ | The URLs resolve **and** the health probe came back OK.                                                             |
| **prereq** _(local)_  | Every _required_ prerequisite passed. Optional ones only inform later choices.                                      |
| **runtime** _(local)_ | The runtime exists, every required field has a value (its own or its default), and the database choice is coherent. |
| **env** _(local)_     | The environment file was written.                                                                                   |
| **boot** _(local)_    | Every supervised service reports healthy.                                                                           |
| **open**              | Terminal step — it hands you the **Open Ever Works** button.                                                        |

## How to: run the whole platform on this machine

1. **Launch the app.** The window opens on **Welcome**, which explains the two modes. Press **Continue**.
2. **Pick the mode.** On **How do you want to run Ever Works?**, choose **Run Ever Works on this machine**. Check the badge on the card — **Bundled runtime** means nothing else is needed; **From source checkout** means step 3's toolchain checks are real.
3. **Clear the prerequisite check.** The **Prerequisite check** step probes three tools and prints each one's version:

    | Tool        | Required?                                                       | Why                                                 |
    | ----------- | --------------------------------------------------------------- | --------------------------------------------------- |
    | Node.js 22+ | Only on a source checkout — informational on a bundled install. | Runs the API and web services from the checkout.    |
    | pnpm        | Only on a source checkout — informational on a bundled install. | Same.                                               |
    | Docker      | Never — optional.                                               | Gates the docker-compose database option in step 4. |

    On a bundled install both toolchain rows read _"not needed — this install runs the bundled platform runtime"_. Fix anything red, press **Re-check**, then **Continue**.

4. **Choose your job runtime.** The **Choose your job runtime** step lists the six [job-runtime plugins](../features/job-runtimes.md) the platform actually ships, then renders that runtime's own fields (secret fields as password inputs, each labelled with the environment variable it writes):

    | Runtime                    | Provider id | What it needs                                                                                   | Environment keys the wizard writes                                                                                                                                                              |
    | -------------------------- | ----------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
    | **BullMQ** _(Recommended)_ | `bullmq`    | A Redis — pairs with the compose Redis below.                                                   | `BULLMQ_REDIS_URL` (default `redis://localhost:6379`), `BULLMQ_QUEUE_PREFIX` (default `ever-works`)                                                                                             |
    | **pg-boss**                | `pgboss`    | The same Postgres the platform uses — a zero-Redis option.                                      | `PGBOSS_CONNECTION_STRING` _(required)_, `PGBOSS_SCHEMA` (default `pgboss`)                                                                                                                     |
    | **Temporal**               | `temporal`  | A local or remote Temporal server.                                                              | `TEMPORAL_ADDRESS` (default `localhost:7233`), `TEMPORAL_NAMESPACE` (default `default`), optional `TEMPORAL_TLS_CERT` / `TEMPORAL_TLS_KEY`                                                      |
    | **Trigger.dev**            | `trigger`   | Trigger.dev Cloud credentials, or a self-hosted webapp URL.                                     | `TRIGGER_SECRET_KEY`, `TRIGGER_PROJECT_REF` _(both required)_, `TRIGGER_API_URL` (default `https://api.trigger.dev`)                                                                            |
    | **Inngest**                | `inngest`   | The Inngest dev server or Inngest cloud.                                                        | `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY` _(both required)_                                                                                                                                    |
    | **Fleet nodes**            | `node`      | Nothing to install — jobs are leased by machines you enrolled in [Fleet](../features/fleet.md). | `FLEET_NODE_LEASE_TTL_SECONDS` (default `300`), `FLEET_NODE_REQUIRED_CAPABILITIES`, `FLEET_NODE_AGENT_TASK_COMMAND`, `FLEET_NODE_AGENT_TASK_WORKSPACE`, `FLEET_NODE_AGENT_TASK_ENV_PASSTHROUGH` |

    Trigger.dev is **dispatcher-only**: a self-hosted Trigger.dev webapp on its own queues work but does not execute it without a supervisor or runner. BullMQ is the recommended default for an all-in-one install for exactly that reason.

5. **Choose the database**, on the same step:

    | Choice                                      | What you get                                                                                                                         |
    | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
    | **Embedded SQLite (zero dependencies)**     | A database file in the app's own data directory. `DATABASE_TYPE=sqlite`. The default path for a bundled install.                     |
    | **Local Postgres via docker-compose infra** | Postgres 17 from `docker-compose.infra.yml`, on `localhost:5432` with the compose defaults. Greyed out when Docker was not detected. |
    | **External Postgres (connection URL)**      | Your own server. You must supply the **Postgres connection URL** — the step will not advance without it.                             |

    The **Provision Postgres + Redis via docker-compose.infra.yml** checkbox is separate from the database choice (BullMQ users on SQLite still want the Redis). Ticking it makes the next step run `docker compose -f docker-compose.infra.yml up -d`, which brings up `ever-works-db` (Postgres 17-alpine, `:5432`) and `ever-works-redis` (Redis 7-alpine, `:6379`) with named volumes.

    :::note The compose option is a source-checkout affordance

    `docker compose` runs from a monorepo checkout, because that is where the compose file lives. A bundled install has no checkout: keep **Embedded SQLite**, or point the wizard at an external Postgres and a Redis you run yourself.

    :::

6. **Write the configuration.** The **Write configuration** step generates the environment file from your selections — service ports (`PORT=3100`, `API_URL=http://localhost:3100`, `WEB_URL=http://localhost:3000`), the database keys, the runtime's own fields, and two runtime markers: `EVER_WORKS_DESKTOP_JOB_RUNTIME` (the plugin id, e.g. `job-runtime-bullmq`) and `EVER_WORKS_JOB_RUNTIME` (the provider id, e.g. `bullmq`) so the supervised API actually boots on the runtime you chose. Press **Write configuration**; the button changes to **Configuration written**. Re-running the wizard rewrites the keys it owns and **leaves every other key in the file alone**, so hand-edits survive.
7. **Boot the services.** Press **Start services** on the **Boot services** step. Two rows appear — **API (:3100)** and **Web (:3000)** — each with its pid and a badge that moves from `starting` to `healthy`; a live log pane underneath streams both processes' stdout and stderr. The API is polled at `http://localhost:3100/api/health` and the web app at `http://localhost:3000` every 2 seconds for up to 2 minutes. A crashed service is restarted with exponential backoff (up to five attempts) rather than left dead.
8. **Open the app.** The **Ready** step's **Open Ever Works** button loads the local web UI in the same window. From here you are in the normal product: finish the [onboarding wizard](../features/onboarding.md), then create your first Work exactly as in [the platform tour](./platform-tour.md).

## How to: connect to an instance that already runs

1. **Launch the app** and press **Continue** past **Welcome**.
2. On **How do you want to run Ever Works?**, choose **Connect to an existing Ever Works instance**. The wizard drops the prereq, runtime, env and boot steps — nothing is started locally, and sign-in happens in the instance's own web UI.
3. **Enter the instance URL** — for example `https://app.example.com`. A missing scheme is read as `https://`, trailing slashes are trimmed, and any query string or fragment is dropped.
4. **Check the derived API URL.** The field is prefilled and stays editable:

    | Instance URL you type       | API URL derived             |
    | --------------------------- | --------------------------- |
    | `https://app.example.com`   | `https://api.example.com`   |
    | `https://works.example.com` | `https://works.example.com` |
    | `http://localhost:3000`     | `http://localhost:3000`     |

    Deployments front the web app on `app.<domain>` and the API on `api.<domain>`; everything else — single-origin self-hosted installs, local ports — is assumed to serve the API from the same base URL. It is a default, not a constraint: overwrite it when your deployment differs.

5. **Add a label** if you want one (`Production`, `Staging`) — it is what the status screen shows later.
6. **Press `Test connection`.** The probe hits `<apiUrl>/api/health` and is the gate on this step: a **Reachable** badge (with the reported platform version when the health payload carries one) unlocks **Continue**; a **Failed** badge prints the status code or the transport error. Two rules are worth knowing before you type:
    - **Plain HTTP is accepted but flagged** for anything that is not loopback, with a warning that cookies and API traffic are not encrypted in transit.
    - **A URL carrying credentials is rejected outright** — `https://user:pass@host` never reaches the config file or the logs. Non-HTTP schemes are rejected too.

7. **Press `Continue`, then `Open Ever Works`.** The window loads the remote instance and stays pinned to it: navigation is allowed only within the instance's web and API origins, and every other link is handed to your OS browser.

## What the app writes to disk

Everything lives in the app's own user-data directory (`%APPDATA%\…` on Windows, `~/Library/Application Support/…` on macOS, `~/.config/…` on Linux) — nothing is written into your monorepo checkout:

| File                     | What it holds                                                                                                                                                                             |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `desktop-config.json`    | Whether the wizard completed, the mode, the runtime selection, the env file path, the remote connection.                                                                                  |
| `ever-works-desktop.env` | The generated environment file passed to the supervised API and web processes. It carries a header saying it is yours to edit and that re-running the wizard overwrites the keys it owns. |
| `ever-works.db`          | The embedded SQLite database, when you chose that option.                                                                                                                                 |

A corrupt or missing config falls back to defaults rather than refusing to launch.

## The status window and the tray

Once the wizard is done, the app opens on its status screen instead:

- **Local-stack mode** — one row per supervised service with its state and pid, and **Start all**, **Stop all**, **Open app**.
- **Client mode** — a **Remote** badge with the instance's label, web URL and **API** URL, and **Open Ever Works**.

The tray icon (tooltip _Ever Works Desktop_) carries **Open Ever Works**, **Start services**, **Stop services** and **Quit**, so a running local stack keeps working with the window closed.

## The Desktop Node worker

`apps/desktop-node` is a separate, deliberately small app: it does not run the platform and never embeds the platform web UI. It **enrols this machine as an execution node** so work can run here — the desktop packaging of the same thin-agent role as the headless `ever-works-node` CLI, sharing that package's enrollment, heartbeat and capability core.

Its wizard is **welcome → Choose your API host → Connect your account → Choose what this machine offers → Set resource limits → Enroll this machine → Running**.

1. **Mint an enrollment token** in the platform: **Settings → Fleet → Add node** at `/settings/fleet`, or `POST /api/fleet/nodes/enrollment-token`. The token is shown exactly once, is single-use, and expires in 15 minutes — see [Fleet](../features/fleet.md).
2. **Launch the Desktop Node** and read the **Detected capabilities** badges on **Welcome** — the tags this machine would report.
3. **Choose your API host**: **Local desktop install** (`http://localhost:3100` — the all-in-one from the first half of this guide), **Self-hosted** (enter your platform's API base URL), or **Cloud** (`https://api.ever.works`). The step confirms _"Will enroll against …"_ before you continue.
4. **Connect your account** either way round: paste the **Enrollment token**, or sign in with email and password here and let the app mint the token itself. Both produce the same single-use token and the same enrollment call.
5. **Choose what this machine offers.** Identity tags (`os:`, `arch:`, `node:`) are always advertised; the rest are yours to include or leave out.
6. **Set resource limits** — **Max jobs at once** (default 1) and optional CPU and memory ceilings this machine enforces on itself.
7. **Enroll.** The node then heartbeats; **Running** and the status window show the node id, API host, last heartbeat, heartbeat interval, enrollment time, capability tags, resource limits and a live log pane, with **Resume work** / pause and un-enroll controls. Closing the window minimises to the tray and keeps the machine heartbeating, and an already-enrolled machine starts heartbeating on launch without the window ever opening.

Two things to know about it:

- **The heartbeat secret never crosses the IPC bridge.** It is minted during enrollment and written by the main process to `node-config.json` in the app's user-data directory (mode `0600` on POSIX); the UI only ever learns _that_ a credential exists.
- **Un-enrolling is local.** It forgets this machine's credential; the node row stays on `/settings/fleet` until an admin revokes or deletes it there.

To have platform jobs actually execute on enrolled machines, select the **Fleet nodes** job runtime — in the desktop wizard's runtime step, or on **Settings → Job Runtime** (`/settings/job-runtime`) for an instance you already run.

## Build it yourself

Everything is in the monorepo, so you can build either app from a checkout.

| Command                                      | What it does                                                                                          |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `pnpm build:desktop`                         | Builds the desktop shell (type-check, main process, renderer) through turbo.                          |
| `pnpm --filter ever-works-desktop test`      | Runs the shell's vitest unit tests.                                                                   |
| `pnpm --filter ever-works-desktop start`     | Launches `electron .` against the built output.                                                       |
| `pnpm --filter ever-works-desktop bundle`    | Stages the self-contained runtime payload into `apps/desktop/bundle/`.                                |
| `pnpm --filter ever-works-desktop package`   | Runs electron-builder with the resolved code-signing plan; artifacts land in `apps/desktop/release/`. |
| `pnpm build:desktop-node`                    | Builds the Desktop Node (build `ever-works-node` first if you build it directly).                     |
| `pnpm --filter ever-works-desktop-node dist` | Packages the Desktop Node — unsigned by design at this stage.                                         |

A **fully self-contained installer** is four steps in order:

```bash
pnpm --filter ever-works-desktop build
NEXT_BUILD_OUTPUT=standalone pnpm build      # the platform: API + standalone Next.js server
pnpm --filter ever-works-desktop bundle      # stage bundle/: manifest + api/ + web/
pnpm --filter ever-works-desktop package     # electron-builder → apps/desktop/release/
```

Skip the middle two and you still get a working installer — it just has no runtime payload, so the app it installs offers client mode only.

Two repo-specific gotchas:

- **The Electron binary is not downloaded on install.** This repo does not allow-list install scripts, so before `start`, `package` or `dist`, run `pnpm approve-builds` and allow `electron` once, or run `node node_modules/electron/install.js` from the app directory.
- **Neither app is in the default root build.** Like `apps/docs`, both are filtered out of `pnpm build` and `pnpm build:apps`; use the filtered commands above, or `pnpm build:all`.

## Installers in CI

`.github/workflows/desktop-build.yml` builds all three platforms in a `fail-fast: false` matrix whenever a change touches `apps/desktop/**` or the workflow itself — on pushes to `main`, `develop` and `stage`, on pull requests against them, and on manual dispatch:

| OS      | Artifacts produced  | Uploaded as                  |
| ------- | ------------------- | ---------------------------- |
| Windows | `.exe` (NSIS)       | `ever-works-desktop-windows` |
| macOS   | `.dmg`, `.zip`      | `ever-works-desktop-macos`   |
| Linux   | `.AppImage`, `.deb` | `ever-works-desktop-linux`   |

Code-signing certificates never live in the repository: the workflow maps repository secrets (`DESKTOP_WINDOWS_CERTIFICATE_BASE64`, `DESKTOP_MACOS_CERTIFICATE_BASE64`, the Apple notarization trio, and their passwords) into the packaging script's environment. When any of them are missing — which is always the case for forks and for pull requests from forks — the build **degrades to unsigned** and prints a `::warning` naming the missing secrets, never their values. Linux artifacts are unsigned by design.

## Troubleshooting

| What you see                                                               | What it means                                                                                                                                                |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The local-stack card is greyed out with **Unavailable**                    | No bundled payload and no checkout. Install a build that bundles the runtime, set `EVER_WORKS_REPO_ROOT` to a checkout, or use client mode.                  |
| **Node.js**/**pnpm** block the prerequisite step                           | You are on a source checkout, which needs Node.js 22+ and pnpm on `PATH`. A bundled install downgrades both to informational.                                |
| **Local Postgres via docker-compose infra** is greyed out                  | Docker was not detected. Install Docker and press **Re-check**, or choose SQLite / external Postgres.                                                        |
| `Docker is not available — cannot provision docker-compose infrastructure` | The compose checkbox was ticked with no Docker. Untick it, or install Docker.                                                                                |
| **Test connection** returns **Failed** with an HTTP status                 | The API URL is wrong or the instance is unhealthy. Try `<apiUrl>/api/health` in a browser; if the web app is not on `app.<domain>`, set the API URL by hand. |
| **Test connection** returns **Failed** with a transport error              | DNS, TLS or the network — the message names the exact URL it could not reach.                                                                                |
| The URL is refused before any probe runs                                   | It carries credentials or uses a non-HTTP scheme. Both are rejected rather than silently rewritten.                                                          |
| A service badge sits on `starting`, then `crashed`                         | Read the log pane on the **Boot services** step; it streams both processes' output. Common cause: the database or Redis named in the env file is not up.     |

## Related

- [Desktop App](../features/desktop-app.md) — the concept page and where the local experience is headed
- [Fleet (your own machines)](../features/fleet.md) — enrollment tokens, heartbeats and the `/settings/fleet` screen the Desktop Node reports into
- [Job Runtimes](../features/job-runtimes.md) · [Workers](../features/workers.md) — the six runtimes the wizard offers, and what runs on them
- [Platform Tour (Screen by Screen)](./platform-tour.md) · [Onboarding](../features/onboarding.md) — what to do once the window opens on the product
- [Installation & Prerequisites](../installation.md) · [Docker Compose](../devops/docker-compose.md) — the same platform without Electron in front of it
- [CLI Commands](../cli/commands.md) · [MCP Server](../features/mcp-server.md) — the other machine-facing ways into an instance
- [Plugins](../features/plugins.md) — the AI, search, deployment, storage and email providers a local install can still reach outward to
