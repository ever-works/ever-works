# AW-03 — My Decisions: the human decision queue

> Behaviour-first spec per [Constitution Principle IX](../../../../../.specify/memory/constitution.md#ix-specs-are-behaviour-first).
> This document describes **what a user sees and can do**. No class names, no file
> paths, no code — those live in [`plan.md`](./plan.md).

**Feature ID**: `aw-03-decision-queue`
**Program**: [Agent Workspace](../README.md)
**Branch**: `feat/aw-03-decision-queue`
**Status**: `Draft`
**Created**: 2026-09-06
**Last updated**: 2026-09-06
**Size**: L · **Blocking dependencies**: none
**Extends**: Approvals + Escalations (both already exist in Ever Works)
**Adjacent epics**: [AW-02 Task board](../AW-02-task-board/) · [AW-04 Live Feed](../AW-04-live-feed/) · [AW-09 Runs & receipts](../AW-09-runs-receipts/) · [AW-13 Attention controls](../AW-13-attention-controls/) · [AW-15 Connections & scopes](../AW-15-connections-scopes/) · [AW-19 Home](../AW-19-home/) · [AW-24 Safety rails](../AW-24-safety-rails/)

> **Additive by default (program rule #1).** Nothing here is removed, renamed or
> consolidated away. The Approval block on Home keeps working. The Inbox keeps
> working. Every existing approval and escalation endpoint keeps its current
> behaviour and its current response shape. Exactly **one** new stored noun is
> introduced — the **Ask** — and it is justified in §5.3. "Decision" is not a new
> table: it is the program's already-agreed user-facing word for an Approval or an
> Escalation, projected into one queue.

---

## 0. TL;DR

```
   /decisions
   ┌──────────────────────────────────────────────────────────────────────────┐
   │  My Decisions                                    3 open · 1 blocking      │
   │  Everything waiting on you, and nothing else.                             │
   │                                                                           │
   │  ┌───────┬──────────┬──────────┐        ┌───────────────────────────────┐ │
   │  │ Open  │ Answered │ Archived │        │Agent ▾ Task ▾ Mission ▾ Kind ▾ │ │
   │  └═══════┴──────────┴──────────┘        └───────────────────────────────┘ │
   ├─────────────────────────────────┬────────────────────────────────────────┤
   │ QUEUE                     1 / 3 │ DECISION                               │
   │                                 │                                        │
   │ ▸ Spend $240 on the data feed   │  Refresh the pricing page              │
   │   Researcher · 2h · ⏸ blocking  │  Researcher stopped here 2 hours ago.  │
   │                                 │                                        │
   │ ▸ Which supplier list wins?     │  WHAT IT TRIED                         │
   │   Editor · 5h                   │   • fetch feed — 402 payment required  │
   │                                 │   • cached copy — 9 days stale         │
   │ ▸ Need read access to Analytics │                                        │
   │   Ops · 1d                      │  WHAT THIS NEEDS FROM YOU      1 of 3  │
   │                                 │   ✓ 1. Approve the $240 spend          │
   │                                 │   ○ 2. Which feed tier?                │
   │                                 │   ○ 3. Grant read access to Analytics  │
   │                                 │                                        │
   │                                 │  Answer all three and Researcher       │
   │                                 │  picks this up where it stopped.       │
   └─────────────────────────────────┴────────────────────────────────────────┘
```

Ever Works already knows when an agent must stop and ask. It writes an
**Escalation** when an agent gives up (ten reason codes, a confidence score, an
attempt trail) and an **Approval** when an agent proposes a side-effectful action
(four action types, four risk flags). Both are fully built server-side. Neither
does the two things that matter to the person they were written for:

1. **The Escalation queue has no screen at all.** The API answers "what is waiting
   on me?"; nothing in the product asks it.
2. **Answering does not restart anything.** Approving an action flips a status and
   stops. The record's own documentation says so. The human answers into a void
   and then has to go re-run the work by hand.

This epic ships **My Decisions**: one queue over both records, each row broken
into **typed asks** the human can actually action (choose · approve · fill in a
fact · grant access · do it yourself), and — the point of the whole thing —
**answering the last one restarts the agent where it stopped**, with the answers
in hand.

Three phases, each independently shippable:

- **P1 — The queue and the unblock.** `/decisions`, both record types in one
  ranked list, one derived ask per existing record, answer → resolve → resume the
  parked Run → unblock the blocked Task.
- **P2 — Typed asks, undo, archive.** Agents file decisions carrying up to ten
  typed asks; a too-fast answer can be withdrawn, and the withdrawal is posted
  where the agent will see it; single and bulk archive with restore; an orphan
  sweep.
- **P3 — The health signal.** A rolling read of how much the queue is costing the
  user, a band with a diagnosis on both sides, and detection of the same decision
  being asked over and over so it can be written into the Agent's instructions
  once and stop existing.

---

## 1. Overview

A user opens **My Decisions** and sees every open question their agents cannot
answer alone, in one ranked list: the approvals an agent is waiting on, the
escalations where an agent gave up, the facts only the user has, and the access
grants an agent is missing. Each row opens into a single screen carrying what the
agent was doing, what it already tried, and a short checklist of **typed asks** —
a choice to make, a yes/no to give, a fact to type, an access grant to make, or an
action only a person can take. Each ask has its own control. The user answers
them, adding one sentence of reasoning when they say no or send the agent a
different way. When the last required ask is answered, the decision closes, the
blocked work unblocks, and the agent that stopped is restarted from exactly where
it stopped with the user's answers in its first message — no re-run button, no
chasing. An answer given too quickly can be withdrawn within ten minutes, and the
withdrawal is posted to the agent so its picture of the world stays true. A queue
the user has honestly decided not to answer can be archived in one confirmed
click and restored later. Above the list, a health line says whether the volume of
decisions is what a well-instructed workspace should produce, too much, or
suspiciously little — and points at the fix in each direction.

---

## 2. Why now

### 2.1 The question this answers

> _"What needs me — and will answering it actually make the work continue?"_

That is the second question the program's operating loop turns on, and the only
one whose answer is supposed to be short. If the user cannot see it in one place,
they poll. If answering it does not restart anything, they stop answering.

### 2.2 What a user does today instead

| To find out…                                      | Today they must…                                                                                                                                    |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Whether an agent gave up on something             | Nothing in the web app reads escalations. They must open a Task they already suspect, and read its escalation feed — or notice the Inbox mirror row |
| Whether an agent is waiting on an approval        | Scroll the dashboard Home page to the approval block                                                                                                |
| Which of the two is more urgent                   | Impossible — they are two lists in two places with two orderings, and one of the two lists does not exist                                           |
| What the agent already tried                      | Open the Run's session detail and read the step log                                                                                                 |
| What happens after they approve                   | Nothing happens. The proposal's own record says executing or resuming the approved action is a later increment                                      |
| To actually continue the work                     | Find the Task, find the parked Run, and press Resume by hand — if they know that control exists                                                     |
| Whether an agent is missing an access grant       | Nothing surfaces it. The run fails, and the failure reads as a tool error                                                                           |
| Whether they are being asked too much             | Nothing. There is no count, no trend, no target                                                                                                     |
| To stop looking at a queue they will never answer | Resolve each row one at a time, or leave them open forever — nothing ages out, and no sweeper touches them                                          |

### 2.3 The six concrete gaps

1. **No screen.** The escalation record, its confidence scoring, its dedupe key,
   its attempt trail, its chat tools and its digest copy all ship. No page in the
   web app reads it. The only visible trace is an Inbox row type.
2. **Answering closes the record and stops.** The approval record's own
   documentation states that executing or resuming the approved action is a
   follow-up. Resolving an escalation flips a status. In both cases the work stays
   stopped and the human has to restart it manually.
3. **A decision is one blob of free text.** An escalation carries a single
   free-text "what must be decided". A free-text question cannot be rendered as a
   control, cannot be validated, and cannot tell the platform when it has enough
   to continue. One interruption therefore cannot carry three different shapes of
   answer, so an agent that needs a budget approval _and_ a direction _and_ an
   access grant either asks three times or asks once and guesses twice.
4. **Two queues, two orderings, two mental models.** Escalations rank by
   confidence then recency. Approvals rank by recency and live somewhere else
   entirely. There is no single "what is waiting on me" ordering.
5. **Missing access is not a question, it is a crash.** When an agent lacks a
   connection or a tool grant, the run fails. There is no shape for "I need read
   access to this and then I will carry on".
6. **No volume signal.** A queue with forty open decisions and a queue with two
   look identical, and the product has no opinion about which is healthy. There is
   nothing that turns a repeated question into a permanent instruction.

### 2.4 Why one queue and not two better lists

Approvals and escalations are two _causes_ with one _effect_: an agent stopped and
a person has to speak. The user does not care which record type produced the
interruption; they care how long the list is and whether it drains. Two lists
means two badges, two empty states, two orderings, two habits — and a user who
checks one and misses the other. One queue means one number to drive to zero.

Keeping them as two backing records (rather than migrating one into the other) is
deliberate: both are load-bearing today, both have their own writers, their own
dedupe keys and their own idempotency. My Decisions is a _reader_ over both, plus
one small new record for the typed asks. That is the smallest change that makes
the queue real.

### 2.5 Why answering must restart the work

If answering closes a row but does not restart the work, the queue is a
suggestion box. The user learns that answering is not enough, starts pairing every
answer with a manual re-run, and eventually stops using the queue as the entry
point. Auto-restart is not a convenience feature here — it is the property that
makes the queue worth opening.

---

## 3. User scenarios

### 3.1 Primary scenarios

**S1 — Morning drain.**
**Given** a user with 3 open decisions, one of which has a parked Run,
**when** they open **My Decisions**,
**then** the queue lists all three newest-relevant-first with the blocking one at
the top, the header reads `3 open · 1 blocking`, and the first decision is already
selected in the detail pane so they can answer without a second click.

**S2 — A single approval, answered in one keystroke.**
**Given** a decision whose only ask is "Approve a $240 spend on the data feed",
**when** the user presses `y` (or clicks **Approve**),
**then** the ask is marked answered, the decision closes, the queue header drops to
`2 open`, a toast reads _"Answered. Researcher is picking the work back up."_, and
the agent that raised it is restarted from where it stopped with the approval in
its first message.

**S3 — Three typed asks, one interruption.**
**Given** a decision carrying an approval ask, a choice between two feed tiers,
and an access ask for a read-only analytics connection,
**when** the user answers the approval and the choice,
**then** the checklist shows `2 of 3`, the decision stays open, the blocked Task
stays blocked, and the detail pane says _"One more and Researcher picks this up
where it stopped."_
**And when** they complete the access grant and mark it granted,
**then** the decision closes and the agent restarts with all three answers folded
into one message.

**S4 — Saying no, with a reason.**
**Given** an approval ask for sending a customer-facing message,
**when** the user chooses **Reject**,
**then** a one-sentence reason field appears and is required before the rejection
is accepted, the field's helper text reads _"One sentence is enough. This is what
the agent learns from."_, and on submit the rejection plus the reason travel to the
restarted agent verbatim.

**S5 — Sending the agent a different way.**
**Given** a choice ask with three options and a recommended one,
**when** the user picks the option the agent did **not** recommend,
**then** the reason field appears (required, same as a rejection), and the resumed
agent receives both the chosen option and the reason.

**S6 — Undo within the window.**
**Given** the user answered an ask 90 seconds ago and the restarted Run has not
begun executing,
**when** they press **Undo** on that ask,
**then** the ask returns to unanswered, the decision reopens, the restarted Run is
cancelled if it is still queued, and a withdrawal note is posted so the agent sees
_"The owner withdrew their earlier answer: …"_ — and the user is shown, in plain
words, that undo cannot take back anything the agent already did.

**S7 — Declaring bankruptcy.**
**Given** 34 open decisions the user has honestly decided not to answer,
**when** they choose **Archive all** and confirm the dialog that names the count,
**then** every open decision in the current filter closes as archived, the queue
empties, the **Archived** tab shows 34, and each one can be restored individually.

**S8 — The queue is telling them something.**
**Given** the workspace has opened a median of 11 decisions a day over the last
seven days,
**when** the user opens the queue,
**then** a health line reads _"Heavy — 11 decisions a day. Your agents are asking
things their instructions could answer."_ with a link to the Agent whose
instructions are producing the most of them.

**S9 — The same question for the third time.**
**Given** an agent has asked "which supplier list is authoritative?" three times in
the last fourteen days,
**when** the user opens the third one,
**then** the decision carries a **Asked 3 times** chip and an action reading
_"Write this into Editor's instructions"_ that opens the Agent's instruction file
with the answer pre-filled as a draft rule.

**S10 — Answering from the Task board.**
**Given** a Task sitting in the `Needs you` column carrying a **Decision** chip,
**when** the user clicks that card's **Open decision** action,
**then** they land in My Decisions with that Task's decisions filtered and the
first one selected — the same screen, not a second implementation.

### 3.2 Edge cases, failures and races

**E1 — Two people answer the same ask.**
**Given** two members of the same workspace have the decision open,
**when** both submit an answer to the same ask,
**then** the first write wins, the second is refused with _"Someone else answered
this a moment ago."_, the second user's pane refreshes to show the recorded answer
and who gave it, and nothing is double-resumed.

**E2 — The user answers through the old surface.**
**Given** a decision that also appears as an approval row on Home,
**when** the user approves it there (or through the existing approval or escalation
endpoint, or by replying to its Inbox message),
**then** the decision closes in My Decisions too, any remaining open asks are
recorded as superseded rather than left dangling, and the same restart runs — one
resolution path, three doors.

**E3 — Nothing to restart.**
**Given** a decision whose linked Run was cancelled and whose Task was deleted,
**when** the user answers the last ask,
**then** the decision still closes, and the detail pane says _"Answered. There was
no paused work left to restart."_ rather than pretending something resumed.

**E4 — The agent already restarted on its own.**
**Given** a decision whose linked Run is currently executing (it was never parked),
**when** the user answers the last ask,
**then** the answer is injected into the live Run instead of starting a new one,
and the pane says _"Answered. Sent to the Run that is already going."_

**E5 — The job runtime is not configured.**
**Given** an installation with no background job runtime bound,
**when** the user answers the last ask,
**then** the decision still closes, and a banner reads _"Answered, but the agent
could not be restarted automatically."_ with a **Run now** button that dispatches
manually when a runtime is available. The failure is never silent and never rolls
back the answer.

**E6 — Undo after the point of no return.**
**Given** the restarted Run has already begun executing,
**when** the user opens the ask menu,
**then** **Undo** is disabled with the explanation _"Researcher already acted on
this. Undo cannot unsend or unspend."_ and the only remaining lever offered is
**Open the Run**.

**E7 — Undo after the window closed.**
**Given** the answer was given more than 10 minutes ago,
**when** the user opens the ask menu,
**then** **Undo** is disabled with _"The 10-minute undo window has passed."_ and the
decision detail still shows the answer, who gave it and when.

**E8 — An access ask that was not actually granted.**
**Given** an access ask naming a tool the agent still cannot call,
**when** the user presses **I have granted it**,
**then** the platform re-checks the grant, refuses the resolution, and shows
_"That access still is not granted. Nothing was changed."_ with a link straight to
the place the grant is made — the ask stays open.

**E9 — An access ask the platform cannot verify.**
**Given** an access ask naming an external account the platform has no way to
check,
**when** the user presses **I have granted it**,
**then** the ask closes on the user's word, and the record notes that the grant was
self-reported rather than verified.

**E10 — Over the ask limit.**
**Given** an agent tries to file a decision with 14 asks,
**when** the decision is written,
**then** the first 10 are kept, the decision carries the note _"4 further questions
were not recorded — this decision was too long."_, and the over-limit event is
logged so the agent's instructions can be corrected.

**E11 — Empty queue that should not be celebrated.**
**Given** the workspace has opened zero decisions in the last 14 days,
**when** the user opens the queue,
**then** the empty state reads _"Nothing needs you. That is either very good news
or your agents are deciding things they should be asking about."_ with a link to
recent Runs — not a confetti screen.

**E12 — Genuinely new workspace.**
**Given** a workspace that has never had a decision,
**when** the user opens the queue,
**then** the empty state explains what a decision is and how to tell an agent to
raise one, and does **not** show the over-guessing warning.

**E13 — The queue read fails.**
**Given** the decision list request errors,
**when** the page renders,
**then** it shows an error state with a **Try again** button and the last-known
count if one is cached — it never renders an empty queue, because a false "nothing
needs you" is the most expensive lie this surface can tell.

**E14 — Archive all races an answer.**
**Given** the user confirms **Archive all** while one decision is mid-answer in
another tab,
**when** the bulk write lands,
**then** already-resolved decisions are skipped and reported (_"Archived 33.
1 was already answered."_) and no resolved decision is reopened as archived.

**E15 — Foreign decision id.**
**Given** a deep link to a decision belonging to another workspace,
**when** the user opens it,
**then** the page renders "not found" — never "forbidden" — so the link cannot be
used to prove the decision exists.

**E16 — The blocked Task has other blockers.**
**Given** a Task blocked by both this decision and an unfinished dependency,
**when** the last ask is answered,
**then** the decision closes and the agent is restarted, but the Task stays
`blocked` and the pane says _"Answered. This Task is still waiting on 1 other
blocker."_

**E17 — The queue is longer than one page.**
**Given** 140 open decisions,
**when** the user opens the queue,
**then** the first 25 render, the header reads `140 open`, the position walker in
the detail pane reads `1 / 140`, and paging is by explicit control — the queue
never auto-loads 140 detail payloads.

**E18 — An answer arrives for an already-archived decision.**
**Given** a decision archived in another tab,
**when** the user submits an answer for it,
**then** the write is refused with _"This decision was archived."_, the pane
refreshes to the archived state, and **Restore** is offered.

---

## 4. Functional requirements

Every default, limit and threshold below is a number, and every number is
testable.

### 4.1 The queue

- **FR-1** The system MUST present a single surface, titled **My Decisions**, that
  lists every open Approval and every open Escalation owned by the current user in
  one ranked list.
- **FR-2** The queue MUST offer exactly three tabs: **Open** (default),
  **Answered**, **Archived**.
- **FR-3** The queue header MUST show two counts: the number of open decisions,
  and how many of those are **blocking** (they have a parked Run or a blocked Task
  behind them).
- **FR-4** Open decisions MUST be ranked by, in order: (a) blocking before
  non-blocking; (b) descending confidence, where an unscored decision ranks as if
  its confidence were **0.5** and is labelled _not scored_ rather than shown a
  percentage; (c) ascending age — oldest first among equals.
- **FR-5** The queue MUST support filtering by Agent, by Task, by Mission — the
  standing initiative the Task was raised under, carried as provenance — and by
  ask kind, plus a free-text search over the decision summary. Filters MUST be
  reflected in the URL so a filtered queue is linkable.
- **FR-6** The queue MUST paginate at **25** decisions per page, with a maximum
  requestable page size of **100**.
- **FR-7** While the queue tab is focused, the open count MUST refresh at most
  every **30 seconds**; it MUST NOT poll while the tab is hidden.
- **FR-8** Selecting a decision MUST show a position walker of the form
  `n / total` so the user knows how much of the queue is left.
- **FR-9** The queue MUST NOT render an empty list when the read failed; a failed
  read MUST render an explicit error state (§6.9).

### 4.2 The decision

- **FR-10** A decision MUST display: the Agent that raised it, the Task it belongs
  to and — as provenance — the Mission that Task was raised under, where it has
  them; its age; its confidence (or _not scored_); a one-line summary of what
  happened; and, when the source record carries one, the trail of what the agent
  already tried.
- **FR-11** A decision MUST display whether it is blocking, and what it is blocking
  — a named Task (`blocked`) or a named parked Run — with a link to each. A
  Mission is never itself blocked; it appears only as the provenance chip on the
  decision.
- **FR-12** A decision MUST NOT ask the user a bare question: it MUST carry at
  least one ask, and every ask MUST carry a prompt of at most **1000** characters
  and optional context of at most **4000** characters.
- **FR-13** Every existing open Approval and open Escalation MUST appear in the
  queue with a derived ask, so the surface is complete on the day it ships without
  any agent-side change.
- **FR-14** A decision MUST record the first time a human viewed it, so time-to-
  decide is measurable.

### 4.3 Asks and their kinds

- **FR-15** A decision MUST carry between **1** and **10** asks. An attempt to file
  more MUST keep the first 10, record how many were dropped, and surface that on
  the decision (§3.2 E10).
- **FR-16** Every ask MUST be one of exactly five kinds, each with its own control:

    | Kind         | What the user produces                               | Control                                                         |
    | ------------ | ---------------------------------------------------- | --------------------------------------------------------------- |
    | **Decision** | A choice between the agent's enumerated options      | Single-select, or multi-select when the agent asked for several |
    | **Approval** | A yes/no on a proposed action                        | Approve / Reject, with the action and its risks shown           |
    | **Fact**     | Information only the user has                        | A single- or multi-line text field                              |
    | **Access**   | A permission, connection or grant the agent lacks    | A link to where the grant is made, plus **I have granted it**   |
    | **Action**   | Something only a person can do, outside the platform | **Mark done**, with an optional note                            |

- **FR-17** A **Decision** ask MUST support at most **25** options, each with a
  label of at most **200** characters, and MAY mark exactly one option as
  recommended.
- **FR-18** A **Fact** ask MUST accept at most **4000** characters.
- **FR-19** An **Access** ask MUST name what is needed in the user's language and
  MUST link to the surface where that grant is made. Where the ask names a tool
  pattern the platform can evaluate, the platform MUST re-check the grant on
  resolution and refuse the resolution if the access is still denied (§3.2 E8).
  Where it cannot be evaluated, the ask MUST close on the user's word and be
  recorded as self-reported (§3.2 E9).
- **FR-20** An ask MUST be individually resolvable and MUST NOT depend on the order
  in which its siblings are answered.
- **FR-21** An ask MAY be marked optional. Only **required** asks gate the
  decision's resolution; an unanswered optional ask MUST NOT hold the work.
- **FR-22** The system MUST show progress as `answered / required` on both the
  decision card and the detail pane.

### 4.4 Answering

- **FR-23** Answering an ask MUST validate the answer against the shape of the ask
  and MUST reject a mismatched answer with a specific message rather than storing
  it.
- **FR-24** A **rejection** on an approval ask, and a choice of any option other
  than the recommended one on a decision ask, MUST require a reason of between
  **1** and **1000** characters before the answer is accepted.
- **FR-25** A reason MUST be optional in every other case, and capped at the same
  **1000** characters.
- **FR-26** Answering MUST be idempotent per ask: a second answer to an
  already-answered ask MUST be refused with a conflict, and MUST return the
  recorded answer and its author (§3.2 E1).
- **FR-27** The system MUST record, for every answered ask, who answered it and
  when.
- **FR-28** Answering the final required ask MUST close the decision, marking the
  backing record resolved (escalation) or approved/rejected (approval) using the
  existing semantics of that record.
- **FR-29** Resolving a decision through any pre-existing path — the approval
  endpoints, the escalation resolve endpoint, the escalation chat tool, or an
  Inbox reply — MUST produce the same outcome: open asks are closed as
  **superseded**, and the same unblock runs (§3.2 E2).

### 4.5 Auto-unblock and restart

- **FR-30** When a decision closes, the system MUST compose a single message
  containing every ask, its answer, and its reason where one was given, and MUST
  deliver that message to the agent that raised the decision.
- **FR-31** Delivery MUST follow this precedence, and the outcome MUST be shown to
  the user in words:
    1. The linked Run is **live** → inject the message into it (_"Sent to the Run
       that is already going."_).
    2. The linked Run is **parked or resumable** → restart it as a new Run carrying
       the same conversation, seeded with the message (_"Researcher is picking the
       work back up."_).
    3. Neither applies → resolve without restarting, and say so (_"There was no
       paused work left to restart."_).
- **FR-32** A restarted Run MUST continue the same conversation the parked Run was
  holding — it MUST NOT be a fresh start.
- **FR-33** If the decision's Task is `blocked` and this decision was its only
  remaining blocker, the Task MUST be returned to the status it held before it was
  blocked. If other blockers remain, the Task MUST stay blocked and the user MUST
  be told how many remain (§3.2 E16).
- **FR-34** A failure to restart MUST NOT roll back the answer. The decision stays
  closed, the failure is surfaced with a manual **Run now** action, and the reason
  is recorded (§3.2 E5).
- **FR-35** The restart MUST go through the platform's normal admission path, so a
  restarted Run is subject to the same concurrency limits and budget checks as any
  other Run. A restart that is queued rather than started MUST be shown as
  _"Queued — waiting for a free slot."_
- **FR-36** The system MUST NOT execute the proposed action itself on approval.
  Approval hands the decision back to the agent, which performs the action under
  its existing permissions and guardrails.

### 4.6 Undo and the posted withdrawal

- **FR-37** An answered ask MUST offer **Undo** while both of these hold: the
  answer is less than **10 minutes** old, and no Run restarted by that answer has
  begun executing.
- **FR-38** When either condition fails, **Undo** MUST be visibly disabled with the
  specific reason (§3.2 E6, E7) — never silently absent.
- **FR-39** Undo MUST return the ask to unanswered, reopen the decision, and — when
  the restarted Run is still queued — cancel that Run.
- **FR-40** Undo MUST post a withdrawal that reaches the agent: injected into a
  live Run where one exists, and otherwise recorded on the decision and on the
  Task's thread. The withdrawal MUST name what was withdrawn.
- **FR-41** The undo control MUST state, in the interface and not only in
  documentation, that undo cannot reverse an action the agent already took.
- **FR-42** Undo MUST be recorded with its author and timestamp, and MUST NOT erase
  the withdrawn answer from the record.

### 4.7 Archive

- **FR-43** A single decision MUST be archivable from the queue and from its detail
  pane, and MUST be restorable from the **Archived** tab.
- **FR-44** **Archive all** MUST archive every open decision matching the current
  filter, behind a confirmation dialog that names the exact count.
- **FR-45** **Archive all** MUST process at most **200** decisions per invocation;
  above that the dialog MUST say how many will be archived and that the action can
  be repeated.
- **FR-46** Archiving MUST NOT resolve, approve or reject anything: an archived
  decision is an unanswered decision the user has set aside. It MUST NOT trigger a
  restart.
- **FR-47** Decisions already resolved between the dialog opening and the
  confirmation MUST be skipped and counted in the result (§3.2 E14).
- **FR-48** Restoring an archived decision MUST return it to **Open** with its asks
  in the state they were in, and MUST NOT restart anything by itself.
- **FR-49** A decision whose backing work is gone — Run cancelled and Task deleted
  — MUST be archived automatically within **30 minutes**, with the reason recorded
  and shown as _"Archived automatically — the work it belonged to is gone."_
- **FR-50** A decision open for more than **30 days** with no live linked work MUST
  be flagged **dormant** in the queue. It MUST NOT be archived automatically —
  ageing out an unanswered question silently is worse than showing it.

### 4.8 The health signal

- **FR-51** The queue MUST display a health line derived from the number of
  decisions **opened per day**, taken as the median over the trailing **7 days**,
  together with the number currently open.
- **FR-52** The bands MUST be:

    | Band        | Condition                                           | Line the user reads                                                                               |
    | ----------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
    | **Quiet**   | 0 opened in the trailing **14 days**                | "Nothing has needed you in two weeks. Worth spot-checking what your agents decided on their own." |
    | **Healthy** | median **1–5** per day                              | "Healthy — about {n} decisions a day."                                                            |
    | **Heavy**   | median **6–15** per day                             | "Heavy — {n} decisions a day. Your agents are asking things their instructions could answer."     |
    | **Flooded** | median **> 15** per day, or **> 25** open right now | "Flooded — {n} open. Answer what matters, archive the rest, then fix the instructions."           |

- **FR-53** The user MUST be able to override the healthy ceiling (default **5**)
  and the quiet window (default **14** days) per workspace, within **1–100** and
  **3–90** respectively.
- **FR-54** The **Heavy** and **Flooded** lines MUST name the Agent that produced
  the most decisions in the window and link to its instructions.
- **FR-55** The health snapshot MUST be recomputed at least once a day, and MUST
  never block the queue read — an unavailable snapshot hides the line rather than
  failing the page.

### 4.9 Recurring decisions

- **FR-56** The system MUST detect when the same Agent has raised a
  substantially-identical decision **3 or more times** within the trailing
  **14 days**, and MUST mark each member of that cluster with an **Asked N times**
  chip.
- **FR-57** A clustered decision MUST offer an action that opens the raising
  Agent's instructions with a draft rule pre-filled from the user's most recent
  answer to that cluster.
- **FR-58** Clustering MUST be advisory only: it MUST NOT auto-answer, auto-archive
  or suppress any decision.

### 4.10 Permissions, scope and limits

- **FR-59** Every read and write MUST be owner-scoped. A decision belonging to
  another workspace MUST read as **not found**, never as forbidden.
- **FR-60** Where a decision is answered by someone other than the user who owns
  the work, the decision MUST show who decided it.
- **FR-61** Read endpoints MUST be throttled at **60 requests per minute** per
  user; write endpoints at **30 per minute**; **Archive all** at **5 per minute**.
- **FR-62** Answering MUST NOT be possible on an archived decision; the attempt
  MUST be refused with a specific message and **Restore** offered (§3.2 E18).
- **FR-63** Every user-visible string on this surface MUST come from the
  translation catalogue; none may be hard-coded.

### 4.11 Accessibility

- **FR-64** The queue MUST be fully operable from the keyboard, with the bindings
  in §6.17, and every binding MUST be discoverable from an on-screen help affordance.
- **FR-65** Each ask control MUST be a labelled form control with its prompt as its
  accessible name, and the required-reason field MUST be programmatically
  associated with the control that made it required.
- **FR-66** Answering MUST announce its outcome to assistive technology through a
  polite live region — the toast alone is not sufficient.
- **FR-67** The blocking indicator, the confidence label and the health band MUST
  each carry a text label; colour MUST NOT be the only carrier of meaning.

---

## 5. Key entities

### 5.1 Already in Ever Works — extended, not replaced

| Concept                                                                                                                                                                             | What it is today                                                                                                                                                                                      | What this epic adds                                                                                                                                                                          |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Approval** (an agent's proposed side-effectful action: spawn an agent, schedule a task, send a message, override a budget; with risk flags and a pending/approved/rejected state) | A durable queue and decision record. Deciding it flips a status and, by its own documentation, restarts nothing                                                                                       | An `archived` state · a Task link and, through it, the Mission that raised the Task, both stored for filtering · a first-viewed timestamp · one or more **Asks** · restart-on-resolution     |
| **Escalation** (the record written when an agent gives up: ten reason codes, an attempt trail, a confidence score, a dedupe key, open/resolved)                                     | Fully built server-side, with chat tools and an Inbox mirror, and **no screen at all**                                                                                                                | An `archived` state · the Mission that raised its Task, stored for filtering · a first-viewed timestamp · one or more **Asks** · restart-on-resolution · a queue that reads it               |
| **Run**                                                                                                                                                                             | One agent execution; already knows how to park on a question, and already knows how to be restarted as a new Run carrying the same conversation                                                       | Nothing. This epic _uses_ the park/restart behaviour that exists; it does not re-implement it                                                                                                |
| **Task**                                                                                                                                                                            | Already has a `blocked` status that remembers the status it came from                                                                                                                                 | Nothing. Unblocking uses the existing restore-to-previous behaviour                                                                                                                          |
| **Mission**                                                                                                                                                                         | A standing initiative that keeps producing Ideas and, through them, Works and Tasks. Statuses `active` / `paused` / `completed` / `failed`; no priority; it is a _source_ of work, never a unit of it | Nothing new. A decision reaches its Mission through its Task, and shows it as a provenance chip and offers it as a filter. Answering a decision never resolves, pauses or unblocks a Mission |
| **Inbox**                                                                                                                                                                           | The operator message center, which already mirrors escalations and approvals as messages and already routes a reply back to the record                                                                | Nothing removed. Inbox rows for a decision gain a link into My Decisions, and the two surfaces share one resolution path so their behaviour cannot drift                                     |
| **Agent instructions**                                                                                                                                                              | The Agent's own instruction files                                                                                                                                                                     | Nothing stored. The recurring-decision action opens them with a draft rule                                                                                                                   |
| **Activity history**                                                                                                                                                                | The audit trail                                                                                                                                                                                       | New entry kinds for opened / answered / resolved / withdrawn / archived / restarted                                                                                                          |

### 5.2 Decision — the queue row (a projection, not a table)

A **Decision** is the program's user-facing word for "an Approval or an Escalation
that is waiting on a human". It is projected at read time from whichever record
backs it. It is **not** a new table, and the two backing records keep their own
lifecycles, their own writers and their own idempotency keys.

```
  DECISION LIFECYCLE (derived from the backing record + its Asks)

                       ┌──────────────────────────────────┐
      agent raises ───►│              OPEN                │
      it (approval     │  every required Ask unanswered   │
      or escalation)   │  or partly answered              │
                       └───┬──────────────┬───────────────┘
                           │              │
       last required Ask   │              │  user archives it,
       answered            │              │  or Archive all,
                           ▼              │  or the work is gone
                       ┌──────────┐       ▼
                       │ RESOLVED │   ┌──────────┐
                       └────┬─────┘   │ ARCHIVED │
                            │         └────┬─────┘
          undo, within 10   │              │ restore
          min and before    │              │
          the Run started   └──────────────┴──────► back to OPEN
```

- **Open** — at least one required Ask is unanswered. The work behind it does not
  proceed.
- **Resolved** — every required Ask is answered. The backing record is marked
  `resolved` (escalation) or `approved` / `rejected` (approval) with today's exact
  meaning. The restart has been attempted and its outcome recorded.
- **Archived** — set aside unanswered. No restart. Restorable.

**Blocking** is derived, never stored: a decision is blocking when its linked Run
is parked or its linked Task is `blocked`. **Dormant** is derived: open for more
than 30 days with no live linked work.

### 5.3 New noun — the **Ask**

**Definition.** One typed question inside a Decision, with its own control, its own
answer, and its own resolved state. A Decision is blocked until every _required_
Ask is answered.

**Why this is a new stored noun and not a reuse.** Three candidates were
considered and all three are the wrong shape:

- _The escalation's free-text "what must be decided" field_ is a paragraph. A
  paragraph cannot be rendered as a control, cannot be validated, cannot be
  half-answered, and cannot tell the platform when it has enough to restart the
  work. It is exactly the thing this epic exists to replace — and it stays, as the
  fallback prompt for the derived Ask, so nothing breaks.
- _A second escalation per question_ would multiply notifications, multiply
  dedupe keys, and split one interruption into three, which is the opposite of the
  goal. It would also make "is this Task unblocked yet?" a query over an
  unbounded set instead of a count.
- _The Task approver record_ gates a Task's review-to-done transition. It is a
  different gate at a different point in a different lifecycle, and it is not
  attached to a run that can be restarted.

The Ask is deliberately built on the platform's **existing typed
human-in-the-loop question shapes** — the discriminated union of confirm, choice,
multi-choice, text and approval that already ships as a shared value type and is
already rendered by the chat canvas. This epic adds two members to that union
(**access** and **action**) and gives the whole thing a home in storage. Nothing
about the shape is invented here; what is new is that it is persisted, queued and
answerable.

**States.**

```
        ┌──────────┐   answer (validated)    ┌───────────┐
        │   OPEN   │────────────────────────►│ ANSWERED  │
        └────┬─────┘                         └─────┬─────┘
             │                                     │ undo, within 10 min
             │  the decision was resolved          │ and before the Run started
             │  through another door               ▼
             ▼                                ┌───────────┐
        ┌────────────┐                        │ WITHDRAWN │
        │ SUPERSEDED │◄───────────────────────┴─────┬─────┘
        └────────────┘   (never re-opens)           │ returns the Ask to
                                                    └──► OPEN
```

- **Open** — unanswered. A required open Ask holds the Decision.
- **Answered** — carries the answer, the optional reason, the author and the time.
- **Withdrawn** — answered and then undone. The withdrawn answer is kept; a
  withdrawal note has been posted to the agent. The Ask returns to Open.
- **Superseded** — the Decision was closed through a pre-existing path without this
  Ask being answered. Terminal; recorded so the trail is honest.

**Kinds.** Five, listed in FR-16. The kind determines the control, the shape of a
valid answer, and whether a reason is required.

### 5.4 Explicitly not new entities

- **No decision table.** The queue is a projection over two existing records. A
  third record would be a third place to write, a third dedupe key, and a third
  thing to keep in sync.
- **No decision thread.** A decision links to the Task's existing comment thread,
  the one the board surfaces (AW-02). Withdrawals and reasons are posted there, not
  into a second conversation surface. There is no Mission-scoped thread and this
  epic does not invent one.
- **No decision assignee.** Every decision belongs to the workspace, and any
  member who can see the work can answer it. Routing a decision to a named person
  needs a per-organisation role model that does not exist yet (§9).
- **No new notification channel.** Escalations and approvals already notify and
  already mirror into the Inbox. AW-13 owns the notification matrix; this epic
  changes no default.
- **No health-snapshot table in P1 or P2.** The band is computed from the two
  backing records. P3 stores a small daily roll-up only because recomputing a
  7-day median on every page load is wasteful, not because the number is new.

---

## 6. UX

### 6.1 Where it lives

A new top-level surface at `/decisions`, titled **My Decisions**, with a sidebar
entry directly under **Dashboard** and above **Inbox**, carrying a count badge of
open decisions. The tab and the selected decision are both in the URL
(`?tab=open|answered|archived`, `?id=<decision>`), so any state of the queue is
linkable.

Four other surfaces link _in_ and none of them re-implements it:

- **Home** — the existing approval block gains a footer link _"See all decisions
  (3)"_; the block itself is unchanged.
- **Task board** (AW-02) — a card's **Decision** chip opens the queue filtered to
  that Task.
- **Inbox** — an escalation or approval message gains **Open in My Decisions**.
- **Task detail** — the escalation feed gains the same link per row.

### 6.2 Queue — populated

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│ My Decisions                                                                     │
│ Everything waiting on you, and nothing else.                                     │
│                                                                                  │
│  ● 3 open  ·  ⏸ 1 blocking                             [ Archive all ]  [ ? ]    │
│                                                                                  │
│  ┌───────┬──────────┬──────────┐   ┌──────────────────────────────────────────┐  │
│  │ Open 3│ Answered │ Archived │   │🔍 Search  Agent ▾ Task ▾ Mission ▾ Kind ▾│  │
│  └═══════┴──────────┴──────────┘   └──────────────────────────────────────────┘  │
│                                                                                  │
│  ✓ Healthy — about 3 decisions a day.                                            │
├──────────────────────────────────────┬───────────────────────────────────────────┤
│ QUEUE                          1 / 3 │  DETAIL                                    │
│                                      │                                            │
│ ┌──────────────────────────────────┐ │  ┌──────────────────────────────────────┐  │
│ │▌Spend $240 on the data feed      │ │  │ Spend $240 on the data feed          │  │
│ │ Researcher · Refresh the pricing │ │  │ Researcher · 2h ago · 82% sure        │  │
│ │ page · 2h · ⏸ BLOCKING           │ │  │ ⏸ Blocking: Run paused · Task blocked │  │
│ │ 1 of 3 answered      ●●●○○○      │ │  │ Task: Refresh the pricing page  →     │  │
│ └──────────────────────────────────┘ │  ├──────────────────────────────────────┤  │
│ ┌──────────────────────────────────┐ │  │ WHAT HAPPENED                         │  │
│ │ Which supplier list is right?    │ │  │ The paid feed returned 402 and the    │  │
│ │ Editor · 5h · Asked 3 times      │ │  │ cached copy is 9 days old.            │  │
│ │ 0 of 1 answered      ○           │ │  │                                       │  │
│ └──────────────────────────────────┘ │  │ WHAT IT TRIED                         │  │
│ ┌──────────────────────────────────┐ │  │  • fetch feed    402 payment required │  │
│ │ Read access to Analytics         │ │  │  • cached copy   9 days stale         │  │
│ │ Ops · 1d · not scored            │ │  │  • free tier     missing 3 of 5 fields│  │
│ │ 0 of 1 answered      ○           │ │  ├──────────────────────────────────────┤  │
│ └──────────────────────────────────┘ │  │ WHAT THIS NEEDS FROM YOU     1 of 3   │  │
│                                      │  │                                       │  │
│           [ Load 25 more ]           │  │  ✓ 1  Approve the $240 spend          │  │
│                                      │  │       Approved by you · 2 min ago  ⋯  │  │
│                                      │  │                                       │  │
│                                      │  │  ○ 2  Which feed tier should it buy?  │  │
│                                      │  │       ( ) Standard — $240/mo          │  │
│                                      │  │       (•) Pro — $480/mo  RECOMMENDED  │  │
│                                      │  │       ( ) Stay on the cached copy     │  │
│                                      │  │       [ Answer ]                      │  │
│                                      │  │                                       │  │
│                                      │  │  ○ 3  Grant read access to Analytics  │  │
│                                      │  │       [ Open connections ↗ ]          │  │
│                                      │  │       [ I have granted it ]           │  │
│                                      │  │                                       │  │
│                                      │  │  Answer all three and Researcher      │  │
│                                      │  │  picks this up where it stopped.      │  │
│                                      │  ├──────────────────────────────────────┤  │
│                                      │  │ [ Archive ]           [ Open Run ↗ ]  │  │
│                                      │  └──────────────────────────────────────┘  │
└──────────────────────────────────────┴───────────────────────────────────────────┘
```

### 6.3 The five ask controls

**Decision (single choice).**

```
 ○ 2  Which feed tier should it buy?
      The Pro tier is the only one carrying the three fields the page needs.

      ( ) Standard — $240/mo
      (•) Pro — $480/mo                              RECOMMENDED
      ( ) Stay on the cached copy                    ⚠ page goes stale

      Why? (required — you picked a different option than recommended)
      ┌──────────────────────────────────────────────────────────┐
      │ Budget is capped this quarter; stale beats overspend.    │
      └──────────────────────────────────────────────────────────┘
      One sentence is enough. This is what the agent learns from.

      [ Answer ]   [ Cancel ]
```

**Decision (multi-select)** is the same control with checkboxes and a
`Choose 1–3` hint under the prompt.

**Approval.**

```
 ○ 1  Approve the $240 spend on the data feed?
      ACTION   Purchase the Standard data-feed tier for one month.
      RISKS    • Spends real money   • Recurring until cancelled

      [ Approve ]   [ Reject ]

      — after pressing Reject —
      Why? (required)
      ┌──────────────────────────────────────────────────────────┐
      │                                                          │
      └──────────────────────────────────────────────────────────┘
      [ Confirm rejection ]   [ Cancel ]
```

**Fact.**

```
 ○ 3  What is the VAT rate we charge in Ireland?
      Only you know this — it is not in the Knowledge Base.

      ┌──────────────────────────────────────────────────────────┐
      │ 23%                                                      │
      └──────────────────────────────────────────────────────────┘
      0 / 4000

      [ Answer ]
```

**Access.**

```
 ○ 3  Ops needs read access to Analytics.
      It cannot finish the traffic summary without it.

      NEEDS   analytics.read
      [ Open connections ↗ ]

      [ I have granted it ]

      — if the platform can still not see the grant —
      ⚠ That access still is not granted. Nothing was changed.
```

**Action.**

```
 ○ 2  Sign the supplier agreement in the finance portal.
      The agent cannot reach that system.

      Note (optional)
      ┌──────────────────────────────────────────────────────────┐
      │ Signed 6 Sep, reference SUP-2214.                        │
      └──────────────────────────────────────────────────────────┘

      [ Mark done ]
```

### 6.4 Answered ask, and the ask menu

```
 ✓ 1  Approve the $240 spend
      Approved by you · 2 minutes ago                              ⋯
      "Budget is capped this quarter."
                                      ┌─────────────────────────────┐
                                      │ Undo                        │
                                      │ Copy answer                 │
                                      │ Open Run ↗                  │
                                      └─────────────────────────────┘
```

Disabled-undo variants, shown in place of the enabled item:

```
 │ Undo — Researcher already acted on this.       │   (E6)
 │ Undo cannot unsend or unspend.                 │
 └────────────────────────────────────────────────┘

 │ Undo — the 10-minute window has passed.        │   (E7)
 └────────────────────────────────────────────────┘
```

After an undo:

```
 ↺ 1  Approve the $240 spend            WITHDRAWN
      You withdrew this 4 seconds ago. Researcher has been told.
      Previous answer: Approved — "Budget is capped this quarter."

      [ Approve ]   [ Reject ]
```

### 6.5 Resolved decision

```
┌──────────────────────────────────────────────────────────────────┐
│ Spend $240 on the data feed                        ✓ ANSWERED     │
│ Researcher · answered by you · 6 Sep, 09:14                       │
│                                                                   │
│ ✓ Researcher is picking the work back up.        [ Open Run ↗ ]   │
│                                                                   │
│ ✓ 1  Approve the $240 spend — Approved                            │
│ ✓ 2  Which feed tier? — Standard                                  │
│      "Budget is capped this quarter."                             │
│ ✓ 3  Grant read access to Analytics — Granted                     │
│                                                                   │
│ [ Next decision → ]                                               │
└──────────────────────────────────────────────────────────────────┘
```

Restart-outcome variants, one line each, in place of the green line above:

```
 ✓ Sent to the Run that is already going.               [ Open Run ↗ ]     (E4)
 ✓ Answered. There was no paused work left to restart.                     (E3)
 ⏳ Queued — waiting for a free slot.                    [ Open Run ↗ ]     (FR-35)
 ⚠ Answered, but the agent could not be restarted automatically.
   [ Run now ]                                                             (E5)
 ✓ Answered. This Task is still waiting on 1 other blocker. [ Open Task ↗ ] (E16)
```

### 6.6 Loading

```
┌──────────────────────────────────────┬───────────────────────────────────────────┐
│ ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒ │  ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒ │
│ ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒                │  ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒                │
│                                       │                                           │
│ ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒ │  ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒ │
│ ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒                │  ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒ │
│                                       │  ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒             │
│ three skeleton cards, no counts,      │                                           │
│ no health line until the read lands   │  skeleton detail, no controls             │
└──────────────────────────────────────┴───────────────────────────────────────────┘
```

The header count and the health line are **absent** while loading — never `0`.

### 6.7 Empty — all clear, and it has been quiet

```
┌──────────────────────────────────────────────────────────────────────┐
│                                                                       │
│                              ✓                                        │
│                                                                       │
│                   Nothing needs you right now.                        │
│                                                                       │
│      That is either very good news, or your agents are deciding       │
│      things they should be asking you about.                          │
│                                                                       │
│              [ Review recent Runs ]   [ Safety rails ]                │
│                                                                       │
│      Nothing has needed you in 14 days.                               │
└──────────────────────────────────────────────────────────────────────┘
```

### 6.8 Empty — never had one

```
┌──────────────────────────────────────────────────────────────────────┐
│                                                                       │
│                    No decisions yet.                                  │
│                                                                       │
│      When an agent hits something it should not decide alone —        │
│      spending money, reaching a customer, choosing between two        │
│      real directions — it stops and asks you here.                    │
│                                                                       │
│      Tell an agent when to ask by writing it into its                 │
│      instructions.                                                    │
│                                                                       │
│                       [ Open Agents ]                                 │
└──────────────────────────────────────────────────────────────────────┘
```

### 6.9 Error

```
┌──────────────────────────────────────────────────────────────────────┐
│                              ⚠                                        │
│                Could not load your decisions.                         │
│                                                                       │
│      We did not show an empty queue, because we cannot tell           │
│      whether it is empty.                                             │
│                                                                       │
│                     [ Try again ]                                     │
│                                                                       │
│      Last known: 3 open, 2 minutes ago.                               │
└──────────────────────────────────────────────────────────────────────┘
```

### 6.10 Over-limit — a decision that carried too many asks

```
 WHAT THIS NEEDS FROM YOU                                         0 of 10

  ○ 1 …                                             (ten asks render)
  …
  ○ 10 …

  ⚠ 4 further questions were not recorded — this decision was too long.
    Answer these ten; the agent will ask again if it still needs more.
```

### 6.11 Archive all — confirmation

```
┌──────────────────────────────────────────────────────────────────┐
│  Archive 34 decisions?                                            │
│                                                                   │
│  They close unanswered. Nothing restarts and nothing is           │
│  approved. You can restore any of them from Archived.             │
│                                                                   │
│  Filtered by: Agent = Editor                                      │
│                                                                   │
│                          [ Cancel ]  [ Archive 34 ]               │
└──────────────────────────────────────────────────────────────────┘
```

Above 200:

```
│  Archive 200 of 412 decisions?                                    │
│  This archives the oldest 200. Run it again for the rest.         │
```

Result toast: `Archived 33. 1 was already answered.`

### 6.12 Archived tab

```
┌───────┬──────────┬────────────┐
│ Open  │ Answered │ Archived 34│
└───────┴──────────┴════════════┘

┌────────────────────────────────────────────────────────────────┐
│ Which supplier list is right?                                   │
│ Editor · archived by you · 6 Sep                    [ Restore ] │
└────────────────────────────────────────────────────────────────┘
┌────────────────────────────────────────────────────────────────┐
│ Approve the retry budget                                        │
│ Ops · archived automatically — the work it belonged to is gone  │
│                                                     [ Restore ] │
└────────────────────────────────────────────────────────────────┘
```

### 6.13 Health line — the four bands

```
 ✓ Healthy — about 3 decisions a day.
 ─────────────────────────────────────────────────────────────────────
 ◐ Heavy — 11 decisions a day. Your agents are asking things their
   instructions could answer.  Most of them: Editor.  [ Open instructions ]
 ─────────────────────────────────────────────────────────────────────
 ⚠ Flooded — 41 open. Answer what matters, archive the rest, then fix
   the instructions.  Most of them: Editor.  [ Open instructions ]
 ─────────────────────────────────────────────────────────────────────
 ○ Nothing has needed you in two weeks. Worth spot-checking what your
   agents decided on their own.  [ Review recent Runs ]
```

Each line carries a `⋯` menu with **Adjust the band** and **Hide for 30 days**.

### 6.14 Recurring chip

```
┌──────────────────────────────────────┐
│ Which supplier list is right?        │
│ Editor · 5h · ⟳ Asked 3 times        │
└──────────────────────────────────────┘

 in the detail pane, above the asks:

 ⟳ Editor has asked this 3 times in 14 days.
   [ Write this into Editor's instructions ]
```

### 6.15 Narrow viewports (below 768 px)

The two panes stack. The queue list is shown first; selecting a decision replaces
it with the detail pane and a back control. The position walker moves to the
detail header (`1 / 3`), and `Next decision →` becomes the primary control after
an answer so the queue can be walked one-handed.

```
┌──────────────────────────────┐
│ ← My Decisions        1 / 3  │
├──────────────────────────────┤
│ Spend $240 on the data feed  │
│ Researcher · 2h · ⏸ blocking │
│                              │
│ WHAT THIS NEEDS FROM YOU 1/3 │
│  ✓ 1 Approve the $240 spend  │
│  ○ 2 Which feed tier?        │
│  ○ 3 Grant read access       │
│                              │
│ [ Answer ]                   │
└──────────────────────────────┘
```

### 6.16 Entry points

```
 Sidebar                Home                        Task board (AW-02)
 ┌──────────────┐       ┌──────────────────────┐    ┌──────────────────────┐
 │ Dashboard    │       │ Action approvals   2 │    │ ● Needs you        3 │
 │ My Decisions 3│  ◄── │ …                    │    │ [card] ⏸ 1 decision  │──►
 │ Inbox        │       │ See all decisions (3)│──► │                      │
 │ Activity     │       └──────────────────────┘    └──────────────────────┘
 └──────────────┘
```

### 6.17 Keyboard affordances

| Key       | Where                      | Does                                                        |
| --------- | -------------------------- | ----------------------------------------------------------- |
| `j` / `↓` | queue                      | Move to the next decision                                   |
| `k` / `↑` | queue                      | Move to the previous decision                               |
| `Enter`   | queue                      | Open the focused decision's first unanswered ask            |
| `1`–`9`   | detail                     | Focus the nth ask                                           |
| `y`       | detail, on an approval ask | Approve                                                     |
| `n`       | detail, on an approval ask | Reject (opens the required reason field)                    |
| `w`       | detail                     | Focus the reason ("why") field                              |
| `Enter`   | an ask control             | Submit that ask's answer                                    |
| `u`       | detail                     | Undo the most recently answered ask, when undo is available |
| `e`       | detail                     | Archive the current decision                                |
| `]`       | detail                     | Next decision                                               |
| `[`       | detail                     | Previous decision                                           |
| `?`       | anywhere on the surface    | Show this table                                             |
| `Esc`     | detail                     | Return focus to the queue list                              |

Every binding is inert while focus is inside a text field except `Esc` and
`Enter`. The `?` sheet is the discoverability requirement of FR-64.

### 6.18 Exact user-visible copy

| Where                          | String                                                                                                                                                              |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Page title                     | `My Decisions`                                                                                                                                                      |
| Page subtitle                  | `Everything waiting on you, and nothing else.`                                                                                                                      |
| Header counts                  | `{count} open` · `{count} blocking`                                                                                                                                 |
| Tabs                           | `Open` · `Answered` · `Archived`                                                                                                                                    |
| Filters                        | `Agent` · `Task` · `Mission` · `Kind` · `Search decisions`                                                                                                          |
| Ask section heading            | `What this needs from you`                                                                                                                                          |
| Ask progress                   | `{answered} of {required}`                                                                                                                                          |
| Context heading                | `What happened`                                                                                                                                                     |
| Attempt-trail heading          | `What it tried`                                                                                                                                                     |
| Blocking chip                  | `Blocking`                                                                                                                                                          |
| Blocking detail                | `Run paused` · `Task blocked`                                                                                                                                       |
| Confidence                     | `{percent}% sure` · `not scored`                                                                                                                                    |
| Dormant chip                   | `Open 30+ days`                                                                                                                                                     |
| Recurring chip                 | `Asked {count} times`                                                                                                                                               |
| Recurring action               | `Write this into {agent}'s instructions`                                                                                                                            |
| Recommended option             | `RECOMMENDED`                                                                                                                                                       |
| Approval buttons               | `Approve` · `Reject` · `Confirm rejection`                                                                                                                          |
| Choice button                  | `Answer`                                                                                                                                                            |
| Fact button                    | `Answer`                                                                                                                                                            |
| Access buttons                 | `Open connections` · `I have granted it`                                                                                                                            |
| Action button                  | `Mark done`                                                                                                                                                         |
| Reason label (required)        | `Why? (required)`                                                                                                                                                   |
| Reason label (optional)        | `Why? (optional)`                                                                                                                                                   |
| Reason helper                  | `One sentence is enough. This is what the agent learns from.`                                                                                                       |
| Multi-select hint              | `Choose {min}–{max}`                                                                                                                                                |
| Pending line, partial          | `Answer all {count} and {agent} picks this up where it stopped.`                                                                                                    |
| Pending line, last one         | `One more and {agent} picks this up where it stopped.`                                                                                                              |
| Restart — resumed              | `{agent} is picking the work back up.`                                                                                                                              |
| Restart — injected             | `Sent to the Run that is already going.`                                                                                                                            |
| Restart — nothing              | `Answered. There was no paused work left to restart.`                                                                                                               |
| Restart — queued               | `Queued — waiting for a free slot.`                                                                                                                                 |
| Restart — failed               | `Answered, but the agent could not be restarted automatically.`                                                                                                     |
| Restart — other blockers       | `Answered. This Task is still waiting on {count} other blocker(s).`                                                                                                 |
| Undo menu item                 | `Undo`                                                                                                                                                              |
| Undo blocked — acted           | `Undo — {agent} already acted on this. Undo cannot unsend or unspend.`                                                                                              |
| Undo blocked — window          | `Undo — the 10-minute window has passed.`                                                                                                                           |
| Withdrawn banner               | `You withdrew this {time}. {agent} has been told.`                                                                                                                  |
| Withdrawal posted to the agent | `The owner withdrew their earlier answer to "{prompt}".`                                                                                                            |
| Conflict on answer             | `Someone else answered this a moment ago.`                                                                                                                          |
| Conflict on archived           | `This decision was archived.`                                                                                                                                       |
| Archive button                 | `Archive`                                                                                                                                                           |
| Archive all button             | `Archive all`                                                                                                                                                       |
| Archive dialog title           | `Archive {count} decisions?`                                                                                                                                        |
| Archive dialog body            | `They close unanswered. Nothing restarts and nothing is approved. You can restore any of them from Archived.`                                                       |
| Archive dialog over cap        | `This archives the oldest {cap}. Run it again for the rest.`                                                                                                        |
| Archive result                 | `Archived {count}.` · `Archived {count}. {skipped} were already answered.`                                                                                          |
| Restore button                 | `Restore`                                                                                                                                                           |
| Auto-archived reason           | `Archived automatically — the work it belonged to is gone.`                                                                                                         |
| Over-limit note                | `{count} further questions were not recorded — this decision was too long.`                                                                                         |
| Access refused                 | `That access still is not granted. Nothing was changed.`                                                                                                            |
| Empty — quiet                  | `Nothing needs you right now.` / `That is either very good news, or your agents are deciding things they should be asking you about.`                               |
| Empty — quiet footnote         | `Nothing has needed you in {days} days.`                                                                                                                            |
| Empty — first run title        | `No decisions yet.`                                                                                                                                                 |
| Empty — first run body         | `When an agent hits something it should not decide alone — spending money, reaching a customer, choosing between two real directions — it stops and asks you here.` |
| Error title                    | `Could not load your decisions.`                                                                                                                                    |
| Error body                     | `We did not show an empty queue, because we cannot tell whether it is empty.`                                                                                       |
| Error last-known               | `Last known: {count} open, {time} ago.`                                                                                                                             |
| Health — healthy               | `Healthy — about {n} decisions a day.`                                                                                                                              |
| Health — heavy                 | `Heavy — {n} decisions a day. Your agents are asking things their instructions could answer.`                                                                       |
| Health — flooded               | `Flooded — {n} open. Answer what matters, archive the rest, then fix the instructions.`                                                                             |
| Health — quiet                 | `Nothing has needed you in two weeks. Worth spot-checking what your agents decided on their own.`                                                                   |
| Health — culprit               | `Most of them: {agent}.`                                                                                                                                            |
| Health menu                    | `Adjust the band` · `Hide for 30 days`                                                                                                                              |
| Position walker                | `{index} / {total}`                                                                                                                                                 |
| Next / previous                | `Next decision` · `Previous decision`                                                                                                                               |
| Home link                      | `See all decisions ({count})`                                                                                                                                       |
| Inbox / Task link              | `Open in My Decisions`                                                                                                                                              |
| Load more                      | `Load {count} more`                                                                                                                                                 |

---

## 7. Out of scope

- **Executing the approved action for the agent.** Approving hands the decision
  back to the agent, which performs the action under its own permissions. Building
  a platform-side executor for spawn / schedule / send / budget-override is a
  separate piece of work with its own safety surface.
- **A discussion thread on a decision.** Reasons and withdrawals are posted to the
  Task's existing comment thread, the one the board surfaces (AW-02). A third
  conversation surface is not warranted, and no Mission-scoped thread exists to
  post into.
- **Assigning or routing a decision to a named person.** Requires a
  per-organisation role model that does not exist (§9).
- **Changing any notification default.** Escalations and approvals already notify
  and already mirror into the Inbox; the notification matrix is AW-13.
- **Writing a fact answer into Memory or the Knowledge Base.** The answer is
  delivered to the agent and stored on the decision. Promoting it to durable
  Memory is AW-07.
- **Email-based approval of drafted messages.** The send-approval flow with its own
  daily cap is AW-05; a message-send approval still appears in this queue as an
  approval ask, but the drafting and cap surfaces are that epic's.
- **The trust ladder** — automatic promotion of a category from "always ask" to
  "handle it". AW-24 owns it, and nothing in this epic graduates itself.
- **Mobile applications.** The surface is responsive down to 320 px; a native
  application is not in this epic.
- **Cancelling or hiding the blocked Task alongside its decisions.** Archiving a
  decision sets the decision aside; the Task's own lifecycle — its status and its
  hidden-from-board marker — belongs to AW-02, and the two are deliberately not
  chained in this epic.
- **Bulk-answering.** The queue's bulk action is archive, not approve. A bulk
  approve defeats the reason the decision exists. The existing approve-all control
  on Home is unchanged and is not extended to escalations.

---

## 8. Acceptance criteria

**The queue**

- [ ] `/decisions` lists open Approvals and open Escalations in one list, ranked by
      blocking → confidence (unscored at 0.5, labelled _not scored_) → age.
- [ ] The header shows an open count and a blocking count, and neither shows `0`
      while the read is in flight.
- [ ] Tabs `Open` / `Answered` / `Archived` are present, deep-linkable, and each
      has its own empty state.
- [ ] Filters by Agent, Task, Mission and ask kind, plus search, are reflected in
      the URL.
- [ ] The list pages at 25 with a `Load 25 more` control; a requested page size
      above 100 is clamped.
- [ ] A failed read renders the error state, never an empty queue.
- [ ] A foreign decision id renders "not found", not "forbidden".

**Asks**

- [ ] Every open Approval and Escalation that existed before this shipped appears
      with a derived, answerable ask.
- [ ] All five ask kinds render their own control, validate their own answer shape,
      and reject a mismatched answer with a specific message.
- [ ] A decision filed with more than 10 asks keeps 10 and shows how many were
      dropped.
- [ ] Rejecting an approval ask, or choosing a non-recommended option, requires a
      reason of 1–1000 characters.
- [ ] An access ask naming an evaluable tool pattern refuses resolution while the
      grant is still denied, and says so.
- [ ] Answering an already-answered ask returns a conflict with the recorded answer
      and its author.

**Auto-unblock**

- [ ] Answering the last required ask closes the decision and marks the backing
      record with its existing resolved / approved / rejected semantics.
- [ ] A parked Run is restarted as a new Run continuing the same conversation, and
      the user sees `{agent} is picking the work back up.`
- [ ] A live Run receives the answers by injection, and the user sees `Sent to the
Run that is already going.`
- [ ] A decision with no restartable work still closes, and says so.
- [ ] A blocked Task whose only remaining blocker was this decision returns to the
      status it held before it was blocked; a Task with other blockers stays blocked
      and the count is shown.
- [ ] A restart failure leaves the decision closed, surfaces the failure and offers
      a manual run.
- [ ] Resolving through the pre-existing approval endpoint, escalation endpoint,
      escalation chat tool or an Inbox reply produces the same unblock and closes
      remaining asks as superseded.

**Undo**

- [ ] Undo is offered for 10 minutes after answering and only while no restarted
      Run has begun executing.
- [ ] Undo outside either condition is visibly disabled with the specific reason.
- [ ] Undo reopens the decision, cancels a still-queued restarted Run, and posts a
      withdrawal that reaches the agent.
- [ ] The withdrawn answer remains in the record, with its author and time.

**Archive**

- [ ] A single decision archives and restores from both the list and the detail.
- [ ] `Archive all` names the exact count, archives at most 200, skips
      already-resolved rows and reports the skips.
- [ ] Archiving never resolves, approves, rejects or restarts anything.
- [ ] A decision whose Run is cancelled and whose Task is deleted is auto-archived
      within 30 minutes with the reason shown.
- [ ] A decision open more than 30 days with no live work is flagged dormant and is
      **not** auto-archived.

**Health and repeats**

- [ ] The health line shows the correct band at each boundary: 0-in-14-days,
      1/day, 5/day, 6/day, 15/day, 16/day, and 26 open.
- [ ] The healthy ceiling and quiet window are overridable within 1–100 and 3–90.
- [ ] Heavy and Flooded name the top-producing Agent and link to its instructions.
- [ ] A cluster of 3 substantially-identical decisions in 14 days shows the
      `Asked 3 times` chip and the write-to-instructions action, and changes nothing
      else.
- [ ] An unavailable health snapshot hides the line and does not fail the page.

**Cross-cutting**

- [ ] Every keyboard binding in §6.17 works and is listed by `?`.
- [ ] No hard-coded user-visible string; every string resolves from the catalogue.
- [ ] Answer outcomes are announced through a polite live region.
- [ ] Read endpoints throttle at 60/min, writes at 30/min, archive-all at 5/min.
- [ ] All functional requirements have a passing test (unit, controller or e2e).

---

## 9. Open questions

- `[NEEDS CLARIFICATION: whose queue is "My" in a multi-member workspace? Access
today is tenant-wide — every member of a workspace can see every organisation in
it — and there is no per-organisation role model, so any member can answer any
decision. Options: (a) ship it that way and show who decided, which is what this
spec assumes; (b) hold routing until the role model exists; (c) add a soft
"claimed by" marker with no enforcement. Recommendation: (a) now, (c) as a P3
follow-up.]`
- `[NEEDS CLARIFICATION: should an agent be able to withdraw its own decision when
it finds the answer itself? It would keep the queue honest, but it also lets a
prompt-injected agent silently drop a question a human should have seen.
Recommendation: allow it only for the agent that raised it, only while no human
has viewed it, and always leave a visible "the agent answered this itself" row.]`
- `[NEEDS CLARIFICATION: can a human open a decision, addressed to an agent, from
this surface? It reads naturally as the inverse of the queue, but it overlaps
heavily with a Task and with the chat surfaces. Recommendation: out of scope
here; revisit after AW-12.]`
- `[NEEDS CLARIFICATION: exact clustering key for "substantially identical".
Candidate: the raising Agent plus the source reason or action type plus a
normalised fingerprint of the first ask's prompt. Needs a sample of real
decisions before the threshold and the normalisation are fixed.]`
- `[NEEDS CLARIFICATION: should the health band be per workspace or per
Organization? Per workspace is simpler and matches where the preference row
lives today; per Organization is what a multi-team account will eventually want.]`
- `[NEEDS CLARIFICATION: the 10-minute undo window. It is a guess. Instrument
time-from-answer-to-undo in P2 and revisit in P3 with real numbers.]`
- `[NEEDS CLARIFICATION: how much of a decision belongs on a read-only shared
dashboard (AW-18)? Showing the count is clearly safe; showing the prompts may
leak the content of the work.]`

---

## 10. Non-functional requirements

- **Performance.** The queue read returns in under **400 ms** at P95 for a
  workspace with 100 open decisions and 500 asks. Answering returns in under
  **700 ms** at P95, measured excluding the restart, which is enqueued rather than
  awaited. The health snapshot is read from a precomputed daily roll-up, never
  computed inline.
- **Reliability.** Answering is atomic per ask: either the answer is recorded or it
  is not. A restart failure never rolls back a recorded answer, and never leaves a
  decision half-closed. Every write is idempotent under retry.
- **Security and privacy.** Every read and write is owner-scoped and answers 404
  for a foreign id. Ask prompts, contexts, answers and reasons are plain text and
  are never rendered as markup. Nothing in an access ask ever carries a credential
  value — only the name of what is needed and a link to where it is granted.
- **Observability.** Opening, viewing, answering, withdrawing, archiving,
  restoring and restarting each write an activity entry naming the actor. Product
  analytics record time-to-decide, asks-per-decision, restart outcome, undo rate
  and band transitions. A restart failure raises an error report with the decision
  and run identifiers and no prompt content.
- **Compatibility.** The pre-existing approval and escalation endpoints keep their
  paths, methods and response shapes. Two new members are added to the escalation
  and approval status vocabularies (`archived`) and two to the shared typed-question
  vocabulary (`access`, `action`); every existing consumer that filters on the
  current members is unaffected.
- **Degradation.** With no background job runtime configured, the queue and every
  answer still work; only the automatic restart is unavailable, and it says so.
  With the health roll-up unavailable, the line is hidden. With the confidence
  score absent, the decision ranks at 0.5 and is labelled _not scored_.

---

## 11. Constitution gates

| Gate                              | Status | Why                                                                                                                           |
| --------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------- |
| I — Plugin-first                  | n/a    | No external integration. The access ask links to the existing connection surfaces; it never talks to a provider               |
| II — Capability-driven resolution | ✅     | An access ask names a capability or tool pattern, never a plugin id; the link resolves through the existing plugin surfaces   |
| III — Source-of-truth repos       | n/a    | Decisions are platform metadata, not work content                                                                             |
| IV — Job runtime                  | ✅     | The restart, the orphan sweep and the daily health roll-up all run through the configured job-runtime provider                |
| V — Forward-only migrations       | ✅     | One new table and additive nullable columns; no drops, no renames, no destructive change                                      |
| VI — Tests first-class            | ✅     | Unit for the resolution and band logic, controller specs for every endpoint, e2e for the queue, the unblock, undo and archive |
| VII — Secrets                     | ✅     | An access ask carries the _name_ of what is needed; never a value. Nothing on this surface stores or renders a credential     |
| VIII — Plugin counts              | n/a    | No plugin added                                                                                                               |
| IX — Behaviour-first spec         | ✅     | This document carries no class name, file path or code                                                                        |
| X — Backwards compatibility       | ✅     | Existing endpoints unchanged; the two vocabulary additions are additive union members                                         |

---

## 12. Cross-references

- Program overview and vocabulary: [`../README.md`](../README.md)
- What already exists server-side, and where it is unreachable:
  [`../EXISTING-SUBSTRATE.md`](../EXISTING-SUBSTRATE.md) (row **S2**)
- Task board, which counts this queue's decisions per Task and links into it:
  [`../AW-02-task-board/`](../AW-02-task-board/)
- Live Feed, which links its decision entries here:
  [`../AW-04-live-feed/`](../AW-04-live-feed/)
- Runs and receipts, which owns the Run detail this surface links out to:
  [`../AW-09-runs-receipts/`](../AW-09-runs-receipts/)
- Attention controls, which owns notification defaults:
  [`../AW-13-attention-controls/`](../AW-13-attention-controls/)
- Connections and scopes, which owns the surface an access ask links to:
  [`../AW-15-connections-scopes/`](../AW-15-connections-scopes/)
- Home, which links into this queue: [`../AW-19-home/`](../AW-19-home/)
- Safety rails and the trust ladder: [`../AW-24-safety-rails/`](../AW-24-safety-rails/)
- Implementation plan: [`./plan.md`](./plan.md) · Tasks: [`./tasks.md`](./tasks.md)
