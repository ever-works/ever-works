# FL-03 — Computer health & inventory

> Behaviour-first spec per [Constitution Principle IX](https://github.com/ever-works/ever-works/blob/develop/.specify/memory/constitution.md#ix-specs-are-behaviour-first).
> No class names, no file paths, no code. Implementation lives in [plan.md](./plan.md).

**Epic ID:** `FL-03-computer-health`
**Program:** [Fleet](../README.md) · Wave 0 (foundations)
**Branch:** `feat/fl-03-computer-health`
**Status:** `Draft` · implementation `In progress` (P1 in `feat/fl-03-computer-health-p1`)
**Created:** 2026-10-18
**Last updated:** 2026-10-18
**Size:** M · **Blocked by:** — (renders into FL-01's slots; `health.now` and wake ride FL-02's link when present) · **Related:** FL-01 (cards, "needs a look" renderer), FL-02 (`machine` channel, `wake` tag), FL-07 (helper trust producer), FL-17 (cloud idle), FL-20 (Usage)
**Extends (existing Ever Works nouns):** Node (Computer) · heartbeat · worker state · model usage limits · Fleet audit · node drawer · Inbox

---

## 0. TL;DR

A computer in the fleet reports that it is alive, what its worker is doing and how much disk is
left — and nothing else. The owner cannot see CPU, memory, load, uptime or the GPU, cannot tell
whether a machine is getting worse, and learns about a throttled or quarantined node by opening a
drawer. This epic makes every heartbeat carry a **health snapshot** (CPU, memory, disk, GPU, uptime,
load, pending reboot, failed services), keeps a **history** (one sample a minute for a week, hourly
for ninety days), turns the machine's state into **plain words with a fix button** ("Waiting for
Claude Code's limit to reset at 03:00 — Clear limit now"), registers the first **"needs a look"
producers** (disk low, throttled, quarantined, consent missing, helper untrusted), lets an offline
machine be **woken** by a sibling on the same network, and lets the owner **refresh now** over the
link instead of waiting for the next beat.

```
 COMPUTER PAGE · Overview tab (FL-01 shell, FL-03 fills the metric and history slots)
 ────────────────────────────────────────────────────────────────────────────────────────
 build-01  ● Online · Linux · checked 09:41 (48 s ago) · up 3 d 4 h           [Refresh now]
 ┌ cpu 31% ─┐ ┌ memory 58% ─┐ ┌ disk 40% ─────┐ ┌ gpu nvidia ─┐ ┌ load 1.9 ┐ ┌ services ┐
 │ ▁▂▃▅▃▂▃▂ │ │ 9.3 / 16 GiB│ │ 118 GiB free  │ │ 12% · 2 GiB │ │ 4 cores  │ │ 1 failed │
 └──────────┘ └─────────────┘ └ floor 5 GiB ──┘ └─────────────┘ └──────────┘ └──────────┘
 Pending reboot: no                    Wake: can be woken from build-02 (same network)

 History   [ 1 h ] [ 24 h ] [ 7 d ] [ 90 d ]        cpu ── memory ── disk ──
 100% ┤                                  ╭──╮
      ┤        ╭───╮            ╭────────╯  ╰───
   0% ┼────────╯   ╰────────────╯
      09:00                      09:20                        09:40

 FLEET HUB · Needs a look
 ● design-mac   Disk is 94% full · 6 GiB left, the node stops at 5 GiB                [Open]
 ● build-02     Waiting for Claude Code's limit to reset at 03:00                 [Clear limit now]
 ● win-lab      Offline since 07:12 · can be woken from build-01                        [Wake]
```

Three phases, each independently shippable:

- **P1 — Snapshot and states.** The heartbeat carries health; the computer row keeps the latest
  snapshot; cards and the Overview tab show it; plain-language states with fix actions; the five
  producers.
- **P2 — History.** Samples stored once a minute, rolled up hourly, retained 7 days / 90 days; the
  history chart and card sparklines; `FLEET_HEALTH_HISTORY_ENABLED`.
- **P3 — Reach.** Wake-on-LAN through a sibling node; **Refresh now** over the link.

---

## 1. Overview

Every heartbeat a computer sends — once a minute today — gains a **health snapshot**: how busy the
processor is, how much memory is in use and how much there is, how full the disk the node works on
is and how many bytes remain, the one-minute load, how long the machine has been up, whether the
operating system is waiting for a reboot, how many of its services have failed, and, when there is
one, which GPU it has and how busy it is. The platform keeps the latest snapshot on the computer so
every list is cheap, and (behind a flag) stores one sample per beat for seven days, rolled up to one
row an hour for ninety days, so "is this getting worse?" has an answer.

The computer's **state** becomes a sentence a non-technical owner can act on. Online, busy, offline,
paused, draining, disabled and enrolling exist today; this epic adds the words and the actions for
the states the last week introduced — a machine **throttled** by a resource ceiling, a machine
**waiting for a model CLI's usage limit to reset** (with the reset time and a one-click clear), a
machine that **quarantined itself** (with the exact command to run there), and a machine that is
**offline but can be woken** from a sibling on the same network. Each state names its fix.

Five **"needs a look" producers** feed the list FL-01 renders: disk running low (against the node's
own floor, then a percentage), node throttled, node quarantined, consent missing (a computer that
only reports and can do nothing else), and a screen helper admitted with reduced trust (the
producer exists now and fires only once FL-07 reports that field).

Two reach actions complete the picture. **Wake** sends a wake packet from another online computer of
the same owner on the same network, the only way an outbound-only fleet can reach a sleeping
machine; the platform then watches for the woken machine's next heartbeat and tells the owner at 20
and 60 seconds. **Refresh now** asks a connected computer for a fresh snapshot over the node link
instead of waiting for its next beat.

---

## 2. Why now

### 2.1 The user's question

> _"Is that machine healthy, is it getting worse, and if it is asleep can I wake it from here?"_

### 2.2 What exists today, and what breaks

| To answer…                               | Today                                                                                                                                                                                                                                | What breaks                                                                                                                                                                                                                                                                                 |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "How busy is it?"                        | The heartbeat carries `diskFreeBytes`, the node's own disk floor, workspace counts and the enforced limits (`packages/contracts/src/fleet/fleet-node.types.ts:212-323`). The node's own housekeeping report states it in so many words: it sends no CPU or memory reading at all (`apps/node/src/core/housekeeping-report.ts:30-34`). | The node *samples* CPU and memory for its admission gate (`apps/node/src/core/resource-limits.ts:13-28`; `apps/node/src/node-io.ts:310-335`) and never reports them. Uptime, load, pending reboot and failed services are measured nowhere, and no history of any field is kept (EXISTING-SUBSTRATE §1.10, §2.13, gap 9). |
| "Is it getting worse?"                   | Nothing. The row holds the latest `diskFreeBytes` and nothing else over time (`packages/agent/src/entities/fleet-node.entity.ts:264`).                                                                                               | No history table, no roll-up, no chart; the capability map calls this out (row A "Health").                                                                                                                                                                                                 |
| "What is wrong with it?"                 | A worker state badge and a free-text reason in the drawer (`apps/web/src/components/settings/FleetNodeDrawer.tsx:317-345`); model throttles listed with a **Clear** button (`:347-392`); "Upgrade required" (`:493-505`).             | The states are words for operators (`quarantined`, `throttled`), not sentences for owners, and they live three clicks deep. The week-old usage-limit work (`apps/api/src/migrations/1795161700000-AddFleetModelUsageLimits.ts`, audit `node.model-throttle-clear` in `fleet-panic.types.ts:84`) has a route (`fleet.controller.ts:451`) but no place in a list of things that need a look. |
| "Which GPU does it have?"                | A `gpu` and `gpu:<vendor>` tag from a probe that returns vendor and model only (`apps/node/src/core/gpu-probe.ts:19-26`).                                                                                                              | No utilisation, no memory.                                                                                                                                                                                                                                                                  |
| "Wake it."                               | Nothing (no `macAddress` column — EXISTING-SUBSTRATE §2.2; no wake code — §1.14, §2.13 "No wake-on-LAN").                                                                                                                             | An outbound-only node that is asleep is unreachable until someone walks to it.                                                                                                                                                                                                              |
| "Check it now."                          | Wait for the next beat (60 s by default, `fleet-client.ts:17`); the offline sweep runs on list (`packages/agent/src/fleet/fleet.service.ts:958-984`).                                                                                | The only live path is the computer-session leg, built for pictures (FL-02 generalises it).                                                                                                                                                                                                  |

### 2.3 Why this epic is additive only

The heartbeat gains optional fields in the newest tier, so an older platform drops them and a newer
platform accepts a beat without them. Every existing column, badge and route (worker state, model
throttles and their clear route, the drawer) keeps working; this epic adds sentences, producers and
a history beside them. Nothing on the node is enforced from the platform: health is reported up,
never pushed down (the same rule the housekeeping report states).

---

## 3. User scenarios

### 3.1 Primary scenarios

- **S1 — The card tells the truth at a glance.** **Given** `build-01` beat 48 seconds ago,
  **when** the owner opens the hub, **then** its card reads `cpu 31% · mem 58% · disk 40%` with
  "checked 48 s ago" and a tooltip with the absolute time; a computer whose last beat predates this
  epic's node version shows "—" in each cell and "health not reported by this node version".
- **S2 — Metric cards on the computer page.** **Given** the Overview tab, **when** it loads,
  **then** six cards show CPU, memory (used / total), disk (free and the node's own floor), GPU (or
  "no GPU"), load with core count, and services (failed count); a line reads "Pending reboot:
  yes/no"; everything carries the snapshot's time.
- **S3 — Plain words, one fix.** **Given** Claude Code on `build-02` hit its weekly limit,
  **when** the owner looks, **then** the state reads _"Waiting for Claude Code's limit to reset at
  Sun 03:00"_ with **Clear limit now**; pressing it calls the existing clear, the state changes on
  the next beat, and the existing audit row is written.
- **S4 — Quarantined.** **Given** `design-mac` quarantined itself, **when** the owner opens it,
  **then** the state reads _"Stopped itself: <the node's reason>"_ with the exact command
  `ever-works-node clear-quarantine` to run on that machine and a copy button; nothing is offered
  that the platform cannot do.
- **S5 — Needs a look: disk.** **Given** `design-mac` has 6 GiB free and its own floor is 5 GiB,
  **when** the hub renders, **then** the list shows _"Disk is 94% full · 6 GiB left, the node stops
  at 5 GiB"_ as `critical` with **Open**; at 9 GiB free and 88% full it is `warn`.
- **S6 — History.** **Given** the history flag is on, **when** the owner opens the chart and picks
  24 h, **then** CPU, memory and disk lines render from one-minute samples with gaps where the
  machine was offline; 7 d and 90 d render hourly points; the card sparkline shows the last hour.
- **S7 — Wake.** **Given** `win-lab` is offline, reported its network address identity before, and
  `build-01` is online on the same network with `--manage`, **when** the owner presses **Wake**,
  **then** the platform sends the wake through `build-01`, the state reads _"Waking… listening for
  win-lab"_, and at 20 s / 60 s either _"win-lab is back"_ or _"win-lab has not answered yet — it may
  be powered off or on another network"_; one audit row names both computers.
- **S8 — Refresh now.** **Given** `build-01` has a connected link (any of `--work`, `--attend`,
  `--manage` opens one; a refresh needs no consent beyond the link — CONTRACTS R-31), **when** the
  owner presses **Refresh now**, **then** a fresh snapshot replaces the cards within 3 seconds and
  "checked just now" appears; the next scheduled beat is unaffected.
- **S9 — An Agent reads health.** **Given** an Agent with a read-only health tool, **when** it asks
  for `build-01`, **then** it gets the same snapshot and state sentence the page shows, with the
  time of the snapshot, and nothing it would need a consent for.
- **S10 — Consent missing is an item.** **Given** `win-lab` was enrolled with no `--work`, `--attend`
  or `--manage`, **when** the hub renders, **then** an `info` item reads _"win-lab only reports
  health. Start it with --work, --attend or --manage to do more."_ with the command.

### 3.2 Edge cases and failures

- **U1 — Offline.** Cards show the last snapshot dimmed with "last checked 2 h ago — values are
  stale"; Refresh now is disabled with _"build-01 is offline"_; Wake is offered when possible.
- **U2 — No link (no consent beyond enrolment).** Refresh now reads _"Refresh needs a link — start
  build-01 with --work, --attend or --manage · next automatic check in 42 s"_ with the command; the
  countdown is real; a direct call returns `consent_missing` with that hint.
- **U3 — Link drop mid-refresh.** The request answers `unreachable`; the cards keep the last
  snapshot; the button offers **Try again**.
- **U4 — Permission denied.** A member outside the `machines` family sees Wake disabled with the
  audience named; Refresh now follows the `view` family (CONTRACTS §2.1), so anyone who can see the
  computer can refresh it; a direct wake call returns `permission_denied` with the hint _"ask the
  owner of build-01 to allow org admins: lifecycle"_.
- **U5 — Kill switch.** Refresh now and Wake are refused with `kill_switch`; the heartbeat keeps
  arriving and the cards keep updating — the switch stops actions, not observation.
- **U6 — Nothing to wake with.** No online sibling on the same network, or no known hardware
  address: Wake is disabled with _"No online computer on win-lab's network can wake it"_ or
  _"win-lab has not reported a hardware address yet"_; a direct call returns `unsupported_on_node`.
- **U7 — Wake rate.** More than 3 wake attempts for one computer in 5 minutes → `limit_exceeded`
  and _"Already tried 3 times; give it a minute"_.
- **U8 — Partial snapshot.** A probe fails on the machine (no `systemctl`, unreadable GPU): the
  field is absent, the card reads "—" for it, every other card renders, the beat is accepted.
- **U9 — Platform older than the node.** The heartbeat with `health` is rejected; the node retries
  without the newest tier and keeps reporting what the platform understands.
- **U10 — History flag off.** Cards and metric cards still show the snapshot; the chart renders
  _"History is switched off on this deployment"_; no sample rows are written.
- **U11 — Storage pressure.** Samples are written through one bounded writer; a write failure is
  logged once per node per hour and never fails the heartbeat.
- **U12 — Clock skew.** The sample time is the platform's receipt time, never the machine's clock;
  uptime is a duration, not a boot instant.
- **U13 — Throttled by a resource ceiling.** State reads _"Pausing new work — CPU is above its
  ceiling (92% of 85%)"_ with **Change limits** (the existing limits section) and no clear button.
- **U14 — A producer throws.** The other producers' items still render (FL-01 U11); the failure is
  logged with the producer id.

---

## 4. Functional requirements

### 4.1 P1 — Snapshot

- **FR-1** Every heartbeat from a node of this version MUST carry a health snapshot with CPU
  percent, memory percent and total, disk percent and free bytes, one-minute load, uptime seconds,
  pending-reboot and failed-service count, each optional and absent when its probe failed.
- **FR-2** The snapshot MUST include the GPU vendor, model and, when readable, utilisation and
  memory, and MUST be absent when no GPU is present.
- **FR-3** The snapshot MUST travel in the newest optional heartbeat tier so an older platform
  rejecting it costs only that tier.
- **FR-4** The platform MUST store the latest snapshot on the computer row stamped with its own
  receipt time, and MUST never derive a value the node did not send.
- **FR-5** Every list and card MUST read the snapshot from the row, and MUST show "—" for an absent
  value and a stale marker for a snapshot older than the computer's offline threshold.
- **FR-6** A node probe MUST never fail a heartbeat and MUST complete within 2 seconds or be
  dropped for that beat.

### 4.2 P1 — States and fix actions

- **FR-7** The system MUST map a computer to exactly one plain-language state from a closed set:
  `online · busy · offline · enrolling · paused · disabled · draining · quarantined · throttled ·
  limited · upgrade-required`, where `limited` is a model usage-limit throttle and `throttled` a
  resource one.
- **FR-8** Each state MUST have a sentence and at most one fix action: `offline` → Wake when
  possible; `quarantined` → the exact machine command; `limited` → Clear limit now with the reset
  time; `throttled` → Change limits; `upgrade-required` → the upgrade command; others none.
- **FR-9** The state word MUST appear beside the dot on cards, the computer header and the
  Computers table, never colour alone.
- **FR-10** Clear limit now MUST call the existing clear, MUST require the `machines` family, and
  MUST write the existing audit row.
- **FR-11** The reset time of a usage limit MUST be shown in the viewer's time zone with the
  machine's zone in a tooltip.

### 4.3 P1 — "Needs a look" producers

- **FR-12** The system MUST produce `disk-low` as `critical` when free disk is at or below the
  node's own floor plus 1 GiB, as `warn` when free disk is below 10% of the volume, and not
  otherwise.
- **FR-13** The system MUST produce `node-throttled` (`warn`) for `throttled` and `limited`
  computers, with the reason and, for `limited`, the clear action.
- **FR-14** The system MUST produce `node-quarantined` (`critical`) with the machine command as
  the action.
- **FR-15** The system MUST produce `consent-missing` (`info`) for a computer whose consents are
  all off, with the start command.
- **FR-16** The system MUST produce `helper-untrusted` (`warn`) when a computer reports a
  hash-pinned screen helper, and MUST produce nothing while that field is absent.
- **FR-17** Each item MUST be stable across renders for the same condition (same id, same `since`)
  so FL-01 can dedupe and sort.

### 4.4 P2 — History

- **FR-18** With `FLEET_HEALTH_HISTORY_ENABLED` on, the platform MUST store one sample per
  accepted heartbeat carrying a snapshot, at most one per computer per 55 seconds.
- **FR-19** Raw samples MUST be kept 7 days; an hourly roll-up (the mean of each CONTRACTS §4.5
  column, `resolution: hourly` in the same table) MUST be kept 90 days; a scheduled sweep MUST delete
  beyond those windows, never a read. (Hourly peaks wait on the §8b CONTRACTS question.)
- **FR-20** The history endpoint MUST answer 1 h and 24 h from raw samples and 7 d and 90 d from
  roll-ups, each in at most 500 points, with gaps preserved.
- **FR-21** The chart MUST render CPU, memory and disk lines with offline gaps, and the card
  sparkline MUST render the last hour of CPU.
- **FR-22** With the flag off, no sample MUST be written and the chart MUST say history is off.

### 4.5 P3 — Reach

- **FR-23** A node with `--manage` MUST report its primary hardware address and an opaque network
  identity so siblings on the same network can be matched without storing addresses.
- **FR-24** Wake MUST be offered only when the target is offline, has a hardware address, and at
  least one online computer of the same owner shares its network identity and advertises `wake`.
- **FR-25** Wake MUST send the packet through the sibling over the link, MUST require the
  `machines` family on the target, MUST write one audit row naming target and sibling, and MUST be
  limited to 3 attempts per computer per 5 minutes.
- **FR-26** After a wake the platform MUST report at 20 s and 60 s whether the target has
  heartbeated.
- **FR-27** Refresh now MUST request a fresh snapshot over the link with `health.now`, MUST require
  only the `view` family and an open link — no consent beyond the link itself (CONTRACTS R-31,
  §2.1) — MUST answer within 3 seconds or `unreachable`, MUST answer `consent_missing` for a node that
  gave no consent able to open a link, and MUST replace the stored snapshot on success.
- **FR-28** Refresh now MUST NOT change the heartbeat cadence and MUST be limited to 10 per
  computer per minute.

### 4.6 Cost and honesty

- **FR-29** Health MUST spend no model tokens; the Overview tab MUST state the storage footprint
  of history in one line ("about 10 000 samples a week per computer").
- **FR-30** A stale snapshot MUST never be shown as current, and an inferred value MUST never be
  shown at all.

---

## 5. UX

### 5.1 Hub card (FL-01 card, FL-03 cells)

```
★ build-01    ● Online   Linux    cpu 31% ▁▂▃▅▃  mem 58%  disk 40%   checked 48 s ago
  win-lab     ○ Offline  Windows  —            —        —           last seen 2 h ago · can be woken
  build-02    ● Limited  Linux    cpu  4%      mem 21%  disk 77%    Claude Code limit resets Sun 03:00
```

### 5.2 Computer page — Overview tab, metric slot

```
┌ cpu 31% ─────┐ ┌ memory 58% ──────┐ ┌ disk 40% ───────────┐ ┌ gpu ───────────┐ ┌ load ─┐ ┌ services ─┐
│ ▁▂▃▅▃▂▃▂▃▅▆▃ │ │ 9.3 / 16 GiB     │ │ 118 GiB free        │ │ nvidia · RTX   │ │ 1.9   │ │ 1 failed  │
│ last hour     │ │                  │ │ node floor 5 GiB    │ │ 12% · 2/8 GiB  │ │ 4 cores│ │ [Services]│
└───────────────┘ └──────────────────┘ └─────────────────────┘ └────────────────┘ └───────┘ └───────────┘
Pending reboot: no · Checked 09:41:12 (48 s ago)                                     [ Refresh now ]
History is kept for 7 days by the minute and 90 days by the hour — about 10 000 samples a week per computer.
```

States of the slot: loading (skeleton ≤ 500 ms then "Loading health…"), no snapshot (_"This
node version does not report health. Upgrade it to see CPU, memory and more."_), stale (dimmed +
_"last checked 2 h ago — values are stale"_), offline (same + Wake), error (_"Could not load
health."_ **Try again**).

### 5.3 State sentences (header and cards)

| State            | Sentence                                                                  | Action                 |
| ---------------- | ------------------------------------------------------------------------- | ---------------------- |
| online           | Online                                                                    | —                      |
| busy             | Busy · 2 jobs                                                             | —                      |
| offline          | Offline · last seen 2 h ago                                               | Wake (when possible)   |
| enrolling        | Waiting for the first check-in                                            | —                      |
| paused           | Paused by you                                                             | Resume (FL-01 menu)    |
| disabled         | Disabled                                                                  | —                      |
| draining         | Finishing its jobs, taking no new ones                                    | Return to fleet        |
| quarantined      | Stopped itself: {reason}                                                  | copy `ever-works-node clear-quarantine` |
| throttled        | Pausing new work — {dimension} is above its ceiling ({value} of {limit})  | Change limits          |
| limited          | Waiting for {cli}'s limit to reset at {time}                              | Clear limit now        |
| upgrade-required | Upgrade required — takes no work until updated                            | copy upgrade command   |

### 5.4 Needs a look rows (FL-01 list)

- `disk-low` critical: _"Disk is 94% full · 6 GiB left, the node stops at 5 GiB"_ **Open**
- `disk-low` warn: _"Disk is 88% full · 9 GiB left"_ **Open**
- `node-throttled`: _"Waiting for Claude Code's limit to reset at Sun 03:00"_ **Clear limit now** /
  _"Pausing new work — memory is above its ceiling"_ **Change limits**
- `node-quarantined`: _"design-mac stopped itself: {reason}"_ **Show command**
- `consent-missing`: _"win-lab only reports health. Start it with --work, --attend or --manage to
  do more."_ **Show command**
- `helper-untrusted`: _"design-mac's screen helper runs with reduced trust"_ **Open**

### 5.5 Wake flow

```
[ Wake ]  →  "Waking… sent through build-01 · listening for win-lab"
   20 s   →  "win-lab has not answered yet"             60 s → "win-lab has not answered — it may be
   any    →  "win-lab is back · checked just now"               powered off or on another network"  [ Try again ]
```

Disabled variants: _"No online computer on win-lab's network can wake it"_ · _"win-lab has not
reported a hardware address yet"_ · _"Already tried 3 times; give it a minute"_.

### 5.6 Refresh now

Enabled: spinner on the button ≤ 3 s → cards update → _"checked just now"_. Disabled variants:
_"build-01 is offline"_ · _"Refresh needs a link — start build-01 with --work, --attend or
--manage · next automatic check in 42 s"_ `[copy]` · _"Live actions are paused while all computers
are stopped"_. (Refresh follows the `view` family, so a viewer who sees the card can refresh it.)

### 5.7 History chart

Range buttons `1 h · 24 h · 7 d · 90 d`; three toggles `cpu · memory · disk`; hover shows the
sample's time and values; offline gaps are breaks, not zeros; flag off → _"History is switched off
on this deployment."_; no data → _"No samples yet — the first one lands on the next check-in."_

### 5.8 Keyboard, palette, accessibility

`R` refresh now, `W` wake (when enabled) on a computer page; chart is a labelled region with a
text summary ("CPU averaged 31% over the last hour, peak 78% at 09:12") for assistive technology;
every state word is text; every disabled action carries its reason in a tooltip and `aria-describedby`.

---

## 6. Non-functional requirements

- **Performance:** snapshot probe ≤ 2 s on the node and ≤ 1% CPU; hub list reads one row per
  computer (no joins to history); history endpoint ≤ 300 ms at p95 for 90 d.
- **Reliability:** no probe failure or sample write failure ever fails a heartbeat; retention runs
  as a scheduled sweep with idempotent deletes.
- **Security & privacy:** health carries no hostnames, usernames, process names or addresses; the
  network identity is an opaque hash; hardware address stored only for the owner's own computers
  and never shown in full; wake and refresh are family-checked and kill-switch-gated.
- **Observability:** samples written / dropped counters; producer latency; wake attempts and
  outcomes; refresh latency.
- **Compatibility:** optional heartbeat fields in the newest tier; older nodes keep working with
  "—" cells; older platforms drop the tier.

---

## 7. Key entities & concepts

| Entity / concept        | New?            | Description                                                                                             |
| ----------------------- | --------------- | ------------------------------------------------------------------------------------------------------- |
| **Health snapshot**     | **NEW** (shape) | The per-beat facts; latest copy on the Node, one row per beat in history.                               |
| **Health sample**       | **NEW**         | One stored snapshot with its receipt time; raw for 7 days, hourly roll-up for 90.                       |
| **Computer state**      | **NEW** (derived) | One of the closed set in FR-7, with a sentence and a fix action; derived from status, worker state, throttles and the version floor. |
| **"Needs a look" producer** | **NEW** (registration) | Five producers registered with FL-01's registry.                                              |
| **Wake**                | **NEW** (action) | A wake packet sent through a sibling; audited; rate-limited.                                            |
| **Node**                | Existing        | Gains the latest snapshot, a hardware address, a network identity and the last wake attempt time.      |
| **Model throttle / worker state** | Existing | The week-old facts this epic turns into sentences.                                               |

**Acts this epic adds (rule 7).**

| Act               | Consent                         | Family / audience default | Confirmation | Audit (CONTRACTS §7)                    | Errors                                                                                   | Agent tool (FL-19 catalogue)          |
| ----------------- | ------------------------------- | ------------------------- | ------------ | --------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------- |
| Read health / history | — (heartbeat data)          | `view` / org-members      | `plain`      | — (read)                                | `not_found`, `invalid` (range)                                                           | `fleet_nodes_health` · readOnly       |
| Refresh now       | any open link (R-31)            | `view` / org-members      | `plain`      | — (read)                                | `unreachable`, `consent_missing` (no link possible), `kill_switch`, `limit_exceeded`     | `fleet_nodes_health` with `fresh: true` · readOnly |
| Wake              | `manage` on the sibling          | `machines` / owner (target) | `plain`    | `node.wake { target, via }`             | `unsupported_on_node`, `unreachable`, `kill_switch`, `limit_exceeded`, `permission_denied` | `fleet_nodes_wake` · destructive: false |
| Clear limit now   | — (platform state)              | `machines` / owner        | `plain`      | `node.model-throttle-clear` (existing)  | `permission_denied`, `not_found`                                                         | — (FL-19)                             |
| "Needs a look" list | —                             | `view` / org-members      | `plain`      | — (read)                                | —                                                                                        | `fleet_nodes_needs_a_look`, `fleet_status` · readOnly |

Kill switch (R-24): Refresh now and Wake are link requests and are refused `kill_switch`; the
heartbeat and every read keep working — the switch stops actions, not observation.

---

## 8. Out of scope

- Alerting beyond the "needs a look" list and the existing Inbox notices (no thresholds the owner
  edits; no email).
- Per-process CPU/memory (FL-09 Processes), service control (FL-09), log reading (FL-08).
- Power actions other than wake (power off/reboot) — not in CONTRACTS §7 for ordinary nodes; VMs
  and cloud computers get theirs in FL-16/17.
- Reading health from `k8s` rows (live-merged, never stored — README rule 18).
- Changing the heartbeat cadence (60 s stays).

## 8b. Open questions

- **Resolved** by CONTRACTS §4.5: one table, `fleet_node_health_samples`, with a `resolution`
  column `raw · hourly`; raw rows 7 days, hourly rows 90 days.
- **Resolved** by CONTRACTS §4.1 / §13: `macAddress`, `lanId` (the opaque network identity) and
  `lastWakeAttemptAt` — together with the `health` snapshot column — are slot
  `1796030100000-AddFleetNodeWakeFields`.
- **Resolved** by CONTRACTS R-31 / §2.1: `health.now` is allowed on any open link with no consent
  beyond the link itself and is a `view`-family read, so a `--work`-only computer can be refreshed
  (FR-27).
- `[NEEDS CLARIFICATION: The state word "Limited" (model usage limit) is new UI copy beside "Throttled" (resource ceiling); README §1 says a new word needs the owner's nod. It is a state label, not an entity. Default until answered: ship "Limited" for a model usage-limit throttle and "Throttled" for a resource ceiling, both mapping to the one `node-throttled` "needs a look" kind (CONTRACTS §4.6).]`
- `[NEEDS CLARIFICATION: Which disk-low rule applies when the owner switched the node's floor off (`minFreeDiskBytes = null`)? Default until answered: percentage rule only — `warn` below 10% free, no `critical`.]`
- **Resolved** by CONTRACTS §4.5 (rev 3): hourly rows carry `cpuMax`, `memMax`, `diskMax`; the `health` snapshot adds `cpuCores`, `memUsedMiB`, `diskTotalMiB` and a GPU list; §1.1 lists the heartbeat fields (`health`, `macAddress`, `lanId`); rates in §10.1.

---

## 9. Acceptance criteria

**P1**

- [ ] `ACC-FL03-01` (FR-1, FR-2, FR-3, FR-6) A node beat carries the snapshot in the newest tier; a
      platform rejecting it costs only that tier; a probe stub that hangs 3 s drops its field and the
      beat is accepted.
- [ ] `ACC-FL03-02` (FR-4, FR-5, FR-30) The row stores the snapshot with receipt time; a card for a
      node without one shows "—" and the version sentence; a 2 h-old snapshot is marked stale.
- [ ] `ACC-FL03-03` (FR-7, FR-8, FR-9) The state truth table (status × worker state × throttles ×
      version floor) yields the eleven states with their sentences and actions; the word is present
      beside every dot.
- [ ] `ACC-FL03-04` (FR-10, FR-11) Clear limit now calls the existing route, is refused outside the
      `machines` family, writes `node.model-throttle-clear`; the reset time shows in the viewer's zone.
- [ ] `ACC-FL03-05` (FR-12 … FR-17) Each producer fires exactly in its condition with its severity,
      action and a stable id; `helper-untrusted` never fires without the field.

**P2**

- [ ] `ACC-FL03-06` (FR-18, FR-22) With the flag on, one sample per beat (≥ 55 s apart) is written;
      with it off, none, and the chart says so.
- [ ] `ACC-FL03-07` (FR-19) The sweep deletes raw > 7 d and hourly > 90 d and is idempotent;
      hourly rows (`resolution: hourly`) carry the mean of each column.
- [ ] `ACC-FL03-08` (FR-20, FR-21) 1 h/24 h come from raw, 7 d/90 d from roll-ups, ≤ 500 points, gaps
      preserved; the chart and sparkline render them.

**P3**

- [ ] `ACC-FL03-09` (FR-23, FR-24) A `--manage` node reports hardware address and network identity;
      Wake is offered only with an offline target, an address and an online same-network sibling
      advertising `wake`.
- [ ] `ACC-FL03-10` (FR-25, FR-26) Wake goes through the sibling, writes one audit row with both
      computers, refuses the 4th attempt in 5 min, and reports at 20 s and 60 s.
- [ ] `ACC-FL03-11` (FR-27, FR-28) Refresh now returns a fresh snapshot within 3 s over a connected
      link opened by any consent (a `--work`-only node included) for any viewer in the `view`
      audience, `unreachable` when the link is down, `consent_missing` for an enrol-only node,
      `kill_switch` under the switch; the 11th in a minute is `limit_exceeded`; the cadence is
      unchanged.
- [ ] `ACC-FL03-12` (FR-29) The Overview tab carries the storage footprint sentence; no token is spent.

---

## 10. Constitution gates

- [x] **I — Plugin-first.** OS probes are node modules (D8), not integrations.
- [x] **II — Capability-driven.** No provider resolution.
- [x] **III — Source-of-truth repos.** Health is telemetry, not content.
- [x] **IV — Job runtime.** The roll-up and retention sweep run on the configured job runtime.
- [x] **V — Forward-only migrations.** Two additive migrations from the CONTRACTS §13 slots (the
      samples table; the wake fields plus the `health` snapshot column).
- [x] **VI — Tests.** Node probes, contracts, agent, API, web and e2e named in the plan.
- [x] **VII — Secrets.** No secret; addresses hashed or masked; nothing logged from a probe.
- [x] **VIII — Plugin counts.** No plugin.
- [x] **IX — Behaviour-first.** No class, file or endpoint here.
- [x] **X — Backwards compatibility.** Optional heartbeat fields; existing columns and routes untouched.

---

## 11. References

- Program: [Fleet README](../README.md) D2, D8 · [CONTRACTS](../CONTRACTS.md) R-23, R-24, R-31;
  §1.2 (`wake`), §2.1 (`health.now` → `view`), §3.3 (`health.now`, `wake.send`), §4.1, §4.5, §4.6,
  §7 (`node.wake`), §8, §9, §10, §11.2, §13 ·
  [Capability map](../CAPABILITY-MAP.md) rows A "Health", "Machine states", "Needs a look", "Wake on
  LAN", "Machine checks on an interval"
- Plan: [`./plan.md`](./plan.md) · Tasks: [`./tasks.md`](./tasks.md)
- Related epics: FL-01 (renderer, states on cards), FL-02 (`machine` channel), FL-07 (helper trust),
  FL-09 (services detail), FL-17 (cloud idle producer).
- Existing docs: `docs/features/fleet.md` §"Health signals", §"Remote node limits".
