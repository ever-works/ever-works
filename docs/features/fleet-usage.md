---
id: fleet-usage
title: Usage and cost on your Fleet
sidebar_label: Usage and cost
description: See what the Claude Code and Codex work on your own computers would cost at list price — per session, per Run, per computer — from an opt-in scan that reads token counts only.
---

# Usage and cost on your Fleet

Agents and people run Claude Code and Codex on your computers with **the sign-in on each machine**, so Ever Works
never sees that bill. With the machine owner's opt-in, the node on that computer reads the CLIs' own records — token
counts, the model, the session id, never a prompt or an answer — and reports them. Ever Works attributes them to the
**session** (and so to its **Run**, the **Agent's Budget** and the **computer**) and prices them at **list price**: what
the same tokens would cost on a pay-as-you-go key.

:::info Status: shipped behind a flag

Usage on the Fleet ships behind `FLEET_USAGE_SCAN_ENABLED` (default off), on top of `FLEET_ENABLED`. With it off every
`/api/fleet/usage` route answers 404, no scan is asked for, a report that still arrives is not stored, and the cost
chip, the receipt line and the computer page's usage line are hidden.

:::

Every surface that shows one of these figures says, in one sentence:

> List price — what this would cost on a pay-as-you-go key. The machine's own sign-in paid for it; Ever Works charged
> nothing.

This is attribution and honesty, never billing: no credit is debited for fleet work.

## Switch it on for a computer

The scan is the machine owner's decision, made on the machine:

```bash
ever-works-node start --usage-scan        # alongside --work / --attend / --manage as you like
```

`--usage-scan` is a consent of its own (`consents.usageScan` on every heartbeat): `--manage` does not include it, and
the dashboard can never switch it on. While it is on, and a Claude Code or Codex record folder exists on the machine,
the node advertises the `usage-scan` capability. `ever-works-node status` shows the state:

```text
usage scan   on — reads token counts, models and session ids from Claude Code and Codex records; never prompts, output or file contents
```

Stop the node and start it without the flag to switch it off; the numbers already reported stay.

## What is read, and what never is

The scan reads only:

- Claude Code transcripts under `<config home>/projects` — `~/.claude` and `$CLAUDE_CONFIG_DIR` when set (Windows:
  `%USERPROFILE%\.claude`);
- Codex rollouts under `<codex home>/sessions` — `~/.codex` and `$CODEX_HOME` when set.

From each record it keeps **only**: the model id, the token counts by class (input, output, cache read, cache write),
the time, the CLI's own session id and the working folder. Prompts, answers, tool input and output, reasoning and
file contents are never kept or sent. The working folder leaves the machine only as the **known checkout or shared
folder** that contains it; any other folder is sent as an opaque `other:<hash>` bucket.

The scan never follows a link out of those folders, never writes to a record file, and skips a line longer than
1 MiB without reading it. Its own state (how far each file was read, the counted record ids, the hourly totals) lives
in `usage/state.json` beside the node's config, readable by the node's user only.

## How it is counted

- **Every 15 minutes** the platform asks each opted-in, online computer for one scan (a `usage-scan` job on the node's
  management lane — it never takes an Agent's `--concurrency` slot). The owner can also ask for one from the API
  (`POST /api/fleet/usage/rescan`).
- **Each record is counted once.** Re-reading the same files, a resumed session copying old lines, or a lost
  acknowledgement never double counts; deleting a record file never subtracts.
- A report carries **hourly totals** per session, model and folder, at most 500 rows; a big first scan (a year of
  records) catches up over several scans — the computer shows _catching up · 42 % scanned_ meanwhile.
- Records are bucketed by **their own** time, not the time of the scan.

## Where the numbers show up

- **Session card** — a chip `$0.42 · list` (the tooltip is the sentence above), or `tokens only · <model>` when the
  model has no list price.
- **Session detail** — `GET /api/fleet/sessions/:id` carries `tokens` (by model and class, requests, first and last
  activity), `costCents` and `priceListVersion`.
- **Run receipt** — a line in the cost block: _Model work on build-01 · $0.42 at list price (v1) · 61 k in · 9 k out ·
  212 k cache_, then the sentence.
- **Run cost and Budgets** — the Run's `costCents` includes it, and the Agent's Budget sees it through one
  non-debiting usage row per Run (`fleet-node:claude-code` / `fleet-node:codex`), exactly like a headless fleet run's
  own reported cost. When a headless run already reported a cost for the same session, only the difference is added.
- **Computer page** — the Overview's usage line: _Usage 7 d · $22.10 · scan on · last scan 4 min ago_, or the opt-in
  command when the scan is off, or _update the node_ when it is too old.
- **Agent tool, MCP, CLI** — `fleet_usage_get { days?, node?, model? }` and `ever-works fleet usage [--days 1|7|30|90]
[--on <computer>] [--model <id>] [--json]` return the same object, read-only, with the sentence in `note`.

## The Usage tab

**Fleet → Usage** answers "where did the month go?" for every computer you may see: **Today, 7, 30 or 90 days**
(keys `1`–`4`), then

- the totals line — cost at list price, tokens, requests and the top model — with the sentence above right beneath it,
  and _excludes N requests on unknown models_ when some model has no list price;
- **By model** and **By computer** — click a model or a computer to filter the tab to it. Each computer shows its last
  scan (_scanned 4 min ago_); an **offline** one keeps its numbers and its age (_offline · scanned 2 d ago_); one with
  the scan off shows the opt-in command instead of numbers. The owner can ask an online computer to **Scan now**;
- **Busiest checkouts** — the known checkouts and shared folders that cost most (_other folders_ for the rest), each
  opening the computer's Checkouts tab;
- **Sessions** — per Agent, your own sessions, and **other (not started from Ever Works)**;
- _catching up · 42 % scanned on build-01_ while a first scan drains a large backlog.

With no computer reporting yet the tab says so, with the command and what the scan reads. The palette has **Fleet
usage** and **Usage on <computer>**.

### Export and the price list

- **Export CSV** on the tab downloads what is on screen — one row per model, computer, busiest checkout and Agent,
  a total and the sentence above as the last row; an unknown model's price cell is empty, never 0. The CLI prints the
  same text with `ever-works fleet usage --csv`.
- **Price list** at the foot of the tab lists every published version with the date it took effect and the per-model
  rates of the one in effect (per million tokens: input, output, cache read, cache write). When a period mixes
  versions the tab says so — _priced at model list prices v1; v2 in effect since …_.

## In your digest

With a daily or weekly digest switched on, a **Your computers** section says what your machines ran in the window —
_Your machines ran $4.20 of model work yesterday at list price · 212 requests on 2 computers_ — with the sentence
above. It never makes a quiet digest send on its own.

## On the Agent's Budgets tab and the schedule rows

- An Agent's **Budgets** tab lists, per computer, what its sessions and Task runs there would cost over the last 30
  days at list price. The Budget figure above it already includes that work (the non-debiting rows described above);
  the rows say where it came from.
- On a computer's **Schedules** tab, an Agent-session schedule (a pinned recurring Task) shows _last run $0.42 · 30 d
  $6.10 · list_ (`GET /api/fleet/usage/tasks?ids=…`, your own Runs only).

## Sessions not started from Ever Works

A session someone opened at the computer's keyboard has no Ever Works session or Run. Its tokens are kept as
**other** on that computer: counted in the computer's totals, never turned into a Run, never naming an Agent. If a
session with that CLI session id appears later (a late sync), it claims those tokens on the next report. Other
sessions are shown to the computer's **owner only**; an Organization member who may see the computer sees that
total as _not shown_.

## List prices

Prices come from a published, versioned per-model table (four rates per model: input, output, cache read, cache
write) — `GET /api/fleet/usage/prices` lists the version in effect and its history. Every stored figure keeps the
version it was priced at; a new version never re-prices old figures. A model the table does not know is shown in
**tokens only** and left out of every dollar total, with a note — it is never priced at $0.

The version in effect is **v2** (from 2026-10-27): v1's rates checked against Anthropic's and OpenAI's public pricing
pages on that date, with one correction — Claude Sonnet 5.5 cache reads at $0.10 per million tokens. Cache writes are
priced at the 5-minute rate (1.25 × input); Claude Haiku 5.5 at its rate for prompts up to 100 K tokens. OpenAI rates
are the Standard tier.

## Errors

| Code                  | When                                              | Hint                                                                         |
| --------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------- |
| `consent_missing`     | the computer's owner has not switched the scan on | ``Usage scan is off — run `ever-works-node start --usage-scan` on build-01`` |
| `unsupported_on_node` | the node is too old, or has no record folder      | update the node on that computer                                             |
| `unreachable`         | a rescan of an offline computer                   | the numbers shown are from its last scan                                     |
| `kill_switch`         | a rescan while the Fleet is stopped               | clear it under Settings → Fleet                                              |
| `permission_denied`   | a rescan by someone who is not the owner          | —                                                                            |
| `invalid`             | `days` is not 1, 7, 30 or 90                      | —                                                                            |

While the kill switch is on, nodes lease no jobs, so scans pause too; stored numbers stay visible with their age.
The scan itself writes no audit row — it only reads.

## Related

- [Budgets & Usage](./budgets-and-usage.md) — caps and where platform-made calls are counted.
- [Sessions on computers](./fleet-sessions.md) · [Fleet hub](./fleet-hub.md) · [Agent, MCP and CLI tools](./fleet-agent-tools.md)
