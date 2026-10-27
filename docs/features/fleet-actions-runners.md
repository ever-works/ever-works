---
id: fleet-actions-runners
title: Actions runners on your computers
sidebar_label: Actions runners
description: Turn a computer of your Fleet into a GitHub Actions self-hosted runner for a repository or an organisation — installed as a service, watched, started, stopped and removed from Ever Works.
---

# Actions runners on your computers

Any computer in your [Fleet](./fleet-hub.md) can become a **GitHub Actions self-hosted runner** for a repository or
an organisation the Ever Works GitHub App is installed on. Ever Works downloads GitHub's own runner build onto the
computer, checks it against the checksum GitHub publishes, registers it and installs it as a service — then shows
its state next to the computer's other facts, and lets you start, stop, restart and remove it.

Runners cost nothing in Ever Works: they run your CI jobs on your own machine, and no credits are spent.

:::info Status: shipped behind a flag

Actions runners ship behind `FLEET_ACTIONS_RUNNERS_ENABLED` (default off), on top of `FLEET_ENABLED`. With it off
every `/api/fleet/nodes/:id/runners` and `/api/fleet/runners` route (and the node-facing
`/api/internal/fleet/runners`) answers 404, the **Actions runners** block is absent, the poll does nothing and no
`runner-*` job is enqueued. Runners already installed keep running — they are your CI. The deployment must have the
Ever Works GitHub App configured (the same App the GitHub integration uses).

:::

## What a computer needs

- The Ever Works node, started with **`--work`** (runner jobs are work). Without it the computer says _"start the
  node with --work on build-01"_.
- A **service manager**: systemd on Linux, launchd on macOS, Windows services on Windows. A computer with none does not
  advertise the `actions-runner` capability, and the block says why.
- **Linux:** installing a systemd service needs root. Ever Works never asks for a password: the node's user must be
  allowed to run the runners' own `svc.sh` without one. When it is not, the install is refused with the exact one-time
  command to run on the machine — it allows only `svc.sh` under the node's runners folder:

  ```bash
  echo '<user> ALL=(root) NOPASSWD: <config dir>/actions-runners/*/svc.sh' | sudo tee /etc/sudoers.d/ever-works-actions-runners >/dev/null && sudo chmod 0440 /etc/sudoers.d/ever-works-actions-runners
  ```

- **Windows:** the node must run elevated (as Administrator) to install a Windows service; the runner's own service
  mode is the only mode on Windows.
- **macOS:** nothing extra — the runner is a LaunchAgent of the node's user.

## Install runners

Open the computer's page. The **Actions runners** block has **Install runners**:

- **Repository or organisation** — only the ones covered by one of your GitHub App installations (suspended or deleted
  installations are not offered). With no installation the dialog says so.
- **How many** — 1 to 16 per computer (the 16 includes the runners already there).
- **Names** — `<computer>-1`, `<computer>-2`, … by default, editable, unique on the computer. A name GitHub already
  lists for another machine is refused; Ever Works only replaces a name it registered for this runner itself.
- **Extra labels** — GitHub adds `self-hosted`, the OS and the architecture itself.
- **Mode** — **Service** (the only mode in this release; Docker-isolated runners come later on Linux).

The confirmation names the target, the count, the mode and the computer, and says no credits are spent. Install
writes the runner rows first (state **installing**) and queues one durable job on that computer, so the install
survives a dropped connection or a restart of the platform.

On the computer, per runner: **downloading** (once per install) → **verifying** GitHub's SHA-256 before anything is
extracted (a mismatch deletes the archive and nothing is installed) → **registering** → **installing service** →
**starting** → **idle**. The registration token is minted only at the moment the computer is ready for it, handed to
the node once over its own authenticated connection, and given to the runner through its environment — never on a
command line, in a job, in a log or in an audit row.

## What the block shows

Each runner shows its state — **installing** (with its phase), **idle**, **working** (with the job and a link to it),
**offline**, **stopped (by you)**, **failed** (with the first line of what went wrong), **unknown** (when GitHub and
the computer disagree, with the disagreement named) — where the state came from (GitHub or the computer), its
repository or organisation, labels, mode and runner version, **Open on GitHub**, and **Logs**: the runner's newest
diagnostic log, as the `runner:<name>` source of the computer's Logs tab.

GitHub is read every 30 seconds while the page is open and every 5 minutes otherwise (with conditional requests;
when GitHub rate-limits, the last state is shown with "GitHub is rate-limiting" and reads back off).

## Start, stop, restart, remove

- **Start** runs at once; **Stop** and **Restart** ask first. A stop you asked for shows as **stopped (by you)** and
  raises nothing.
- **Remove runner…** asks you to type its name. It uninstalls the service, deregisters the runner at GitHub and deletes
  exactly its folder on the computer. It is refused while the runner is running a job.

## Needs a look

A runner you did not stop that is offline (or whose service is down) for 5 minutes while its computer is online
raises a **runner stopped** item with **Start**; it clears when the runner is idle or working again.

## Kill switch

While **Stop all computers** is on, installing and controlling runners is refused and no registration token is handed
out. Runners that are already running keep running — they are your CI, not Ever Works work — and the block says so.

## Agents, MCP and the API

| Tool                    | What it does                                                                | Confirmation                       |
| ----------------------- | --------------------------------------------------------------------------- | ---------------------------------- |
| `fleet_runners_list`    | The runners on one computer, or on all of them                              | read-only                          |
| `fleet_runners_install` | Install 1–16 runners for a repository or organisation                       | `confirm: true`                    |
| `fleet_runners_action`  | Start, stop or restart one runner                                           | `confirm: true` for stop / restart |
| `fleet_runners_remove`  | Remove one runner (deregister, uninstall, delete its folder)                | `confirmName` = its name           |

An Agent's install, stop, restart and remove are held for your approval; the same names are the MCP tools. The routes:

- `GET /api/fleet/runners` — every runner you may see, per computer
- `GET /api/fleet/nodes/:id/runners` · `GET /api/fleet/nodes/:id/runners/options`
- `POST /api/fleet/nodes/:id/runners` — install (`202`)
- `POST /api/fleet/nodes/:id/runners/:runnerId/start|stop|restart|remove` (`202`)

Every act writes one `fleet_audit` row per runner (`node.runner.install`, `node.runner.start`, `node.runner.stop`,
`node.runner.restart`, `node.runner.remove`) with the target, labels, mode and version — never a token.

## Permissions the GitHub App needs

- Repository runners: **Administration — read and write** on the repository.
- Organisation runners: **Self-hosted runners — read and write** on the organisation.

Each call uses a short-lived installation token narrowed to the one permission it needs.

## Coming next

- An **Actions jobs** panel on the hub Overview: queued and running jobs of the repositories you watch, why a queued
  job has no runner, and **Cancel workflow run…**.
- Docker-isolated runners on Linux, runner version updates, and `ever-works fleet runners` in the CLI.
