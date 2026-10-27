---
id: fleet-health
title: Computer health (is it healthy, is it getting worse, can I wake it)
sidebar_label: Computer health
description: What every Fleet computer reports about its health, the plain-language states and their fixes, the history kept, Refresh now, and waking an offline computer from another one on the same network.
---

# Computer health

Every computer in your [Fleet](./fleet.md) reports its health on each check-in — once a minute — and the
[Fleet hub](./fleet-hub.md) turns that into three answers: **is it healthy**, **is it getting worse**, and
**if it is asleep, can I wake it from here**. Health is report-only: the computer measures and says what it
measured; nothing here is ever pushed back down to it. It spends no tokens or credits.

## What a computer reports

Each check-in carries a **health snapshot**:

| Fact            | Shown as                                                                                       |
| --------------- | ---------------------------------------------------------------------------------------------- |
| CPU             | percent busy since the last check-in                                                           |
| Memory          | percent used, and used / total                                                                 |
| Disk            | percent full, free space, and the computer's own disk floor                                    |
| GPU             | vendor and model, and — when the vendor tool says — busy and memory; "No GPU" when it has none |
| Load            | the one-minute load average with the core count (not on Windows)                               |
| Uptime          | how long the machine has been up                                                               |
| Pending reboot  | whether the operating system waits for a restart (Linux, Windows)                              |
| Failed services | how many services the service manager reports as failed                                        |

A fact a computer could not read is shown as **—**, never as zero: "no failed services" and "we could not
ask" are different facts. A computer running a node version older than health reporting shows "—" in every
cell and says so. A snapshot older than the computer's offline window is dimmed and marked **stale**.

The time on a snapshot is the platform's receipt time — never the machine's own clock.

## States and their one fix

A computer is always in exactly one state, written in words beside its dot (never colour alone):

| State            | Reads                                                    | Fix                             |
| ---------------- | -------------------------------------------------------- | ------------------------------- |
| Online / Busy    | Online · Busy · 2 jobs                                   | —                               |
| Offline          | Offline · last seen 2 h ago                              | **Wake**, when possible (below) |
| Quarantined      | Stopped itself: _the computer's own reason_              | the exact command to run on it  |
| Throttled        | Pausing new work — CPU is above its ceiling (92% of 85%) | **Change limits**               |
| Limited          | Waiting for Claude Code's limit to reset at Sun 03:00    | **Clear limit now** (audited)   |
| Upgrade required | Upgrade required — takes no work until updated           | the upgrade command             |

The hub cards, the Computers table and the computer header show the state's _why_ next to the word — the
reset time of a usage limit, the computer's own reason, "can be woken from build-01". A reset time is in
your time zone, with UTC in the tooltip.

The same states feed **Needs a look** on the hub: disk running low (against the computer's own floor, then a
percentage), a throttled or limited computer, one that stopped itself, one that only reports health
(started with no `--work`, `--attend` or `--manage`), and a screen helper with reduced trust.

## History

With `FLEET_HEALTH_HISTORY_ENABLED` on (default off), the platform keeps **one sample a minute for 7 days**
and **one an hour for 90 days** — about 10 000 samples a week per computer. An hourly job rolls the minutes
up (the mean of each figure, plus the hour's peak) and deletes what is past its window.

The computer's Overview tab shows the **history chart**: ranges **1 h · 24 h** (from the minute samples) and
**7 d · 90 d** (from the hourly roll-ups), at most 500 points, CPU / memory / disk lines you can switch on and
off, and a sentence per line for screen readers ("CPU averaged 31% over the last hour, peak 78% at 09:12").
A stretch where the computer was offline is a **break in the line**, never a dive to zero. Each hub card
carries a **sparkline** of the last hour's CPU.

With history off, nothing is written and the chart says "History is switched off on this deployment."

## Refresh now

**Refresh now** (or `R` on the computer page) asks a connected computer for a fresh snapshot over its node
link instead of waiting for the next check-in — the cards update within 3 seconds and read "Checked just
now". The next scheduled check-in is unaffected.

- Anyone who can see the computer can refresh it (the `view` family) — it is a read.
- It needs an open link, and nothing more: a computer started with any of `--work`, `--attend` or
  `--manage` answers. One started with none of them cannot be refreshed; the button says how to start it,
  with the real countdown to its next automatic check.
- An offline computer, a dropped link (**Try again**), and "all computers are stopped" each say so.
- At most 10 refreshes a minute per computer.

## Wake an offline computer

An outbound-only fleet cannot reach a sleeping machine — but another of your computers on the **same
network** can. **Wake** (or `W`) sends a Wake-on-LAN packet through that sibling, then watches: at 20 seconds
and 60 seconds it says "win-lab is back", "has not answered yet", or "has not answered — it may be powered
off or on another network" with **Try again**.

Wake is offered when:

- the computer is **offline**;
- it once reported its **hardware address** — a node started with `--manage` reports it, together with an
  opaque identity of its network (a hash, never an address);
- another of your computers is **online on the same network** and was started with `--manage` (it
  advertises `wake`).

Otherwise the button is disabled with the reason. Waking is a `machines`-family act on the computer being
woken (the owner by default — see [who may do what](./fleet-hub.md)), it is refused while all computers are
stopped, at most **3 attempts per 5 minutes**, and every attempt that reached a sibling writes one
`node.wake` row in the Fleet audit naming both computers.

The hardware address is stored for the owner's own computers only, never shown in full (only its last two
octets), and never shown to anyone else. The network identity is re-hashed with the owner's id before it is
stored, so siblings can only ever be matched among one owner's computers. The waking computer sends the
packet only to its own network's broadcast addresses — the platform cannot aim it anywhere else.

The machine needs Wake-on-LAN switched on in its firmware and network adapter settings; that part is the
machine's own.

## For Agents and tools

`fleet_nodes_health` (read-only: snapshot, state, and with `range` the history) and
`fleet_nodes_needs_a_look` (read-only) return the same shapes the page reads; `fleet_nodes_wake` is the
wake act's tool shape. The Fleet agent tools epic binds them behind the Agent permission gates.

## API

All under `/api/fleet`, authenticated, `FLEET_ENABLED`-gated:

| Method | Path                        | What                                                                   |
| ------ | --------------------------- | ---------------------------------------------------------------------- |
| GET    | `/nodes/:id/health`         | snapshot, staleness, state and fix, wake and refresh availability      |
| GET    | `/nodes/:id/health/history` | `?range=1h\|24h\|7d\|90d`, ≤ 500 points, `{ disabled: true }` when off |
| POST   | `/nodes/:id/health`         | Refresh now                                                            |
| POST   | `/nodes/:id/wake`           | wake through a sibling (202)                                           |
| GET    | `/nodes/:id/wake`           | has it answered the last wake?                                         |

Refusals carry `{ error: { code, hint } }`: `unreachable`, `consent_missing`, `kill_switch`,
`limit_exceeded`, `unsupported_on_node`, `permission_denied`, `not_found`, `invalid`.
