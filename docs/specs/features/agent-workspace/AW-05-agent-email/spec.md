# AW-05 — Agent email end to end

> Behaviour-first spec per [Constitution Principle IX](../../../../../.specify/memory/constitution.md#ix-specs-are-behaviour-first).
> **What** the system does for the user. No class names, no file paths, no code — those live in [`plan.md`](./plan.md).

**Epic ID**: `AW-05-agent-email`
**Program**: [Agent Workspace](../README.md)
**Branch**: `feat/aw-05-agent-email`
**Status**: `Draft`
**Size**: XL · **Depends on**: — (integrates with AW-03 My Decisions, AW-09 Runs & receipts, AW-13 Attention controls)
**Created**: 2026-09-06
**Last updated**: 2026-09-06
**Owner**: Product

> **Additive only (program rule #1, NN #20).** Nothing here removes or renames the operator
> message centre at `/inbox`, the tenant email-address registry, the provider plugins, the
> inbound webhook, the `sendEmail` / `messageAgent` agent tools, or the existing per-agent
> message list. Every state, filter, control and limit below is added on top.

---

## 1. Overview

An **Agent Inbox** gives an Agent a real, deliverable email address of its own — it sends and
receives as itself, and replies come back to the Agent that started the conversation instead of
to a person's mailbox. A new **Email** screen shows every Agent Inbox unified or one at a time,
groups messages into threads, and gives each message a visible state: **Received**, **Draft**,
**Scheduled**, **Sent**, **Escalated** or **Failed**. Outbound mail runs through an explicit
loop: the Agent writes a draft, the owner approves it (as-is, or after editing it inline, or
after sending it back to the Agent with notes), and only then does it leave. Anything the Agent
refuses to answer becomes an **Escalation** that lands in **My Decisions** with a Dismiss and an
Instruct path. A send can be scheduled for later and cancelled right up to the moment it fires.
Three layers of control sit under all of it: **standing instructions** per inbox (persuadable
prose), **allow/block rules** (deterministic, evaluated before the Agent ever sees inbound
content), and **send caps** (hard ceilings the platform enforces at send time, that no
instruction can talk past). A workspace can connect its own sending domain so inboxes send from
`nova@northwind.example.com` instead of the platform default, and removing the domain degrades
gracefully rather than breaking the inbox.

## 2. Why now

### 2.1 The user's question

> *"My Agent is supposed to be handling my supplier mail. Did it? What did it say? What is it
> about to say? And how do I stop it before it says something dumb?"*

Today an Ever Works owner cannot answer any of those four questions from the product.

### 2.2 What the platform has, and what it cannot do

Email exists in Ever Works, and a lot of it works well. Addresses are registered per tenant and
bound to a provider plugin; five provider plugins ship; inbound webhooks are
signature-verified against the *owning tenant's* secret; delivery events fold onto a message
row; per-agent conversation threading is implemented; outbound sends record a usage event; and
two independent IDOR fixes have already landed on the send path. The gap is not plumbing.

The gap is that **there is no loop, no ceiling, and no front door**:

| The owner wants to | Today | Consequence |
| --- | --- | --- |
| See their Agent's mail | `/agents/{id}/inbox` exists and works — but no tab, no route constant, and nothing anywhere links to it | The page is reachable only by typing the URL. In practice, invisible. |
| Give an Agent an address | Not possible from any surface. There is no API and no UI for the per-agent binding | The binding can only be created by writing a row to the database by hand. |
| Verify an address | The confirm-token endpoint is implemented and tested — but nothing ever transmits a token | An address can only become verified by an out-of-band call. |
| Read mail as conversations | The message list is a flat table of the last 50 rows, one row per message | A five-message thread reads as five unrelated rows. |
| Approve before sending | There is no pre-send state at all. `deliveryStatus` is post-send provider telemetry | An Agent with the send tool sends immediately. A human composing sends immediately. |
| Stop a runaway | Nothing. The compose/send endpoint carries no rate limit, no per-inbox cap, no per-workspace cap | One prompt-injected loop is an unbounded outbound mail cannon on the workspace's domain reputation. |
| Say who may write to it | Nothing. Every inbound message reaches the Agent's reasoning | Every internet sender has a direct line into an LLM prompt. |
| Send from their own domain | Nothing. One free-text `defaultSenderDomain` field exists in one plugin's settings and is read nowhere | Every Agent sends from a provider-shaped address. |
| Send later | Nothing | "Reply at 9am their time" is not expressible. |
| See what it cost | The send records a usage event, but no surface joins it back to the Run | Program rule #9 is unmet for the highest-frequency surface. |

### 2.3 What owners do instead today

They keep the Agent out of email. They read the mail themselves, paste it into an Agent chat,
copy the answer back into their own mail client, and send it under their own name. That
round-trip is the whole cost of the feature not existing: the Agent does the thinking, the human
does five minutes of clipboard work per message, the Agent learns nothing from the correction,
and no record ties the sent reply to the Run that wrote it.

### 2.4 The shape of the fix

```
   INBOUND                                            OUTBOUND
   ───────                                            ────────
   mail arrives                                       Agent writes
        │                                                  │
        ▼                                                  ▼
   ┌──────────────┐   blocked → dropped,             ┌───────────┐
   │ Rules        │   Agent never sees it            │  Draft    │──edit inline──┐
   │ (deterministic)                                 └───────────┘               │
   └──────┬───────┘                                       │  │  │                │
          │ allowed                              revise ──┘  │  └── discard      │
          ▼                                       (notes)    │                   │
   ┌──────────────┐                                  ▲       ▼                   │
   │ Thread       │──wakes a Run──► Agent            │  ┌───────────┐            │
   └──────────────┘                  │               └──│ Approve   │◄───────────┘
                                     │                  └─────┬─────┘
                    ┌────────────────┼───────────────┐        │
                    ▼                ▼               ▼        ▼
              handle → Draft   escalate → My     ignore   ┌─────────┐
                               Decisions                  │  CAPS   │ hard ceiling,
                                                          └────┬────┘ enforced here
                                                               │
                                                   ┌───────────┴──────────┐
                                                   ▼                      ▼
                                              Scheduled ──fires──►      Sent
                                              (cancel until it fires)
```

Layer one (standing instructions) is prose and therefore persuadable. Layer two (rules) is
deterministic and runs **upstream of the model**, so mail the Agent never reads cannot steer it.
Layer three (caps) is arithmetic in the send path and cannot be argued with. The ordering is the
design.

---

## 3. User scenarios

### 3.1 Primary scenarios

- **S1 — Give an Agent an address.**
  **Given** I own an Agent named *Nova* and my workspace has an email provider connection,
  **when** I open Nova's Inbox tab and press **Give Nova an address**,
  **then** the platform provisions `nova@northwind.agents.ever.works`, shows it on the page
  within 10 seconds, and the inbox opens in **Draft for review** mode with the shipped starter
  standing-instructions template pre-filled and the cap meter reading `0 / 100 in the last 24h`.

- **S2 — Inbound mail wakes the Agent and groups into a thread.**
  **Given** Nova's address is live and a supplier writes to it,
  **when** the message arrives,
  **then** it appears in the Email screen within 30 seconds under the **Received** filter as a
  thread with a `NEW` chip, a Run starts for Nova, and the thread row shows the message count and
  an attachment indicator if the mail carried attachments.

- **S3 — The draft-approve-send loop, approved as-is.**
  **Given** Nova has read that message and written a reply,
  **when** I open the thread,
  **then** the newest card carries a **Draft** badge and the controls **Approve & send**,
  **Revise with Nova** and **Discard**; pressing **Approve & send** shows a 5-second
  `Sending… Undo` toast, then sends, and the card flips to **Sent** with the recipient list, the
  time, and a link to the Run that wrote it.

- **S4 — Approve after an inline edit.**
  **Given** a Draft whose second paragraph is wrong,
  **when** I click into the body, fix the paragraph and press **Approve & send**,
  **then** what is sent is exactly what I edited, the message detail keeps both my version and
  the Agent's original under **Version history**, and — because *Learn from my edits* is on for
  this inbox — the platform offers the correction to Nova's Memory as a writing-style fact with
  a one-click **Don't learn this** on the confirmation toast.

- **S5 — Send it back to the Agent.**
  **Given** a Draft that is on-topic but the wrong length,
  **when** I press **Revise with Nova**, type `Too long. Three sentences, no pricing.` and submit,
  **then** the card moves to **Revising**, a Run starts, and within the same thread the Agent
  replaces the Draft with a new version; the notes and both versions stay in **Version history**.

- **S6 — Escalation.**
  **Given** Nova's standing instructions say to escalate anything about refunds outside policy,
  **when** a customer asks for a refund 40 days after purchase,
  **then** Nova sends nothing, the inbound card gains an **Escalated** badge with the Agent's
  stated reason, an item appears in **My Decisions** titled with the Agent's one-line summary,
  and the thread offers **Dismiss** and **Instruct Nova**; Instruct opens Nova's chat with the
  thread already referenced.

- **S7 — Scheduled send with cancel.**
  **Given** I ask Nova in chat to *"send this tomorrow at 9am the recipient's time"*,
  **when** the draft is approved,
  **then** the card shows **Scheduled** with the absolute local time, the recipient's timezone,
  a live countdown, and a **Cancel send** button; pressing Cancel any time before it fires
  returns the message to **Draft** and releases the reserved cap capacity.

- **S8 — Compose as an Agent.**
  **Given** I want to write something myself but from Nova's identity,
  **when** I press **Compose**, pick Nova as the sender and send,
  **then** the message goes out from Nova's address, appears in Nova's Sent filter, and counts
  against Nova's send cap exactly like an Agent-authored send.

- **S9 — Connect a sending domain.**
  **Given** I own `northwind.example.com`,
  **when** I add it under **Settings → Integrations → Email domains**,
  **then** the platform shows me the exact DNS records to publish with a copy button per record,
  rechecks every 15 minutes, and on success marks the domain **Verified**; I can then switch Nova
  to it and her address becomes `nova@northwind.example.com`.

- **S10 — Cap enforcement.**
  **Given** Nova's inbox has sent 100 messages in the last 24 hours,
  **when** anything — the Agent tool, my Compose, an approved Draft or a scheduled send — tries
  to send a 101st,
  **then** the send is refused with a message naming the limit and when it clears
  (`Nova's inbox has used 100 of 100 sends in the last 24 hours. Capacity returns at 14:05.`),
  the inbox shows a **Paused — cap reached** banner, and it resumes on its own as sends age out.

### 3.2 Edge cases, races, permission denials and empty states

- **S11 — Blocked sender.**
  **Given** a block rule for `@spam-domain.test`,
  **when** mail arrives from that domain,
  **then** nothing reaches the Agent — no thread, no Run, no tokens spent — and the drop is
  recorded in the Activity feed as `email blocked by rule` with the matched rule, visible under
  the inbox's **Rules** panel as `Blocked 14 messages in the last 7 days`.

- **S12 — Rule precedence conflict.**
  **Given** a workspace-wide block on `@riverbend.example.com` and an agent-scoped allow on
  `chen@riverbend.example.com`,
  **when** Chen writes to Nova,
  **then** the mail is delivered, because the agent-scoped exact-address allow wins, and the
  thread's rule chip reads `Allowed by an inbox rule`.

- **S13 — Cancel loses the race.**
  **Given** a Scheduled message whose countdown reads `00:00:01`,
  **when** I press **Cancel send** and the send has already started,
  **then** the button is refused with `Too late — this message already went out.`, the card is
  already **Sent**, and no duplicate is sent.

- **S14 — Two approvers race one draft.**
  **Given** two people with approval rights have the same Draft open,
  **when** both press **Approve & send**,
  **then** exactly one send happens; the loser sees
  `Sam Reyes already approved this — it went out at 10:42.` and the card refreshes to **Sent**.

- **S15 — A new inbound reply arrives while a Draft is pending.**
  **Given** a pending Draft on a thread,
  **when** the other party writes again before I approve,
  **then** the Draft is marked **Stale — the sender wrote again** with the new message shown
  above it, **Approve & send** requires a second confirmation, and **Revise with Nova** is
  offered as the recommended action.

- **S16 — Permission denied.**
  **Given** I am a read-only collaborator on Nova,
  **when** I open the Email screen,
  **then** I can read threads and message bodies but **Approve & send**, **Revise**, **Discard**,
  **Compose**, **Cancel send** and every settings control are disabled with the tooltip
  `You have read-only access to this inbox.`; calling the underlying action anyway is refused.

- **S17 — Bounce.**
  **Given** a Sent message to a dead address,
  **when** the provider reports a hard bounce,
  **then** the card gains a **Bounced** badge with the provider's reason text, and the thread
  shows `Delivery failed — the address does not exist.`; when one inbox records 3 bounces in
  24 hours the inbox is automatically switched back to **Draft for review** mode and the owner is
  told why.

- **S18 — Provider outage mid-send.**
  **Given** the provider returns a 5xx,
  **when** an approved Draft is sent,
  **then** the card shows **Failed to send** with the provider's message and a **Try again**
  button; the message does not silently disappear, does not consume cap capacity, and no
  duplicate is sent when the retry succeeds.

- **S19 — Domain removed while inboxes use it.**
  **Given** three inboxes send from `northwind.example.com`,
  **when** I remove the domain,
  **then** I first see `3 inboxes send from this domain. They will fall back to the default
  sending domain and keep receiving at their old address for 30 days.`; on confirm, sending
  continues from the platform default and no inbox breaks.

- **S20 — Empty states.**
  Every filter has its own empty state; nothing renders a bare "no results".
  Received → `Nothing new. Nova is watching this inbox.`
  Drafts → `No drafts waiting. Nova writes here when it has something for you to approve.`
  Escalations → `Nothing needs you.`
  Scheduled → `No scheduled sends.`
  Sent → `Nothing sent yet from this inbox.`
  Unread → `You are caught up.`
  No inbox at all → an inline provisioning card, not an empty list.

- **S21 — Over-limit and degraded states.**
  Cap reached → a banner, not an error page; the list still reads.
  Draft older than 14 days → auto-discarded with a `Discarded — nobody approved it for 14 days`
  notice on the thread, after a warning at day 7.
  More than 200 outstanding scheduled sends on one inbox → new scheduling is refused with
  `Nova already has 200 scheduled sends waiting. Cancel some first.`

- **S22 — The Agent has no address.**
  **Given** an Agent with no inbox,
  **when** its `sendEmail` tool is called,
  **then** the tool returns an actionable error the model can read
  (`This agent has no email inbox. Ask your owner to give it an address.`) rather than a stack
  trace, and the owner sees a Decision item offering one-click provisioning.

---

## 4. Functional requirements

Every default, limit, threshold and cadence below is a number, not an adjective.

### 4.1 Agent Inbox — identity and provisioning

- **FR-1** The system MUST let an owner provision an **Agent Inbox** for any Agent they own, in
  one action, from the Agent's Inbox tab and from the Email screen's inbox switcher.
- **FR-2** An Agent MUST have at most **1** Agent Inbox. A second provisioning attempt returns
  the existing inbox rather than an error.
- **FR-3** On provisioning the system MUST allocate a deliverable address of the form
  `<agent-slug>@<workspace-slug>.<platform mail domain>` (default platform mail domain
  `agents.ever.works`, operator-configurable), verify it is unique across the platform, and make
  it live for inbound and outbound within **10 seconds** of the request.
- **FR-4** The local part MUST be editable by the owner, constrained to `[a-z0-9]` plus `.`, `-`
  and `_`, **3–64** characters, and unique within its domain. Changing it MUST keep the previous
  address receiving as an alias for **30 days**.
- **FR-5** The system MUST retain at most **5** previous addresses per inbox as receiving
  aliases, expiring each **30 days** after it was replaced.
- **FR-6** An Agent Inbox MUST carry: an address, a sending domain, standing instructions, a
  mode, a send cap, a *learn from my edits* flag, an allow-list mode, and a set of rules.
- **FR-7** Deleting an Agent Inbox MUST stop inbound delivery immediately, cancel every
  outstanding scheduled send on it, leave every thread and message readable, and MUST NOT delete
  the Agent.
- **FR-8** Archiving or deleting an Agent MUST release its address after a **30-day** hold, during
  which the address cannot be reallocated to another Agent.
- **FR-9** An inbox address MUST be usable as the reply-to on every message the inbox sends, so
  that a reply lands back on the same Agent.

### 4.2 The Email screen — unified and per-inbox views

- **FR-10** The system MUST provide a top-level **Email** destination in the dashboard sidebar,
  carrying an unread badge that refreshes at least every **30 seconds**.
- **FR-11** The Email screen MUST offer an **All inboxes** view and a **single inbox** view,
  switchable from an inbox switcher that lists every Agent Inbox the viewer can read, each with
  its Agent's name, its address and its unread count, plus an `All` row with the total.
- **FR-12** The Email screen MUST offer exactly these six filters: **Received**, **Sent**,
  **Unread**, **Drafts**, **Escalations**, **Scheduled**. Filters are mutually exclusive and the
  active filter MUST be reflected in the URL so a view is shareable.
- **FR-13** Messages MUST be grouped into **threads**. A thread groups every inbound and outbound
  message of one conversation across statuses, keyed on the reply headers when present and on the
  normalized subject otherwise.
- **FR-14** A thread row MUST show, before it is opened: the owning Agent, the other party, the
  subject, relative time, the message count, an attachment indicator when any message in the
  thread has attachments, unread state, and the thread's most significant state badge (Escalated
  > Draft > Scheduled > Failed > Sent > Received).
- **FR-15** The thread view MUST show one card per message, newest last, each carrying its status
  badge, its sender and recipients, its timestamp and its attachment list; quoted history MUST be
  collapsed by default with an expand control.
- **FR-16** Every outbound card MUST link to the Run that produced it, and every Run receipt MUST
  link back to the messages it sent (program rule #9).
- **FR-17** Thread lists MUST be cursor-paginated at **50** threads per page and MUST return in
  under **800 ms** at P95 for a workspace with 50,000 messages.
- **FR-18** The system MUST support free-text search across subject, participants and body within
  the active view, scoped to the inboxes the viewer can read.
- **FR-19** Inbound message bodies MUST never be rendered as raw markup. HTML bodies are rendered
  sanitised, in an isolated frame, with remote images blocked behind a **Load images** control.
- **FR-20** New inbound mail MUST appear in an open Email screen within **30 seconds** without a
  manual refresh.

### 4.3 The draft loop

- **FR-21** An outbound message MUST occupy exactly one of these statuses at any time:
  `draft`, `revising`, `scheduled`, `sending`, `sent`, `failed`, `escalated`, `discarded`.
  Inbound messages occupy `received`.
- **FR-22** When an inbox is in **Draft for review** mode the system MUST NOT send any outbound
  message the inbox produces until a human with approval rights approves it. This MUST be
  enforced in the send path, not by instructions given to the model.
- **FR-23** Every draft MUST produce a pending **Approval** so it also appears in **My Decisions**;
  approving from either surface performs the same send exactly once.
- **FR-24** A draft thread MUST offer **Approve & send**, an **inline editor**, **Revise with
  <Agent>** and **Discard**.
- **FR-25** **Approve & send** MUST show a **5-second** `Sending… Undo` grace window. Undo within
  the window returns the message to `draft` and sends nothing. After the window the send is
  irreversible.
- **FR-26** Inline edits MUST be saved to the draft before sending, so what is sent is exactly
  what was on screen at approval.
- **FR-27** The system MUST keep the last **10** versions of a draft, each stamped with who or
  what produced it, viewable as **Version history**.
- **FR-28** When *Learn from my edits* is on (default **on**), an approved edit MUST offer the
  before/after pair to the Agent's Memory as a writing-style fact, with a **Don't learn this**
  control on the confirmation toast and a per-inbox off switch.
- **FR-29** **Revise with <Agent>** MUST accept up to **2,000** characters of notes, start a Run,
  and replace the draft in place. A draft may be revised at most **5** times; the sixth attempt
  offers only approve, edit or discard.
- **FR-30** A thread MUST have at most **1** pending draft at a time. An Agent attempting a second
  replaces the first, and the replaced version enters Version history.
- **FR-31** A draft unapproved for **7 days** MUST warn its owner; unapproved for **14 days** it
  MUST be auto-discarded with a visible notice on the thread.
- **FR-32** When new inbound mail arrives on a thread with a pending draft, the draft MUST be
  marked stale and **Approve & send** MUST require a second confirmation.
- **FR-33** Two concurrent approvals of the same draft MUST result in exactly one send; the
  loser MUST be told who approved it and when.
- **FR-34** A human MUST be able to compose and send as any Agent Inbox they can write to. Such a
  send counts against that inbox's caps identically to an Agent-authored send.

### 4.4 Escalations

- **FR-35** An Agent MUST be able to escalate an email instead of answering it, supplying a
  one-line summary (max **500** chars) and what the human needs to decide (max **1,000** chars).
- **FR-36** An escalation MUST suppress the reply: nothing is sent on that thread by the Agent
  while the escalation is open.
- **FR-37** An escalation MUST appear in **My Decisions**, in the Email screen's **Escalations**
  filter, and as an **Escalated** badge on the thread.
- **FR-38** An escalation MUST offer **Dismiss** (resolve, send nothing) and **Instruct <Agent>**
  (open the Agent's chat with the thread referenced and the escalation resolved on first reply).
- **FR-39** Resolving an escalation from **My Decisions** MUST clear it on the Email screen and
  vice versa, within one refresh.
- **FR-40** An escalation MUST record which inbound message triggered it and which Run raised it.

### 4.5 Scheduled sends

- **FR-41** An approved outbound message MUST be schedulable for a future time, expressible by the
  Agent in natural language including a recipient-relative timezone, and by a human via a
  date/time picker with an explicit timezone selector.
- **FR-42** The minimum lead time MUST be **60 seconds** and the maximum horizon **90 days**.
- **FR-43** A scheduled message MUST show a live countdown, the absolute send time in the viewer's
  timezone, and the recipient timezone when one was used.
- **FR-44** **Cancel send** MUST work up to the instant the send starts. After that it MUST be
  refused with `Too late — this message already went out.`
- **FR-45** Cancelling MUST return the message to `draft` and release its reserved cap capacity.
- **FR-46** A scheduled send MUST reserve **1** unit of the inbox's rolling-24h allowance from the
  moment it is scheduled until it fires or is cancelled, so a future burst cannot over-commit the
  window.
- **FR-47** An inbox MUST hold at most **200** outstanding scheduled sends. The 201st is refused
  with a message naming the limit.
- **FR-48** A scheduled send that fires while the inbox is cap-paused MUST NOT be dropped: it
  retries every **5 minutes** for up to **6 hours**, then fails visibly with
  `Could not send — the inbox stayed at its cap for 6 hours.`
- **FR-49** A scheduled send MUST fire at most once. Duplicate delivery MUST be impossible even if
  the firing mechanism runs twice.

### 4.6 Rules — allow and block

- **FR-50** The system MUST support rules with: a **type** (`allow` | `block`), a **match**
  (exact address | domain), a **direction** (`inbound` | `outbound` | `both`, default `both`) and
  a **scope** (workspace | one inbox).
- **FR-51** Inbound rules MUST be evaluated **before** the Agent sees the content. A blocked
  message MUST NOT create a thread, MUST NOT start a Run, and MUST NOT be shown to a model.
- **FR-52** Outbound rules MUST be evaluated in the send path against every recipient
  (to + cc + bcc). A message with any blocked recipient is refused in full, naming the recipient
  and the rule.
- **FR-53** Precedence MUST be, in order: **inbox scope beats workspace scope**, then
  **exact address beats domain**, then **allow beats block**. The winning rule alone decides.
- **FR-54** An **empty** allow-list MUST mean *no restriction*, never *allow nothing*.
- **FR-55** A non-empty allow-list's meaning MUST be explicit per inbox via an **allow-list mode**:
  `additive` (default — allow rules only override blocks; an unmatched address is permitted) or
  `exclusive` (an address matching no allow rule for that direction is refused).
- **FR-56** A workspace MUST hold at most **500** rules; one inbox at most **200**. A rule pattern
  is at most **254** characters.
- **FR-57** Every rule MUST show its match count over the last **7 days** and the timestamp it last
  matched, so a dead rule is visible.
- **FR-58** Blocked inbound messages MUST be retained, unreadable by any Agent, for **30 days** in
  a **Blocked** view so a mis-scoped rule is recoverable, then permanently discarded.
- **FR-59** Creating, editing or deleting a rule MUST be recorded in the Activity feed with the
  actor, the rule and the scope.

### 4.7 Send caps

- **FR-60** The system MUST enforce these ceilings at send time, in the single code path every
  send converges on:

  | Scope | Limit | Window | Default | Settable |
  | --- | --- | --- | --- | --- |
  | One inbox | sends | rolling 24 hours | **100** | yes, **1–1000**, by the workspace owner |
  | One inbox | sends | rolling 60 seconds | **10** | no |
  | One inbox | distinct recipients | rolling 300 seconds | **20** | no |
  | Workspace | sends | rolling 24 hours | **500** | platform operator only |
  | Workspace | sends | rolling 30 days | **10,000** | platform operator only |
  | One message | recipients (to + cc + bcc) | — | **50** | no |

- **FR-61** Windows MUST be **rolling**, not calendar. Capacity returns continuously as sends age
  out — never in a batch at midnight.
- **FR-62** One message to N recipients MUST count as **1** send against the send counters and
  **N** against the distinct-recipient counter.
- **FR-63** Caps MUST apply identically to every send path: the Agent's send tool, agent-to-agent
  messages, human Compose, approved drafts and scheduled fires. There MUST be no privileged
  bypass for a human.
- **FR-64** A refused send MUST return an error naming **which** limit was hit, the current count,
  the ceiling, and the wall-clock time capacity next returns.
- **FR-65** An inbox that hits its rolling-24h cap MUST enter a visible **Paused — cap reached**
  state and MUST resume automatically when the window clears, with no human action.
- **FR-66** The inbox settings surface MUST show a **cap meter** — a live gauge of sends used,
  reserved by scheduled sends, and remaining, for each of the three inbox windows.
- **FR-67** No instruction, standing-instruction text, tool argument or model output may raise or
  bypass a cap. Cap state MUST be read from persisted records, never from anything the model can
  write.
- **FR-68** A cap refusal MUST NOT lose the message: an approved draft that is refused returns to
  `draft` with the reason shown, and a scheduled send follows FR-48.
- **FR-69** Crossing **80%** of an inbox's rolling-24h cap MUST notify the owner once per window.

### 4.8 Sending domains

- **FR-70** A workspace MUST be able to connect up to **5** custom sending domains.
- **FR-71** Adding a domain MUST show the exact DNS records to publish — type, host, value, TTL
  and what each record is for — each with a copy button, and MUST NOT claim success before the
  records resolve.
- **FR-72** The platform MUST re-check an unverified domain every **15 minutes** for up to
  **72 hours**, then mark it **Failed** while still allowing a manual re-check.
- **FR-73** A verified domain MUST be assignable per inbox and assignable to all inboxes in one
  action.
- **FR-74** Removing a domain MUST first state how many inboxes use it and what happens; on
  confirm, those inboxes MUST fall back to the platform default sending domain, keep receiving at
  their previous address for **30 days**, and MUST NOT break.
- **FR-75** A domain that stops verifying (records removed at the registrar) MUST be detected
  within **24 hours**, MUST notify the owner, and MUST NOT silently keep sending from it for more
  than **1 hour** after detection.
- **FR-76** Only the workspace owner may connect or remove a sending domain.

### 4.9 Standing instructions and mode

- **FR-77** Each inbox MUST carry **standing instructions** — free text up to **8,000**
  characters — that apply to every message it handles until changed.
- **FR-78** A new inbox MUST be pre-filled with a starter template covering: what to handle, what
  to draft for review, what to escalate, tone, and a default-to-escalate tiebreaker.
- **FR-79** An inbox MUST have a **mode**: `draft-review` (default — nothing sends unapproved) or
  `auto-send` (the Agent may send within its standing instructions, still under rules and caps).
- **FR-80** Switching an inbox to `auto-send` MUST require an explicit confirmation naming the
  consequence, and MUST be recorded in the Activity feed with the actor.
- **FR-81** An inbox MUST NOT change its own mode. Mode changes come only from a human action.
- **FR-82** Editing standing instructions MUST take effect on the next inbound message, and the
  previous text MUST be retained for the last **10** edits.

### 4.10 Notifications, audit and permissions

- **FR-83** These events MUST be notifiable, with these shipped defaults:

  | Event | In-app | Email to the owner |
  | --- | --- | --- |
  | An Agent drafted a reply for review | **on** | off |
  | An Agent's inbox received mail | **on** | off |
  | An Agent escalated a decision | **on** | **on** |
  | A send was refused by a cap or a rule | **on** | **on** |
  | A message bounced | **on** | off (3 in 24h → **on**) |
  | A sending domain verified, or stopped verifying | **on** | **on** |

- **FR-84** Every message — received, drafted, revised, approved, scheduled, cancelled, sent,
  failed, escalated, discarded — MUST be recoverable from the audit trail with the actor, the
  timestamp and the Run, for the message's full retention life.
- **FR-85** Reading an inbox MUST require read access to the owning Agent. Approving, revising,
  discarding, composing, scheduling and cancelling MUST require write access to it. Changing caps,
  rules and modes MUST require workspace-owner rights. Connecting a domain MUST require
  workspace-owner rights.
- **FR-86** A user MUST NOT be able to read, approve or send from an inbox belonging to an Agent
  they cannot access, even given its identifier. A cross-tenant identifier MUST return the same
  response as a nonexistent one.
- **FR-87** Every outbound send MUST record its cost against the Run that produced it, and the
  thread MUST link to that Run.
- **FR-88** Inbound message content MUST be treated as untrusted data everywhere it reaches a
  model, wrapped so that instructions inside an email cannot be read as instructions to the Agent.
- **FR-89** The system MUST NOT return provider webhook secrets, verification tokens or domain
  credentials in any API response or log line.

---

## 5. Key entities

### 5.1 Existing — extended, never renamed

| Entity | Today | This epic adds |
| --- | --- | --- |
| **Agent** | The person-shaped worker | Optionally owns one Agent Inbox |
| **Tenant email address** | Registry of provider-bound addresses | Unchanged; an Agent Inbox points at one |
| **Agent email assignment** | Per-agent address binding with priority and dispatch mode | Unchanged; it stays the many-to-many join. Policy moves to the Agent Inbox |
| **Email message** | Per-message audit row with post-send delivery status | A pre-send **status**, unread state, scheduling fields, draft version history, thread membership for outbound messages, attachment metadata |
| **Email conversation** | Per-agent thread keyed on reply headers or subject | Becomes the universal grouping unit for inbound **and** outbound; gains subject, counts, unread count, state and escalation link |
| **Approval** | Pending agent-action proposal, surfaced in My Decisions | A new proposal kind for an email draft |
| **Escalation** | The record of an Agent giving up, surfaced in My Decisions | A new reason for an email the Agent refused to answer |
| **Run** | One agent execution | Linked from every message it produced |
| **Memory** | Durable facts | Receives writing-style facts learned from approved edits |
| **Plugin / Connection** | Provider plugins and accounts | Sending-domain description and verification become plugin capabilities |

### 5.2 New — and why each is genuinely new

| Entity | Definition | Why it cannot be an existing noun |
| --- | --- | --- |
| **Agent Inbox** | An Agent's mail identity **and** the policy attached to it: address, sending domain, standing instructions, mode, caps, allow-list mode, learn-from-edits flag | The tenant address registry is tenant-scoped and provider-shaped; the agent–address assignment is legitimately many-to-many and per-direction. Neither is 1:1 with an Agent, and neither can own per-agent policy without becoming two things at once. Putting these on the Agent would give every Agent eight nullable mail columns it will never use. |
| **Email rule** | One allow or block entry: type, match, direction, scope, with match counters | Not a policy matrix row (those govern merges and tool grants), not a notification preference. It is evaluated in the mail path, upstream of the model, and needs its own precedence semantics. |
| **Sending domain** | A workspace-owned domain for outbound mail: DNS records, verification state, last check, failure reason | The existing custom-domain concept describes the domain a **published website** is served from and is bound to a deployment provider. A sending domain is bound to an **email** provider and needs SPF/DKIM/DMARC-shaped records and continuous re-verification. Overloading one entity would put website-deployment state and mail-reputation state in one row. |

### 5.3 States and transitions

**Message status**

```
                     (inbound)
                        │
                        ▼
                    ┌────────┐
                    │received│
                    └───┬────┘
                        │ agent escalates
                        ▼
                   ┌─────────┐  dismiss / instruct  ┌──────────┐
                   │escalated│─────────────────────►│ resolved │
                   └─────────┘                      └──────────┘

  (outbound)
   agent writes ─────► ┌───────┐ ── revise ──► ┌─────────┐
                       │ draft │◄──── new version ──────  │revising│
                       └───┬───┘                          └─────────┘
                approve │  │ discard             ┌───────────┐
        ┌───────────────┘  └────────────────────►│ discarded │
        │                                        └───────────┘
        │ schedule                approve now
        ▼                              │
  ┌───────────┐   cancel               │
  │ scheduled │───────────► draft      │
  └─────┬─────┘                        │
        │ fires                        │
        └────────────┬─────────────────┘
                     ▼
                ┌─────────┐  provider accepts   ┌──────┐  bounce/complaint
                │ sending │────────────────────►│ sent │──────────────► (delivery
                └────┬────┘                     └──────┘                 outcome
                     │ provider refuses / cap refuses                     on card)
                     ▼
                ┌────────┐  try again
                │ failed │────────────► sending
                └────────┘
```

Only `sending → sent` is irreversible. Everything before it is recoverable; that is the point of
the epic.

**Agent Inbox state**: `active` → `cap-paused` (automatic, self-clearing) → `active`;
`active` → `suspended` (owner action or 3 bounces in 24h forces `draft-review`) → `active`;
`active` → `released` (Agent archived; address held 30 days).

**Sending domain state**: `pending` → `verifying` → `verified` | `failed`;
`verified` → `unverified` (records disappeared) → `verifying`; any → `removed`.

**Rule**: stateless apart from its match counters.

---

## 6. UX

All copy below is the exact user-visible string. Every string is an i18n key (see
[`plan.md`](./plan.md) §8); none is hard-coded.

### 6.1 The Email screen — All inboxes, loaded

```
┌───────────────────────────────────────────────────────────────────────────────────────────┐
│ ✉ Email                                                        [ ✎ Compose ]  [ ⚙ ]        │
├───────────────┬───────────────────────────────────────────────────────────────────────────┤
│ INBOXES       │ Received │ Sent │ Unread │ Drafts 3 │ Escalations 1 │ Scheduled 2         │
│               ├───────────────────────────────────────────────────────────────────────────┤
│ ● All      6  │ 🔍 Search this view                                       Sort: Newest ▾  │
│ ─────────────  ├───────────────────────────────────────────────────────────────────────────┤
│ ◐ Nova     2  │ ● Nova   Riverbend Foods        NEW   Re: 2027 renewal quote     📎  4  2m │
│   nova@…      │   Nova   Dana Okonkwo          DRAFT  Re: Senior ops role, Thu       2  9m │
│ ◐ Piper    1  │ ⚠ Piper  Lumen Labs        ESCALATED  Refund request, day 40       3  22m │
│   piper@…     │   Wren   Sam Reyes         SCHEDULED  Follow-up: onboarding        1  ⏱ 4h │
│ ◐ Wren     3  │   Wren   Chen Wu                      Re: Partnership, who owns?   5   1d │
│   wren@…      │   Nova   Riverbend Foods        SENT  Quote received, thank you     2   2d │
│               │                                                                           │
│ + Give an     │                       Showing 6 of 6 · load more                          │
│   agent an    │                                                                           │
│   address     │                                                                           │
└───────────────┴───────────────────────────────────────────────────────────────────────────┘
```

Row anatomy: owning Agent · other party · state badge · subject · 📎 when the thread has
attachments · message count · relative time. A bold row is unread. `⏱ 4h` on a Scheduled row is
the countdown.

Copy: header `Email` · compose `Compose` · filters `Received` `Sent` `Unread` `Drafts`
`Escalations` `Scheduled` · switcher header `Inboxes` · all-row `All` · provisioning row
`Give an agent an address` · search placeholder `Search this view` · footer
`Showing {shown} of {total}` / `Load more`.

### 6.2 Loading, empty and error

```
LOADING                          EMPTY (Drafts)                   ERROR
┌──────────────────────┐   ┌──────────────────────────┐   ┌────────────────────────────┐
│ ▒▒▒▒▒▒▒▒▒▒  ▒▒▒▒  ▒▒ │   │            ✎             │   │             !              │
│ ▒▒▒▒▒▒▒▒  ▒▒▒▒▒▒  ▒▒ │   │  No drafts waiting.      │   │  We could not load your    │
│ ▒▒▒▒▒▒▒▒▒▒▒▒  ▒▒▒  ▒ │   │  Nova writes here when   │   │  mail. Nothing was sent     │
│ ▒▒▒▒▒▒  ▒▒▒▒▒▒▒▒  ▒▒ │   │  it has something for    │   │  or lost.                  │
│                      │   │  you to approve.         │   │        [ Try again ]       │
│ six skeleton rows    │   │                          │   │                            │
└──────────────────────┘   └──────────────────────────┘   └────────────────────────────┘
```

```
NO INBOX AT ALL (replaces the list, not an empty row)
┌───────────────────────────────────────────────────────────────────────────┐
│                                   ✉                                       │
│              None of your agents has an email address yet.                │
│   An agent with its own inbox sends and receives as itself, so replies    │
│           come back to it instead of landing in your mailbox.             │
│                                                                           │
│                     Agent  [ Nova            ▾ ]                          │
│                     Address  nova@northwind.agents.ever.works             │
│                                                                           │
│                          [ Give Nova an address ]                         │
│           Starts in Draft for review — nothing sends without you.         │
└───────────────────────────────────────────────────────────────────────────┘
```

```
OVER LIMIT (banner above the list; the list still reads)
┌───────────────────────────────────────────────────────────────────────────┐
│ ⏸  Nova's inbox is paused — cap reached.                                  │
│    100 of 100 sends used in the last 24 hours. Capacity returns at 14:05. │
│    Nothing is lost; sending resumes on its own.       [ Open cap meter ]  │
└───────────────────────────────────────────────────────────────────────────┘
```

### 6.3 Thread view — a draft awaiting approval

```
┌───────────────────────────────────────────────────────────────────────────────────────────┐
│ ← All inboxes    Re: Senior ops role, free Thursday        Nova · 2 messages    [ ⋯ ]     │
├───────────────────────────────────────────────────────────────────────────────────────────┤
│  ┌─────────────────────────────────────────────────────────────────────────────────────┐  │
│  │ Dana Okonkwo <dana@lumenlabs.example.com>              RECEIVED   Today 09:14        │  │
│  │ Thanks for getting back to me. Thursday works — is 2pm your time OK?                │  │
│  │ ▸ Show quoted history (3 earlier messages)                                          │  │
│  └─────────────────────────────────────────────────────────────────────────────────────┘  │
│                                                                                           │
│  ┌─────────────────────────────────────────────────────────────────────────────────────┐  │
│  │ Nova <nova@northwind.example.com> → Dana Okonkwo          DRAFT   written 09:16      │  │
│  ├─────────────────────────────────────────────────────────────────────────────────────┤  │
│  │ Subject  Re: Senior ops role, free Thursday                                         │  │
│  │ ┌─────────────────────────────────────────────────────────────────────────────────┐ │  │
│  │ │ Hi Dana,                                                                        │ │  │
│  │ │                                                                                 │ │  │
│  │ │ Thursday at 2pm works. I have sent a calendar hold and will bring the ops        │ │  │
│  │ │ scorecard we discussed.                                                         │ │  │
│  │ │                                                                                 │ │  │
│  │ │ — Nova, Northwind                                    click to edit inline        │ │  │
│  │ └─────────────────────────────────────────────────────────────────────────────────┘ │  │
│  │ Written by Run #4821 · 1,240 tokens · $0.004        ▸ Version history (2)            │  │
│  ├─────────────────────────────────────────────────────────────────────────────────────┤  │
│  │  [ ✓ Approve & send ]   [ Revise with Nova ]   [ Schedule… ]   [ Discard ]          │  │
│  └─────────────────────────────────────────────────────────────────────────────────────┘  │
│                                                                                           │
│  Nova's inbox: 12 of 100 sends used in the last 24 hours.                                 │
└───────────────────────────────────────────────────────────────────────────────────────────┘
```

Copy: `Approve & send` · `Revise with {agent}` · `Schedule…` · `Discard` ·
`click to edit inline` · `Show quoted history ({count} earlier messages)` ·
`Written by Run #{runId} · {tokens} tokens · {cost}` · `Version history ({count})` ·
footer meter `{agent}'s inbox: {used} of {cap} sends used in the last 24 hours.`

**Send grace toast** (5 seconds):

```
┌─────────────────────────────────────────────────┐
│ Sending to Dana Okonkwo…   4   [ Undo ]         │
└─────────────────────────────────────────────────┘
```

**Stale draft** (new inbound arrived):

```
│ ⚠ Dana wrote again after Nova drafted this. Read the new message first.                 │
│   [ ✓ Approve & send anyway ]   [ Revise with Nova ]   ← recommended                    │
```

### 6.4 Revise with the Agent

```
┌───────────────────────────────────────────────────────────────┐
│ Revise with Nova                                        [ × ] │
├───────────────────────────────────────────────────────────────┤
│ What should change?                                           │
│ ┌───────────────────────────────────────────────────────────┐ │
│ │ Too long. Three sentences, no pricing.                    │ │
│ └───────────────────────────────────────────────────────────┘ │
│ 39 / 2000                              Revision 2 of 5        │
│                              [ Cancel ]  [ Send it back ]     │
└───────────────────────────────────────────────────────────────┘
```

Copy: title `Revise with {agent}` · label `What should change?` · counter `{used} / 2000` ·
`Revision {n} of 5` · buttons `Cancel` / `Send it back`. On the sixth attempt the button is
replaced with the notice `Nova has revised this 5 times. Edit it yourself, approve it, or
discard it.`

### 6.5 Escalation card

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│ ⚠ Piper escalated this                                    ESCALATED   Today 08:31   │
├─────────────────────────────────────────────────────────────────────────────────────┤
│ Refund requested 40 days after purchase — outside the 30-day policy.                │
│                                                                                     │
│ What I need you to decide                                                           │
│ The customer has three prior orders and no refunds. Approve as goodwill, or          │
│ decline citing policy? I did not reply.                                             │
│                                                                                     │
│ Raised by Run #4903 · triggered by the message above                                │
├─────────────────────────────────────────────────────────────────────────────────────┤
│  [ Instruct Piper ]   [ Dismiss ]                        Also in My Decisions ↗     │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

Copy: `{agent} escalated this` · `What I need you to decide` ·
`Raised by Run #{runId} · triggered by the message above` · `Instruct {agent}` · `Dismiss` ·
`Also in My Decisions`. Dismiss confirms with
`Dismiss this? Piper will not reply to this thread.`

### 6.6 Scheduled card

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│ Wren → Sam Reyes                                          SCHEDULED                  │
├─────────────────────────────────────────────────────────────────────────────────────┤
│ Follow-up: onboarding                                                               │
│ Hi Sam — checking in on the two open items from Tuesday…                            │
│                                                                                     │
│ ⏱  Sends in 4h 12m 08s                                                              │
│    Tomorrow, 09:00 America/New_York  ·  05:00 your time                             │
│    Holding 1 of Wren's 100 daily sends until it fires.                              │
├─────────────────────────────────────────────────────────────────────────────────────┤
│  [ Cancel send ]   [ Edit & reschedule ]                                            │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

Copy: `Sends in {countdown}` · `{absolute} {recipientTz} · {localAbsolute} your time` ·
`Holding 1 of {agent}'s {cap} daily sends until it fires.` · `Cancel send` ·
`Edit & reschedule`. On a lost race: `Too late — this message already went out.`

### 6.7 Compose

```
┌───────────────────────────────────────────────────────────────────────────────────┐
│ Compose                                                                    [ × ]  │
├───────────────────────────────────────────────────────────────────────────────────┤
│ Send as   [ Nova · nova@northwind.example.com          ▾ ]                        │
│           This counts against Nova's send cap. 12 of 100 used today.              │
│ To        [ dana@lumenlabs.example.com                            ]  + Cc  + Bcc  │
│ Subject   [                                                       ]               │
│ ┌───────────────────────────────────────────────────────────────────────────────┐ │
│ │                                                                               │ │
│ └───────────────────────────────────────────────────────────────────────────────┘ │
│ ⏱ Schedule…                                        [ Save as draft ]  [ Send ]    │
└───────────────────────────────────────────────────────────────────────────────────┘
```

Copy: `Send as` · `This counts against {agent}'s send cap. {used} of {cap} used today.` ·
`To` / `Cc` / `Bcc` / `Subject` · `Schedule…` · `Save as draft` · `Send`.
Blocked recipient: `You cannot write to dana@lumenlabs.example.com — a block rule on
@lumenlabs.example.com applies to this inbox. [ Review rules ]`

### 6.8 Inbox settings

```
┌───────────────────────────────────────────────────────────────────────────────────┐
│ Nova's inbox                                                              [ × ]   │
│ Identity · Standing instructions · Rules & lists · Sending limits                 │
├───────────────────────────────────────────────────────────────────────────────────┤
│ IDENTITY                                                                          │
│   Address     [ nova ]@[ northwind.example.com  ▾ ]              [ Save ]         │
│               Previous address nova@northwind.agents.ever.works still receives    │
│               until 6 Oct 2026.                                                   │
│   Mode        (•) Draft for review — nothing sends until you approve it           │
│               ( ) Auto-send — Nova may send within its standing instructions      │
│   Learn from  [✓] Use my edits to teach Nova my writing voice                     │
├───────────────────────────────────────────────────────────────────────────────────┤
│ STANDING INSTRUCTIONS                                       edited 2 days ago ▸   │
│ ┌───────────────────────────────────────────────────────────────────────────────┐ │
│ │ Handle: order status, scheduling, and how-do-I questions.                     │ │
│ │ Draft for review: everything else that deserves a reply.                      │ │
│ │ Escalate, do not reply: refunds outside policy, legal, anyone threatening to  │ │
│ │ leave, and anything where you would be guessing.                              │ │
│ │ Tone: warm, direct. Sign as Nova.                                             │ │
│ │ When unsure whether something is yours: it isn't. Escalate it.                │ │
│ └───────────────────────────────────────────────────────────────────────────────┘ │
│ 312 / 8000                                                        [ Save ]        │
├───────────────────────────────────────────────────────────────────────────────────┤
│ RULES & LISTS                                             [ + Add rule ]          │
│  Type   Match                          Direction  Scope      Matches (7d)  Last  │
│  BLOCK  @spam-domain.test              inbound    Workspace          14    2h    │
│  ALLOW  chen@riverbend.example.com     both       This inbox          3    1d    │
│  BLOCK  @riverbend.example.com         inbound    Workspace           0    never │
│                                                                                   │
│  Allow-list mode  (•) Additive — allow rules only override blocks                 │
│                   ( ) Exclusive — only allowed senders get through                │
│  An empty allow-list means no restriction, not "allow nothing".                   │
│  Precedence: this inbox beats workspace · exact address beats domain ·            │
│  allow beats block.                                              [ Blocked (14) ] │
├───────────────────────────────────────────────────────────────────────────────────┤
│ SENDING LIMITS                                                                    │
│  Last 24 hours    ████████░░░░░░░░░░░░░░░░░░░░░░░░  12 sent · 2 held · 86 left    │
│  Last 60 seconds  ██░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░   1 of 10                      │
│  Recipients / 5m  ██████░░░░░░░░░░░░░░░░░░░░░░░░░░   4 of 20                      │
│                                                                                   │
│  Daily cap for this inbox  [ 100 ] sends per rolling 24 hours   1–1000            │
│  Workspace: 143 of 500 today · 2,904 of 10,000 this month                        │
│  Caps are enforced when a message is sent. Nothing can raise them from a prompt.  │
└───────────────────────────────────────────────────────────────────────────────────┘
```

Copy: section titles `Identity` `Standing instructions` `Rules & lists` `Sending limits` ·
`Draft for review — nothing sends until you approve it` ·
`Auto-send — {agent} may send within its standing instructions` ·
`Use my edits to teach {agent} my writing voice` ·
`Previous address {address} still receives until {date}.` ·
`An empty allow-list means no restriction, not "allow nothing".` ·
`Precedence: this inbox beats workspace · exact address beats domain · allow beats block.` ·
`{sent} sent · {held} held · {left} left` ·
`Caps are enforced when a message is sent. Nothing can raise them from a prompt.`

Switching to Auto-send confirms with:
`Turn off the approval gate? Nova will send replies without showing them to you first. Rules and
send caps still apply. [ Keep the gate ] [ Turn it off ]`

### 6.9 Sending domains

```
┌───────────────────────────────────────────────────────────────────────────────────┐
│ Settings → Integrations → Email domains                        [ + Add domain ]   │
├───────────────────────────────────────────────────────────────────────────────────┤
│  ● northwind.example.com      VERIFIED    3 inboxes    checked 4m ago    [ ⋯ ]    │
│  ◐ mail.northwind.test        VERIFYING   0 inboxes    next check 11m    [ ⋯ ]    │
└───────────────────────────────────────────────────────────────────────────────────┘

ADD DOMAIN — step 2, publish these records
┌───────────────────────────────────────────────────────────────────────────────────┐
│ Publish these DNS records at your registrar, then press Check now.                 │
│                                                                                   │
│  Type   Host                         Value                              TTL       │
│  TXT    northwind.example.com        v=spf1 include:… ~all         3600  [copy]   │
│  TXT    s1._domainkey.northwind…     k=rsa; p=MIGfMA0GCS…          3600  [copy]   │
│  TXT    _dmarc.northwind.example.com v=DMARC1; p=none; rua=…       3600  [copy]   │
│  MX     inbound.northwind.example.com mx.provider.example.  10     3600  [copy]   │
│                                                                                   │
│  SPF authorises sending · DKIM signs each message · DMARC tells receivers what     │
│  to do when a check fails · MX routes replies back to your agents.                │
│                                                                                   │
│  ⏱ Checking automatically every 15 minutes for 72 hours.                          │
│                                     [ I'll do this later ]  [ Check now ]         │
└───────────────────────────────────────────────────────────────────────────────────┘

FAILED
│ ✕ We could not verify northwind.example.com after 72 hours.                       │
│   DKIM record not found at s1._domainkey.northwind.example.com.                   │
│   Fix the record and check again — nothing was lost.        [ Check again ]       │
```

Remove confirmation:
`3 inboxes send from northwind.example.com. They will fall back to
{workspace}.agents.ever.works and keep receiving at their old address for 30 days.
[ Keep the domain ] [ Remove it ]`

### 6.10 Keyboard affordances

| Key | Where | Does |
| --- | --- | --- |
| `g` then `e` | anywhere | Go to Email |
| `j` / `k` or `↓` / `↑` | thread list | Move selection |
| `Enter` | thread list | Open the thread |
| `Esc` | thread view / any dialog | Back to the list / close |
| `1` … `6` | Email screen | Received / Sent / Unread / Drafts / Escalations / Scheduled |
| `[` / `]` | Email screen | Previous / next inbox in the switcher |
| `u` | thread list or thread | Toggle unread |
| `a` | a focused draft | Approve & send (the 5-second Undo toast is the safety net) |
| `r` | a focused draft | Revise with the Agent (opens the notes dialog, focus in the field) |
| `s` | a focused draft | Schedule… |
| `d` | a focused draft | Discard (confirms) |
| `c` | Email screen | Compose |
| `/` | Email screen | Focus search |
| `?` | Email screen | Show this list |

Every control is reachable by `Tab` in visual order; state badges carry text, never colour alone;
the countdown is announced politely to screen readers at 1h, 10m and 1m rather than every second.

---

## 7. Out of scope

- **Bulk campaigns, newsletters and marketing sequences.** Different discipline, different
  deliverability stack, different consent model. The caps in FR-60 deliberately make this
  impossible, and that is a feature.
- **Sending or downloading attachments.** This epic records inbound attachment *metadata*
  (filename, type, size, up to 25 per message) and shows it. Storing, serving and sending
  attachment content is a follow-up.
- **A rich HTML composer.** Drafts and Compose are plain text plus the existing server-rendered
  template path. WYSIWYG is a follow-up.
- **Importing an existing mailbox.** No IMAP sync, no migration of historical mail, no claiming
  addresses already configured at a provider.
- **Reply-all semantics beyond to/cc/bcc**, mailing-list handling, and calendar invite parsing.
- **Per-message-type auto-send graduation as a structured setting.** Mode is per inbox in this
  epic; finer-grained autonomy is expressed in the standing instructions and hardened by AW-24.
- **Unsubscribe-link generation, marketing consent tracking and jurisdiction-specific footers.**
  Transactional and conversational mail only.
- **One-click DNS publishing** for a sending domain when the workspace has a DNS connection. The
  records are shown and copyable; automated publishing is a P3 stretch and depends on the DNS
  capability gaining TXT and MX record types.
- **Changing the operator message centre at `/inbox`.** It keeps its questions, approvals,
  escalations and notices exactly as they are. AW-03 owns that surface.
- **A second inbox per Agent, or one inbox shared by two Agents.**

---

## 8. Acceptance criteria

A reviewer can run this list top to bottom against a merged build.

**Provisioning and identity**
- [ ] Provisioning an inbox from the Agent's Inbox tab yields a live address within 10 seconds.
- [ ] A second provisioning attempt returns the same inbox and does not error.
- [ ] Editing the local part keeps the old address receiving; the settings page states the expiry
      date.
- [ ] The Agent detail page has an Inbox tab, and the Email screen is reachable from the sidebar.

**Threads and views**
- [ ] A five-message conversation renders as one thread with a message count, not five rows.
- [ ] The All-inboxes view lists every readable inbox with per-inbox unread counts and an All row.
- [ ] All six filters return the right set and are reflected in the URL.
- [ ] Every filter has its own empty state; none renders a bare "no results".
- [ ] New inbound mail appears within 30 seconds without a manual refresh.
- [ ] An HTML body renders sanitised, in an isolated frame, with remote images blocked until
      **Load images** is pressed.

**The draft loop**
- [ ] With the inbox in Draft for review, an Agent calling its send tool produces a draft and
      sends nothing — verified by asserting no provider call was made.
- [ ] Approve & send shows a 5-second Undo; Undo returns the message to draft and sends nothing.
- [ ] An inline edit is what gets sent, and both versions appear in Version history.
- [ ] Revise with the Agent replaces the draft in place; the notes are retained; the sixth
      revision is refused with the stated copy.
- [ ] Two simultaneous approvals send exactly one message; the loser sees who won.
- [ ] A draft on a thread that received new mail is marked stale and needs a second confirmation.
- [ ] A draft unapproved for 14 days is auto-discarded with a visible notice.
- [ ] Every draft appears in My Decisions, and approving there sends exactly once.

**Escalations**
- [ ] An escalated thread sends nothing while open.
- [ ] The escalation appears on the thread, in the Escalations filter and in My Decisions.
- [ ] Dismiss resolves it everywhere within one refresh; Instruct opens the Agent's chat with the
      thread referenced.

**Scheduled sends**
- [ ] A scheduled send shows a countdown, the absolute time and the recipient timezone.
- [ ] Cancel returns it to draft and releases the held capacity, visible on the cap meter.
- [ ] Cancelling after the send has started is refused with the stated copy and produces no
      duplicate.
- [ ] Running the firing mechanism twice for one message sends exactly once.
- [ ] The 201st scheduled send on one inbox is refused, naming the limit.

**Rules**
- [ ] A blocked sender produces no thread, no Run and no model call — asserted, not assumed.
- [ ] The precedence chain resolves the workspace-block / inbox-exact-allow conflict in favour of
      allow.
- [ ] An empty allow-list restricts nothing, in both allow-list modes.
- [ ] In exclusive mode, an address matching no allow rule is refused; in additive mode it is
      permitted.
- [ ] An outbound message with one blocked recipient is refused in full, naming recipient and
      rule.
- [ ] Blocked mail is readable in the Blocked view for 30 days and unreachable by any Agent.

**Caps**
- [ ] The 101st send in 24 hours is refused from every path: agent tool, agent-to-agent message,
      human Compose, approved draft and scheduled fire.
- [ ] The refusal names the limit, the count, the ceiling and when capacity returns.
- [ ] The 11th send in 60 seconds and the 21st distinct recipient in 5 minutes are refused
      independently of each other.
- [ ] One message to 5 recipients counts as 1 send and 5 recipients.
- [ ] A message to 51 recipients is refused.
- [ ] A capped inbox shows the paused banner and resumes on its own as sends age out — no human
      action, no midnight reset.
- [ ] A cap-refused draft returns to draft with the reason shown; nothing is lost.
- [ ] Nothing in a prompt, a tool argument, standing-instruction text or a model output changes
      any counter or ceiling.

**Sending domains**
- [ ] Adding a domain shows SPF, DKIM, DMARC and MX records with copy buttons and an explanation
      of each.
- [ ] Verification retries every 15 minutes and gives up after 72 hours with a specific reason.
- [ ] Assigning a verified domain changes an inbox's address; the old one keeps receiving.
- [ ] Removing a domain states the impact first, then falls back to the platform default without
      breaking any inbox.

**Permissions, audit and cost**
- [ ] A read-only collaborator can read but cannot approve, revise, discard, compose, schedule,
      cancel or change settings — enforced server-side, not only by a disabled button.
- [ ] A cross-tenant identifier returns the same response as a nonexistent one.
- [ ] Every state change is in the audit trail with actor, timestamp and Run.
- [ ] Every sent message links to the Run that wrote it, with its token count and cost.
- [ ] No response or log line contains a webhook secret, verification token or domain credential.
- [ ] Every functional requirement has a passing test.

---

## 9. Open questions

- `[NEEDS CLARIFICATION: role names for approval rights. This spec says "write access to the
  Agent" approves and "workspace owner" changes caps and domains. The concrete grant names in the
  collaborator model need to be pinned before implementation, and we should decide whether a
  dedicated "may approve outbound mail" grant is worth a separate switch.]`
- `[NEEDS CLARIFICATION: the exact platform mail domain. This spec assumes
  <agent-slug>@<workspace-slug>.agents.ever.works with the parent domain operator-configurable.
  Confirm the zone, whether a shared parent is acceptable for deliverability, and whether
  self-hosted deployments get a default at all or must connect a domain first.]`
- `[NEEDS CLARIFICATION: workspace cap ceilings for paid tiers. 500/day and 10,000/30 days are
  proposed as the shipped defaults. Do higher tiers get higher ceilings automatically, and who
  can raise them — the workspace owner, or only a platform operator?]`
- `[NEEDS CLARIFICATION: message retention. How long are threads and message bodies kept, and is
  there an export? Blocked mail is specified at 30 days; ordinary mail is unspecified.]`
- `[NEEDS CLARIFICATION: whether an auto-suppression list is warranted — after N hard bounces to
  one recipient address, refuse further sends to it workspace-wide. This spec only forces the
  inbox back to Draft for review after 3 bounces in 24 hours.]`
- `[NEEDS CLARIFICATION: how "learn from my edits" interacts with AW-07's memory load meter. A
  style fact per approved edit could crowd the context budget. Proposed mitigation: cap at 20
  style facts per Agent, consolidating older ones — needs AW-07 to confirm the mechanism.]`
- `[NEEDS CLARIFICATION: whether an inbox may be shared read-only with a teammate who has no
  access to the owning Agent, for AW-18's shared dashboards.]`
- `[NEEDS CLARIFICATION: does an inbound message count against anything? This spec meters
  outbound only. If inbound volume becomes an abuse vector we need an inbound ceiling too.]`

---

## 10. Constitution gates

- [x] **I — Plugin-first.** Sending-domain description and verification are new methods on the
      existing email-provider capability, implemented inside the provider plugins. No inline
      provider client, no new external integration in core.
- [x] **II — Capability-driven.** Every send and every domain check resolves a plugin through the
      email facade. No plugin id appears outside a plugin package.
- [x] **III — Source-of-truth repos.** Not applicable: mail is operational data, not work content.
      No work content moves into the database.
- [x] **IV — Job runtime.** Scheduled sends, the scheduled-send sweeper, the domain re-check loop
      and the draft-staleness sweep are all jobs on the configured job-runtime provider, reached
      through dispatcher symbols.
- [x] **V — Forward-only migrations.** Three new tables and additive columns on two existing
      tables, with a backfill that gives every existing message a status and a thread. Nothing is
      dropped or renamed.
- [x] **VI — Tests.** Unit tests for the precedence resolver, the cap arithmetic and the state
      machine; controller specs for every new endpoint; end-to-end specs for the draft loop, the
      escalation loop, the schedule/cancel loop and the cap refusal.
- [x] **VII — Secrets.** Domain credentials and webhook secrets stay in plugin settings marked
      secret, are never returned by an endpoint and never logged.
- [x] **VIII — Plugin counts.** No new plugin package; the canonical plugin doc gains the new
      capability strings only.
- [x] **IX — Behaviour-first.** This document names no class, file or endpoint.
- [x] **X — Backwards compatible.** Existing endpoints keep their shapes; new fields are additive;
      the existing per-agent routes keep working; the previously documented
      "one link or the other, never both" rule on a message becomes "always a thread, optionally
      also a task", which populates a nullable field rather than changing an existing one.

## 11. References

- Program: [`../README.md`](../README.md) · tracker [`../TRACKER.md`](../TRACKER.md)
- Sibling epics this integrates with: AW-03 My Decisions, AW-04 Live Feed, AW-09 Runs & receipts,
  AW-13 Attention controls, AW-17 Costs & caps, AW-24 Safety rails
- Prior specs this extends: [`../../email-providers/spec.md`](../../email-providers/spec.md),
  [`../../agent-inbox-ui/spec.md`](../../agent-inbox-ui/spec.md),
  [`../../notification-channels/spec.md`](../../notification-channels/spec.md)
- Implementation: [`./plan.md`](./plan.md) · [`./tasks.md`](./tasks.md)
