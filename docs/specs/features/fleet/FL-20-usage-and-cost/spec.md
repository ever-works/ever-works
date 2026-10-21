# FL-20 — Usage & cost on the fleet

> Behaviour-first spec per [Constitution Principle IX](https://github.com/ever-works/ever-works/blob/develop/.specify/memory/constitution.md#ix-specs-are-behaviour-first).
> No class names, no file paths, no code. Implementation lives in [plan.md](./plan.md).

**Epic ID:** `FL-20-usage-and-cost`
**Program:** [Fleet](../README.md) · Wave 2
**Branch:** `feat/fl-20-usage-and-cost`
**Status:** `Draft`
**Created:** 2026-10-18
**Last updated:** 2026-10-18
**Size:** M · **Blocked by:** FL-04 (sessions carry a provider session id), FL-01 (P2 only — the Usage tab route and registry) · **Related:** FL-05 (session card cost chip), FL-13 (scheduled Agent sessions), FL-14 (checkouts as folders), FL-19 (`fleet_usage_get`), AW-17 (price list, meters), AW-09 (Run receipts)
**Extends (existing Ever Works nouns):** Run (`costCents`) · Session · Node (UI: "Computer") · Budget · Usage · Checkout · Agent

---

## 0. TL;DR

Agents and people run Claude Code and Codex on the owner's computers using the sign-in on each
machine; the platform never sees the bill. With the machine owner's opt-in, the node reads the
CLIs' own transcript records on that computer — token counts, model, session id, never prompts or
output — and reports them. The platform attributes them to the Session (and so to the Run, the
Agent, the Budget and the computer), prices them at **list price** so the owner can see what the
work _would_ cost on a pay-as-you-go key, and shows the answer wherever money is spent: the session
card, the Run receipt, the schedule row, the computer page and a hub **Usage** tab. Sessions that
were started outside Ever Works appear as **other** on that computer and are never linked to a Run.

```
 FLEET HUB › Usage                           [Today] [7 days] [30 days] [90 days]      [FLEET_USAGE_SCAN_ENABLED]
 ──────────────────────────────────────────────────────────────────────────────────────────────────
 $41.20 at list price · 18.4 M tokens · 1 212 requests · top model claude-sonnet-4-5
 Prices are list prices — what this would cost on a pay-as-you-go key. Your machines' own sign-ins
 paid for it; Ever Works charged nothing.
 ┌ By model ──────────────────────────────┐ ┌ By computer ─────────────────────────────────────────┐
 │ claude-sonnet-4-5   912 req  $31.40     │ │ build-01     $22.10   scanned 4 min ago              │
 │ gpt-5-codex         300 req   $9.80     │ │ build-02     $14.90   scanned 6 min ago              │
 │ (unknown) local-7b   12 req  tokens only│ │ design-mac    $4.20   offline · last scan 2 d ago    │
 └────────────────────────────────────────┘ └──────────────────────────────────────────────────────┘
 Busiest checkouts   ~/code/api on build-01 $18.30 · ~/code/web on build-02 $9.10 · other folders $3.90
 Sessions            Nina 14 · Ops 6 · owner sessions 9 · other (not started from Ever Works) 7
```

| Phase  | Ships                                                                                                                                                                                                                                                                                           |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P1** | Node-side opt-in scan of Claude Code and Codex records, dedupe, attribution to Sessions by provider session id, tokens and list-price cost on the Session, roll-up into the Run (`costCents`), session card cost chip, Run receipt line, `fleet_usage_get` / CLI `fleet usage` for one computer |
| **P2** | Hub Usage tab (Today/7/30/90; totals, by model, by computer, busiest checkouts, "other" sessions); computer page Usage line; Budgets roll-up; schedule rows (FL-13); Agent page cost per computer                                                                                               |
| **P3** | Daily digest line ("your machines ran $4.20 of model work yesterday"); export; price list version history on the tab                                                                                                                                                                            |

---

## 1. Overview

Every Run in Ever Works already answers "what did it cost?" when the platform made the model calls
(AW-17). A Run that executed on the owner's own computer does not: the CLI on that machine spent
the machine owner's seat or key, and the platform received at best a cost summary the CLI printed
at the end of a headless run. Persistent sessions (FL-04) print nothing of the kind. This epic
closes that gap without ever moving a credential: the **machine** counts, the **platform**
attributes and prices.

The scan is **opt-in per computer** (a local switch the machine owner sets), **bounded** (counts
only; no prompt, no output, no file content), **deduplicated** (each provider record is counted
once across repeated scans), and **attributed by the CLI's own session id** — the same id FL-04
stores on the Session for resume. A matched record rolls into that Session's tokens and cost, then
into its Run, its Agent's Budget, its computer and the hub. An unmatched record — a session the
owner started at their keyboard, not through Ever Works — is kept as **other** on that computer so
the numbers are complete, but it never becomes a Run and never names an Agent.

Cost is **list price**: what the same tokens would cost on a pay-as-you-go key, from a published,
versioned table; a model the table does not know is shown in tokens only and never priced at zero.
Every surface that shows a fleet cost says so in one sentence, because a number that looks like a
charge but is not one is the kind of honesty bug this product refuses.

---

## 2. Why now

### 2.1 The user's question

> _"What did last night's run on build-01 actually cost — and how much are my machines burning this
> month?"_

### 2.2 What they do today, and why it does not answer the question

| To answer…                                         | Today…                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | What breaks                                                                                                                                                                          |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| "What did that fleet Run cost?"                    | Headless Task runs report tokens and a cost the CLI itself printed (`packages/contracts/src/fleet/fleet-jobs.types.ts:1021-1054` — `inputTokens`, `outputTokens`, `totalTokens`, `costCents`, `sessionId`).                                                                                                                                                                                                                                                                                                                                         | Only `-p` runs report; a persistent Agent session (FL-04) has no end-of-run summary; an owner session has no Run at all.                                                             |
| "Price it like the platform prices its own calls." | The credit price list prices `capability.operation` keys (`packages/agent/src/usage/credit-price-list.ts:16-27`); the model catalog carries per-1k input/output prices from external catalogs (`packages/agent/src/facades/model-catalog.ts:27-38`); plugins carry per-1k prices in their manifests (`docs/features/budgets-and-usage.md:104`).                                                                                                                                                                                                     | None of these is a per-model, per-token-class (input, output, cache read, cache write) list for the Claude Code and Codex model families; none is versioned for re-pricing.          |
| "Show it on the session."                          | The Run's `costCents` (`packages/agent/src/entities/agent-run.entity.ts:394`) and the per-call ledger (`plugin-usage-event.entity.ts:114-120`). A finished headless fleet Task run already writes one non-debiting ledger row (`pluginId: fleet-node:<provider>`, tagged with the Agent and Run) and stamps `costCents` from the CLI's own price (`apps/api/src/fleet/fleet-agent-task-reconciler.service.ts:1028-1100`; `packages/contracts/src/fleet/fleet-jobs.types.ts:1323-1332`), so Budgets (`agent-budget.entity.ts:28-30`) see that spend. | Only when the CLI printed a price: a Codex run (tokens, no price) stays unpriced; a persistent Agent session (FL-04) and an owner session write nothing, so Budgets cannot see them. |
| "Which machine, which folder?"                     | Nothing.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | The platform knows the Session's checkout (FL-04/14) but has no usage to join to it.                                                                                                 |

### 2.3 Why this epic is additive only

The Run keeps `costCents` as the one cost field; this epic fills it for fleet Runs. The Session
gains tokens and a cost (the columns CONTRACTS §4.2 reserves). The credit price list is untouched
— a separate **model list-price** table is read beside it. Budgets gain a source; no cap semantics
change. "Usage" stays the noun (Settings → Usage exists); the hub tab is a view over the fleet's
share of it.

---

## 3. User scenarios

### 3.1 Primary scenarios

- **S1 — Opt in on a computer.**
  **Given** the owner of `build-01` runs the node with `--usage-scan`,
  **when** the node next heartbeats,
  **then** the computer page's Overview shows _"Usage scan on · last scan 2 min ago"_, and the
  node's own `status` says what it reads and what it never reads: _"token counts, models and
  session ids from Claude Code and Codex records; never prompts, output or file contents"_.

- **S2 — A session gets its cost.**
  **Given** Nina ran an Agent session on `build-01` for forty minutes,
  **when** the next scan completes,
  **then** the session card shows a cost chip _"$0.42 · list"_, the session detail shows tokens by
  class and by model, the Run's receipt gains a line _"Model work on build-01 · $0.42 at list
  price · paid by the machine's own sign-in"_, and Nina's Budget for the period includes it.

- **S3 — A session nobody started from Ever Works.**
  **Given** the owner opened Claude Code at `build-01`'s keyboard yesterday,
  **when** the scan runs,
  **then** its tokens appear under **other (not started from Ever Works)** for `build-01`, no Run
  is created, no Agent is named, and the folder shows only when it is a known checkout.

- **S4 — Where the month went (P2).**
  **Given** three computers with the scan on,
  **when** the owner opens Fleet › Usage › 30 days,
  **then** they see the totals line, by model, by computer with the last-scan age, the busiest
  checkouts, and the sessions breakdown; an offline computer stays in the table with _"offline ·
  last scan 2 d ago"_ rather than vanishing.

- **S5 — A model the table does not know.**
  **Given** a session used a local model,
  **when** it appears,
  **then** every surface shows _"tokens only"_ for it, totals exclude it from the dollar figure and
  say _"excludes 12 requests on unknown models"_.

- **S6 — From a tool or the CLI.**
  **Given** Agent `Ops` or the signed-in owner,
  **when** `fleet_usage_get { days: 7, node: 'build-01' }` or `ever-works fleet usage --days 7 --on build-01 --json` is called,
  **then** the same object the tab renders is returned, read-only, with the list-price sentence in
  a `note` field.

### 3.2 Edge cases and failures

- **U1 — Not opted in.** The hub shows the computer with _"Usage scan is off — run
  `ever-works-node start --usage-scan` on build-01"_ and no numbers; the API answers
  `consent_missing` with that hint for a per-computer request.
- **U2 — Offline.** Stored numbers stay; the row says _"offline · last scan …"_; a manual rescan
  request returns `unreachable`.
- **U3 — Node too old.** `unsupported_on_node` with _"update the node on build-01"_.
- **U4 — Duplicate records.** Re-scanning the same files never double counts; a record is counted
  once by its provider identifiers.
- **U5 — Rotated or deleted records.** Counts already reported are kept; nothing is subtracted.
- **U6 — Isolated Agent homes.** Records written under the node's relocated CLI homes for Agent
  sessions are scanned and attributed like any other; owner sessions under the real home likewise.
- **U7 — Session id not found.** Tokens are kept as **other** with the provider session id so a
  later-created Session (a late sync) can claim them on the next roll-up.
- **U8 — Price list changes.** Existing figures keep their version and are not re-priced silently;
  the tab says _"priced at model list prices v3; v4 in effect since 12 Oct"_.
- **U9 — Kill switch.** Nodes lease no jobs while the switch is on (EXISTING-SUBSTRATE §2.7), so
  `usage-scan` jobs pause even though they are read-only; stored numbers stay visible with their
  scan age, and a manual rescan answers `kill_switch`.
- **U10 — Permission.** Organization members outside the computer's `view` audience see no
  numbers for it; the hub totals exclude what the viewer may not see and say so.
- **U11 — Huge backlog.** A first scan over a year of records reports in bounded batches across
  several scans; the tab shows _"catching up · 42 % scanned"_ meanwhile.
- **U12 — Clock skew.** Records are bucketed by the record's own timestamp, not the scan time.

---

## 4. Functional requirements

### 4.1 Consent and scope (P1)

- **FR-1** The scan MUST run only on a computer whose owner switched it on locally (`--usage-scan`,
  reported as `consents.usageScan` and the `usage-scan` tag — CONTRACTS §1.1, §1.2), and MUST be
  switchable off locally; the platform MUST show the state and MUST never switch it on remotely.
- **FR-2** The scan MUST read only Claude Code and Codex transcript records under the machine
  owner's CLI homes and under the node's own isolated session homes, and MUST extract only: model,
  token counts by class (input, output, cache read, cache write), request count, timestamps, the
  provider session id, and the working folder.
- **FR-3** The scan MUST NOT read, store or transmit prompt text, model output, tool output or file
  contents, and MUST transmit a folder only when it is a known checkout or allowed root; any other
  folder MUST be reported as an opaque bucket.
- **FR-4** Each provider record MUST be counted once across scans, keyed by the provider's own
  identifiers; a re-scan MUST never double count and MUST never subtract.

### 4.2 Attribution and pricing (P1)

- **FR-5** Tokens MUST be attributed to a Session whose provider session id matches; a matched
  Session's tokens and cost MUST roll into its Run (`costCents`) when it has one, and the Run MUST
  show them like any other Run cost.
- **FR-6** Tokens with no matching Session MUST be kept as **other** on that computer with the
  provider session id, MUST never create a Run, MUST never name an Agent, and MAY be claimed by a
  Session created later.
- **FR-7** Cost MUST be computed at list price from a published, versioned per-model table with
  separate rates for the four token classes; every stored figure MUST carry the version used.
- **FR-8** A model with no entry MUST be shown as tokens only and MUST be excluded from every
  dollar total with a visible note; it MUST NOT be priced at zero.
- **FR-9** Every surface that shows a fleet cost MUST carry the sentence: _"List price — what this
  would cost on a pay-as-you-go key. The machine's own sign-in paid for it; Ever Works charged
  nothing."_

### 4.3 Surfaces (P1 card and receipt; P2 tab and roll-ups)

- **FR-10** The session card MUST show a cost chip when a cost is known, with tokens-only wording
  otherwise (R-22 anatomy).
- **FR-11** The Run receipt MUST gain a line for model work on a computer, naming the computer,
  the list-price cost and the payer sentence.
- **FR-12** The hub Usage tab MUST offer Today, 7, 30 and 90 days and MUST show totals (cost,
  tokens, requests, top model), by model, by computer with last-scan age, busiest checkouts, and
  the sessions breakdown including **other**.
- **FR-13** An offline computer MUST remain in the Usage tab with its last-scan age; a computer
  with the scan off MUST appear with the opt-in hint and no numbers.
- **FR-14** The computer page Overview MUST show the 7-day cost and scan state; the Agent page MUST
  show the Agent's fleet cost per computer for the period.
- **FR-15** Agent Budgets MUST include attributed fleet cost for the Agent's Runs in the period,
  labelled as list-price fleet work, and a cap crossing caused by it MUST behave as any cap
  crossing does.
- **FR-16** Schedule rows for Agent-session schedules (FL-13) MUST show the last run's cost and the
  30-day total from this attribution.

### 4.4 Access, errors, tools (P1)

- **FR-17** Usage for a computer MUST be visible to its `view` audience; totals MUST exclude what
  the viewer may not see and MUST say so.
- **FR-18** Requests MUST return `consent_missing` (scan off, with the exact command),
  `unreachable` (manual rescan on an offline computer), `unsupported_on_node`, `permission_denied`,
  or `kill_switch` with CONTRACTS §8 hints.
- **FR-19** `fleet_usage_get` MUST be a read-only tool and `ever-works fleet usage` a read-only
  verb, both returning the tab's object with the FR-9 sentence in a `note` field.
- **FR-20** Switching the scan on or off on a machine MUST be reflected in the computer's audit as
  a consent change; the scan itself, being read-only, MUST write no audit rows.

---

## 5. UX

### 5.1 Hub › Usage — loaded

Shown in §0. Period segmented control; totals line; the FR-9 sentence directly beneath it; two
cards (by model, by computer); busiest checkouts; sessions breakdown. FL-17 mounts its **Cloud
computers** block (FL-17 FR-23) below them; its money is provider list price for machines, kept
separate from this model-work total. Clicking a computer filters
the tab to it; clicking a model filters by model; clicking a checkout opens it (FL-14).

### 5.2 States

- **Empty (no computer opted in):** _"No computer is reporting usage yet"_ with the opt-in command
  and the one-sentence promise of what is and is not read.
- **Loading:** skeleton totals and two skeleton cards.
- **Catching up:** a thin progress line _"catching up · 42 % scanned on build-01"_.
- **Unavailable with reason:** flag off → tab hidden; kill switch → FL-01 banner, numbers still shown
  with their scan age.
- **Error:** inline with code and hint; a per-computer error never blanks the others.

### 5.3 Session card chip and session detail

Chip: `$0.42 · list` (tooltip = the FR-9 sentence) or `tokens only` with the model named. Detail:
a small table by model × token class, requests, first and last activity, and the price-list
version.

### 5.4 Run receipt line (AW-09 Cost block)

```
│  COST                                                                               │
│  Model work on build-01 · $0.42 at list price (v3) · 61 k in · 9 k out · 212 k cache │
│  List price — what this would cost on a pay-as-you-go key. The machine's own sign-in │
│  paid for it; Ever Works charged nothing.                                            │
```

### 5.5 Computer page and Agent page

Computer Overview: _"Usage 7 d · $22.10 · scan on · last scan 4 min ago"_ linking to the tab
filtered to it. Agent page (Budgets tab): a row per computer with the period's cost.

### 5.6 Keyboard and palette

`1 · 2 · 3 · 4` switch periods on the tab; palette _"Fleet usage"_ and _"Usage on <computer>"_.

---

## 6. Non-functional requirements

- **Performance:** a scan of 10 000 records completes in ≤ 30 s on the node with ≤ 150 MB
  memory, streaming line by line; the tab renders in ≤ 600 ms p95 for 90 days over 20 computers.
- **Reliability:** reports are idempotent (dedupe key per record); a lost report is re-sent on the
  next scan from the last acknowledged watermark.
- **Security & privacy:** counts only; folders only when known; no credential, prompt or output
  ever leaves the machine; the scan runs as the node's user and reads only what that user can read.
- **Observability:** metrics for records scanned, deduplicated, attributed, other, unknown-model;
  scan duration; backlog percentage.
- **Compatibility:** older nodes simply never advertise the scan; the platform shows U3.

---

## 7. Key entities & concepts

| Entity / concept             | New?                          | Description                                                                                                                                     |
| ---------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **Session** (`FleetSession`) | FL-04                         | Gains tokens by class and model, a list-price cost and the price-list version.                                                                  |
| **Run**                      | Existing                      | `costCents` filled for fleet Runs from the Session.                                                                                             |
| **Usage sample**             | **NEW** (P2; CONTRACTS §4.10) | One computer's tokens for one model in one hour, attributed to a Session or to **other**, with the checkout it ran in (none for other folders). |
| **Model list price**         | **NEW**                       | A published, versioned per-model table of list rates for four token classes; read-only in the product.                                          |
| **Budget**                   | Existing                      | Includes attributed fleet cost for the Agent's Runs, labelled as list price.                                                                    |
| **Node / Computer**          | Existing                      | Shows the scan opt-in (`consents.usageScan`, CONTRACTS §1.1) and the last-scan time (its newest scan job); no new column.                       |

---

## 8. Out of scope

- Reading real invoices or subscription usage from any provider account (no provider credential
  is ever held — README D6; CAPABILITY-MAP G "account switching" refused).
- Other CLIs' records (only Claude Code and Codex in this epic).
- Charging or debiting credits for fleet work; this is attribution and honesty, never billing.
- Re-pricing history when the list changes (figures keep their version).
- A preview-tunnel block on the Usage tab — open tunnels are listed and closed on the Ports tab and
  through the tools (FL-10 FR-27); the Usage tab carries model work and FL-17's cloud block only.

## 8b. Open questions

- **Resolved** by CONTRACTS R-30 and R-13: per-model list prices come from a new versioned port `MODEL_LIST_PRICES` (model × token class → price) owned by this epic; AW-17's `capability.operation` price list stays as it is; unknown models are counted in tokens only, never as $0. The model catalog's per-1k input/output rates remain this epic's fallback for input/output only (plan §3).
- **Resolved** by CONTRACTS §4.10 and §13: `fleet_usage_samples` (hourly `bucketStart`) under slot `1796200100000-CreateFleetUsageSamples`; P2 is not blocked.
- **Resolved** by CONTRACTS §1.1 and §1.2: the opt-in is the `usageScan` consent (`--usage-scan`, reported in every heartbeat) and the `usage-scan` capability tag the `usage-scan` job requires; R-34's management lane leases the job.
- **Resolved** by existing code (no CONTRACTS change): Budgets include fleet cost the way headless fleet Task runs already do — one non-debiting `plugin_usage_events` row per attributed Run through `PluginUsageService.record` with `pluginId: fleet-node:<provider>` and the Agent, Run and Task tags (`apps/api/src/fleet/fleet-agent-task-reconciler.service.ts:1028-1100`), which the Agent budget aggregator already sums. Where a headless run already wrote a row for the same provider session, the scan writes only the difference (plan §10), so nothing is counted twice and no credit is ever debited (FR-15).
- `[NEEDS CLARIFICATION: Should "other" sessions (not started from Ever Works) be visible to Organization members in the computer's view audience, or only to the machine owner? Default until answered: owner only; members see that total as "not shown" (FR-17).]`

---

## 9. Acceptance criteria

- [ ] **ACC-FL20-01** (FR-1, S1, U1) A node without the local switch advertises nothing and the hub shows the opt-in hint; with it, the computer page shows the scan state.
- [ ] **ACC-FL20-02** (FR-2, FR-3) A fixture record set with prompts and outputs yields a report containing only the allowed fields; an unknown folder is an opaque bucket.
- [ ] **ACC-FL20-03** (FR-4, U4, U5) Scanning the same fixtures twice, then with a file deleted, yields identical totals.
- [ ] **ACC-FL20-04** (FR-5, S2) A Session with a matching provider session id gains tokens and cost; its Run's `costCents` equals the Session's.
- [ ] **ACC-FL20-05** (FR-6, S3, U7) An unmatched record becomes "other" with no Run and no Agent; a later Session with that id claims it.
- [ ] **ACC-FL20-06** (FR-7, FR-8, S5, U8) Cost uses four class rates and stores the version; an unknown model is tokens-only and excluded from totals with the note.
- [ ] **ACC-FL20-07** (FR-9) The payer sentence appears verbatim on the card tooltip, the receipt, the tab and the tool's `note`.
- [ ] **ACC-FL20-08** (FR-10, FR-11) Card chip and receipt line render for a priced Session; tokens-only wording otherwise.
- [ ] **ACC-FL20-09** (FR-12, FR-13, S4, U2) The tab shows all four periods and all five blocks; an offline computer stays with its scan age.
- [ ] **ACC-FL20-10** (FR-14) Computer Overview and Agent Budgets tab show the period cost.
- [ ] **ACC-FL20-11** (FR-15) An Agent Budget crossing caused by fleet cost behaves as a normal crossing and is labelled list price.
- [ ] **ACC-FL20-12** (FR-16) An Agent-session schedule row shows last-run and 30-day cost.
- [ ] **ACC-FL20-13** (FR-17, U10) An Organization member outside a computer's `view` audience sees no numbers for it and the totals say what is excluded.
- [ ] **ACC-FL20-14** (FR-18, U3) Each error code is produced with its hint by a test.
- [ ] **ACC-FL20-15** (FR-19, S6) `fleet_usage_get` and `fleet usage --json` return the tab object with `note`.
- [ ] **ACC-FL20-16** (FR-20) Toggling the switch writes `node.consent.change`; a scan writes no audit row.
- [ ] **ACC-FL20-17** (U11) A 50 000-record backlog reports across several scans with the progress line visible.
- [ ] **ACC-FL20-18** All strings are i18n keys under `fleet.usage.*`.

---

## 10. Constitution gates

- [x] **I — Plugin-first.** No external service is called; records are local files read by a node module (D8). The model catalog fallback is an existing facade. Not applicable.
- [x] **II — Capability-driven.** No provider id hard-coded; the price table is read through a port.
- [x] **III — Source-of-truth repos.** Counts are metadata.
- [x] **IV — Job runtime.** The scan dispatcher is a job-runtime cron task; `usage-scan` is a leased node job (CONTRACTS §12).
- [x] **V — Forward-only migrations.** Slot `1796200000000-AddFleetSessionUsage` for the Session's `costCents` and `tokens` (CONTRACTS §4.2) and slot `1796200100000-CreateFleetUsageSamples` for the P2 table (CONTRACTS §4.10, §13).
- [x] **VI — Tests.** Fixture-driven scanner tests, attribution and pricing specs, Playwright for the tab.
- [x] **VII — Secrets.** No credential, prompt or output leaves the machine; only counts and ids.
- [x] **VIII — Plugin counts.** Not applicable.
- [x] **IX — Behaviour-first.** No code here.
- [x] **X — Backwards compatibility.** New columns, new tool, new tab; the credit price list is untouched.

---

## 11. References

- Program: [Fleet README](../README.md) D6, D8, rule 9 ("what did it cost?") · [CONTRACTS](../CONTRACTS.md) R-1, R-13, R-22, R-30, R-34, R-38; §1.1 `usageScan`; §1.2 `usage-scan`; §4.2; §4.10; §8; §9 `FLEET_USAGE_SCAN_ENABLED`; §11.1 `/fleet/usage`; §11.2 `/usage`; §12 `usage-scan`; §13 · [CAPABILITY-MAP](../CAPABILITY-MAP.md) G
- Plan: [`./plan.md`](./plan.md) · Tasks: [`./tasks.md`](./tasks.md)
- Related: [AW-17 Costs, caps and credits](../../agent-workspace/AW-17-costs-caps/spec.md) §4.2–4.3, §6.8, [AW-09 Runs & receipts](../../agent-workspace/AW-09-runs-receipts/spec.md), [FL-04](../FL-04-sessions-on-computers/), [FL-05](../FL-05-session-status-board/), [FL-13](../FL-13-schedules-on-computers/spec.md), [FL-19](../FL-19-agent-mcp-cli/spec.md)
- User docs: `docs/features/budgets-and-usage.md`
- Constitution: `.specify/memory/constitution.md`
