---
id: fleet-node-link
title: Fleet node link (what your computers let Ever Works do)
sidebar_label: Fleet node link
description: The one outbound connection a computer keeps to Ever Works — the consents that open it, what it carries and never does, the relay settings an operator sets, live views over the link, the management lane and opt-in self-update.
---

# Fleet node link

Every computer in [Fleet](./fleet.md) heartbeats over HTTPS. When its owner allows more than reporting health, it also keeps **one outbound, multiplexed connection** to the platform — the **node link** — and everything live a computer does for you (Refresh now, logs, sessions, the desktop, a live view's controls) rides channels on it. The computer page in the [Fleet hub](./fleet-hub.md) shows the link under its header:

```
Link ● connected · work · manage · 12.4 MB this link
Link ○ reconnecting… (last connected 20 seconds ago)
Link ○ not open — this computer only reports health
Link ○ not accepted by this deployment
Link — not available on this kind of computer yet
```

:::info Status: shipped behind a flag

The platform accepts links only with `FLEET_NODE_LINK_ENABLED=true` (default off). With it off, every node keeps working exactly as before: heartbeats, jobs and live views over their own sockets; the node retries the link at most every five minutes and says once that the platform does not accept it yet. The link spends no tokens or credits.

:::

## Consents: what a computer lets Ever Works do

Enrolling a computer lets it report health and nothing else. Each further thing is a consent its owner gives **on the machine**, when starting the node:

| Consent      | Command-line flag | Desktop app (wizard and tray)         | What it allows                                                                                                 |
| ------------ | ----------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Run work     | `--work`          | Run work for my agents                | Leasing jobs: Agent runs, Agent sessions, checkouts for Tasks, Actions runner jobs                             |
| Live viewing | `--attend`        | Allow live viewing from the dashboard | Watching and taking over the screen or desktop, recordings                                                     |
| Manage       | `--manage`        | Allow managing this computer          | Owner sessions, logs, services, Docker, processes, ports, files, commands, schedules, checkout discovery, wake |

```bash
ever-works-node start --work --attend --manage
```

The node reports its consents on every heartbeat, and the link opens only when at least one is on. The computer's **Overview** shows them — "What build-01 lets Ever Works do" — with the exact command that turns a missing one on while keeping the others (copy it, run it on that machine). A tab that needs a consent the computer did not give names it instead of failing: _"Start the node with --manage on build-01 to use Logs."_ Nothing on the platform can give a consent; only the machine's owner can, at that machine.

A daemon older than reported consents is read from what it already advertises (`attended` for live viewing, a worker state for work) and is never assumed to allow management; the card says the consents are inferred.

The **desktop app** offers the same three consents in its setup wizard ("What may this computer do?", on the capabilities step) and as tray toggles; changing one reconnects the app so its heartbeat reports the new set. An install older than this runs as it always did (work on, the rest off). A desktop app that has not shown the new wiring yet (no link, no live viewing or management reported) still reads "not available on this kind of computer yet".

## What the link is, and what it never does

- **Outbound only.** The computer dials the platform; nothing ever connects into a computer. The link uses the same TLS origin as the API (plain `http:` only to the machine's own loopback for local development).
- **One link per computer**, authenticated in its first frame by a five-minute, single-use token the node mints through its own credential (never in a URL). A used, expired or foreign token is refused with one undifferentiated close.
- **Channels, opened by the platform only.** Up to 64 at once, each for one family (`machine`, `logs`, `session`, `desktop`, `files`, `command`, …). Before opening one the platform checks, in order: the fleet stop switch, the computer's consent for that family, and who may act in that family on that computer (its owner, or the Organization members its owner allowed). The computer checks the consent again itself.
- **Long requests are operations.** A request the computer cannot answer within two seconds gets an operation id; `GET /api/fleet/operations/:id` reads progress and the result for an hour, and `DELETE` asks the computer to cancel it.
- **Stop switch.** While the fleet stop switch is on, every new channel is refused and every open one is paused within five seconds (processes keep running); clearing it resumes without reconnecting. **Drain all** warns owner sessions sixty seconds before ending them.
- **Never logged.** Frames are never written to logs; control messages are logged by type and id only. Opening a channel in a family that changes the machine writes one audit row naming the family, the target and who asked.
- **A blip resumes.** A reconnect within two minutes resumes the channels the computer still holds (a terminal keeps streaming); one that cannot be resumed closes with a one-line notice in its tab.

## Live views over the link

An Agent computer's live view needs the owner's quality and refresh requests, the view's mode and the controlling person's input to reach the machine. With the link up, those ride a `desktop` channel instead of the view's own socket: the view asks for it on the link, the platform checks the view is pinned to that computer and live, and treats the channel as the machine's leg. If no channel arrives within five seconds — an older platform, the stop switch, links switched off — or the channel drops while the view runs, the view uses its own socket leg exactly as before. Nothing changes for the person watching. `EVER_WORKS_NODE_LINK_LEGACY_LEG=1` on the machine keeps every view on the old leg.

## The management lane

Machine jobs — creating and controlling virtual machines, installing and controlling Actions runners, the usage scan — run on a third lease loop beside the work lane and the live-view lane: one job at a time, never counted against `--concurrency`, never leased by the work lane, and only while the consent each kind needs is on (`--manage` for VMs, `--work` for runners, the usage-scan consent for the scan). It ships empty: no node starts it until those features register their job kinds.

## Keeping nodes current: opt-in self-update

A computer below this deployment's minimum version (`FLEET_MIN_NODE_VERSION`) shows **Upgrade required** on its card and header, raises an item under "needs a look", keeps reporting health, and takes no new work until it is upgraded. Its **Settings** tab has a **Node version** section with the exact command for its operating system, for example:

```bash
npm install -g ever-works-node@latest && sudo systemctl restart ever-works-node@$USER
```

Operators may also name a **recommended** version (`FLEET_RECOMMENDED_NODE_VERSION`): nodes below it are told on every heartbeat, before the floor ever bites.

A computer started with **`--auto-update`** upgrades itself when the floor rises above it (to `latest`) or a recommended version is named above it:

- it waits until no job is running on any lane — it never kills work;
- it upgrades only an `npm install -g` install it can identify from the running binary's own path, through the machine's own npm and registry (a monorepo checkout, or an install it cannot identify, is refused — never guessed);
- it runs `npm install -g ever-works-node@<version>`, records the outcome beside its config, and exits with code `75` so its service manager (the shipped systemd unit and Windows service restart on it) starts the new binary, which logs `before → after`;
- a failed install leaves the old version running, is logged once with the command to run by hand, shows on the Settings tab ("Self-update failed on build-02 at 09:12 — run the command yourself"), and is retried after 15 minutes, 1 hour, 6 hours, then daily — sooner for a new target.

Without the flag a computer only reports ("Self-update: off on this computer").

## Operator settings

| Setting                          | Default | Effect                                                                                                                                                                            |
| -------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FLEET_NODE_LINK_ENABLED`        | `false` | Accept node links. Off: links are refused, `POST /api/fleet/link-token` and the operation routes answer 404, live views keep their own sockets.                                   |
| `REDIS_URL`                      | unset   | With it set, every relay (terminal, live view, link channels) runs across API replicas through Valkey; without it relays are in-process (one API replica).                        |
| `FLEET_RELAY_REQUIRE_BUS`        | `false` | `true` fails boot without a usable bus (no `REDIS_URL`, or no signing secret) — set it on every multi-replica deployment so a missing bus is never a silently half-working relay. |
| `FLEET_RELAY_BUS_ENABLED`        | on      | `false` keeps every relay in-process even with `REDIS_URL` set (the bus's kill switch); it wins over `FLEET_RELAY_REQUIRE_BUS`.                                                   |
| `FLEET_MIN_NODE_VERSION`         | `0.1.0` | The version floor: below it a node takes no new work.                                                                                                                             |
| `FLEET_RECOMMENDED_NODE_VERSION` | unset   | The version nodes are told to move to; `--auto-update` nodes upgrade to it.                                                                                                       |

`GET /api/health/ready` reports the relay as `fleet_relay: { configured, mode: 'valkey' | 'single-replica', status: 'up' | 'degraded' }`; it never fails readiness on its own (a configured Valkey that is down already fails the `redis` check).
