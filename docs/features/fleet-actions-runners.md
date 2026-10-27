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

## Actions jobs

The hub's Overview carries an **Actions jobs** panel: the queued and running jobs that target self-hosted runners in
the repositories and organisations you watch, with the workflow and job name, the run number, the runner (or how long
it has been queued) and how many of your runners are busy. It re-reads GitHub every 30 seconds while the hub is open and
every 5 minutes otherwise.

- **Watched** — by default every repository and organisation you have runners for; **Change** lets you add or remove
  any target the Ever Works GitHub App covers (up to 20). The list is your own setting.
- **Why a queued job has no runner** — one of: _the only matching runner is offline_ · _no runner has the label
  windows_ · _no runner is registered to acme/web_ · _waiting for build-01-2_ (every matching runner is busy — not a
  problem). A job that has waited 5 minutes for one of the first three raises a **job unassignable** "needs a look"
  item with the reason and **Cancel workflow run…**; it clears when the job starts or is cancelled.
- **Cancel workflow run…** stops every job of that run, after a confirmation that names the run and the repository.
  It is refused while **Stop all computers** is on, and writes a `node.runner.job.cancel` audit row.
- A watched target that can no longer be read (the App lost access, a permission is missing) is listed with the reason
  and **Grant access** — never hidden.

Organisation runners need the App's **Self-hosted runners** permission. When you pick an organisation in the Install
dialog, Ever Works checks it first; when it is missing, the dialog names the exact permission with **Grant access**,
**Check again** and **Use a repository instead**.

## Agents, MCP and the API

| Tool                       | What it does                                                              | Confirmation                                   |
| -------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------- |
| `fleet_runners_list`       | The runners on one computer, or on all of them                            | read-only                                      |
| `fleet_runners_install`    | Install 1–16 runners for a repository or organisation                     | `confirm: true`                                |
| `fleet_runners_action`     | Start, stop, restart or reinstall one runner                              | `confirm: true` for stop / restart / reinstall |
| `fleet_runners_remove`     | Remove one runner (deregister, uninstall, delete its folder)              | `confirmName` = its name                       |
| `fleet_runners_jobs`       | The Actions jobs of the watched targets, each with why no runner takes it | read-only                                      |
| `fleet_runners_cancel_run` | Cancel a whole workflow run of one of your repositories                   | `confirm: true`                                |

An Agent's install, stop, restart, remove and cancel are held for your approval; the same names are the MCP tools. The routes:

- `GET /api/fleet/runners` — every runner you may see, per computer
- `GET /api/fleet/nodes/:id/runners` · `GET /api/fleet/nodes/:id/runners/options`
- `POST /api/fleet/nodes/:id/runners` — install (`202`)
- `POST /api/fleet/nodes/:id/runners/:runnerId/start|stop|restart|reinstall|remove` (`202`)
- `GET /api/fleet/runners/jobs` · `PUT /api/fleet/runners/jobs/watched` · `POST /api/fleet/runners/jobs/cancel` (`202`) ·
  `GET /api/fleet/runners/jobs/permission?scope=org&target=acme`

Every act writes one `fleet_audit` row per runner (`node.runner.install`, `node.runner.start`, `node.runner.stop`,
`node.runner.restart`, `node.runner.remove`) with the target, labels, mode and version — never a token.

## Permissions the GitHub App needs

- Repository runners: **Administration — read and write** on the repository.
- Organisation runners: **Self-hosted runners — read and write** on the organisation.

Each call uses a short-lived installation token narrowed to the one permission it needs.

The Ever Works GitHub App asks for both by default (from 2026-10-27). An installation made before that sees a
permission request on GitHub, and until it is accepted the runner steps that need it say which permission is
missing. **What to accept:** open the App's installation settings on GitHub (the **Grant access** link the
Install dialog shows, or **Settings → GitHub Apps → Ever Works → Configure**), press **Review request**, check that
the permission is listed, and press **Accept new permissions**. A repository target is only checked when its
registration token is minted, so the Install dialog says up front what a repository needs, and a runner that
failed for this reason says what to accept, then **Reinstall** it.

The jobs panel reads with **Actions: Read-only** and **Cancel workflow run** needs **Actions: Read and write**;
runner installs need neither.

## Container-isolated runners

On a Linux computer whose node reaches a Docker daemon, the Install dialog also offers **Container-isolated — each
runner in its own container**. The runner is still GitHub's build the node downloaded and verified against GitHub's
checksum; it runs inside GitHub's own runner image (pinned to its digest the first time the computer pulls it), as the
node's own user, with only its folder mounted, and Docker restarts it if it stops. Registration happens in a throw-away
container that receives the one-time token through its environment and is then removed.

The host's Docker daemon is **not** available inside the container unless you tick **Share the Docker daemon (runs as
root)** — with it ticked, the runners can control every container on that computer and run anything there as root.
Windows computers never offer this mode.

## Versions and Reinstall

Each runner shows its runner version. When GitHub publishes a newer build for that computer, the row says **Update
available: 2.322.0**. Updating is your act, never automatic: **Reinstall…** (also the **Retry** of a failed runner)
deregisters the runner, downloads and verifies GitHub's current build, and registers it again with the same name,
labels and mode. It is refused while the runner is running a job.

## From a shell

```bash
ever-works fleet runners list [--on build-01]
ever-works fleet runners jobs [--targets acme/api,acme]
ever-works fleet runners install build-01 --repo acme/api [--count 2] [--labels gpu] --yes
ever-works fleet runners stop|start|restart|reinstall build-01 build-01-1 --yes
ever-works fleet runners remove build-01 build-01-1 --confirm-name build-01-1
ever-works fleet runners cancel-run acme/api 4822 --yes
```

Every verb takes `--json` and exits `0` / `1` / `2`; without `--yes` (or `--confirm-name`) it shows the confirmation
sentence and asks on a terminal.
