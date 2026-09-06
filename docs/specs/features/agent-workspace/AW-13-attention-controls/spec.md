# AW-13 — Notification matrix & attention budget

> Behaviour-first spec per [Constitution Principle IX](../../../../../.specify/memory/constitution.md#ix-specs-are-behaviour-first).
> **No class names, no file paths, no code in this document.** Implementation lives in
> [plan.md](./plan.md); the ordered work lives in [tasks.md](./tasks.md).

**Epic ID:** `AW-13-attention-controls`
**Program:** [Agent Workspace](../README.md) — Wave 2 (the loop closes)
**Branch:** `feat/aw-13-attention-controls`
**Status:** `Draft`
**Created:** 2026-09-06
**Last updated:** 2026-09-06
**Size:** M · **Blocking dependencies:** [AW-04 Live Feed](../AW-04-live-feed/)
**Extends:** Notifications (v1 in-app rows + v2 event registry, subscriptions, quiet hours,
category mutes, channel fan-out), Digest, Budgets alerting
**Downstream:** [AW-17 Costs & caps](../AW-17-costs-caps/) and [AW-19 Home](../AW-19-home/) both
read the attention state this epic makes authoritative.

> **Additive rule (program §5.1, NN #20).** This epic finishes machinery Ever Works already
> shipped. It renames no entity, deletes no table, drops no column, and removes no delivery
> path. Every event that can reach a user today still reaches them after this epic; the change
> is that the user can finally *see* and *choose* how.

---

## 1. Overview

Settings → Notifications becomes a working **notification matrix**: one row per thing the
platform can tell you about, and two independent switches on every row — **In-app** and
**Email** — plus one extra column for each chat channel the user has connected. Toggling a
switch saves immediately; there is no Save button. The defaults are chosen by a single rule the
page states out loud: *you are interrupted only for the things that only you can unblock*.
On top of the matrix sits an **attention budget** — a per-user ceiling on how many interrupting
deliveries may leave the platform in a rolling 24 hours. When the ceiling is reached, further
non-urgent deliveries are **held**, not dropped: the in-app record is always written, and every
held item is listed by name in the next **digest**. Urgent events — an agent waiting on your
decision, a blocked mission, a billing failure — are never budgeted, never held, and never
deferred by quiet hours.

## 2. Why now

**The user's question.** An owner who has delegated work to four agents asks, once, on day two:
*"How do I stop this thing from emailing me about everything, without turning off the two
things I actually need to know?"*

**What they do today.** Nothing that works.

| The user needs | Ever Works today |
| --- | --- |
| A screen where the choices are visible | Settings → Notifications renders the event grid as a **read-only table** — the checkboxes have no change handler, nothing is ever saved, and the page has no translated strings at all. Every checkbox is a lie. |
| An **Email** switch | There is no built-in email delivery for notifications. The only built-in channel is in-app. Getting a notification by email requires creating a "channel" against a delivery plugin, and email is not one of the five that exist. |
| An **In-app** switch that does something | The in-app row is written unconditionally by every producer. Turning "in-app" off in the grid changes nothing, even conceptually — there is no code path that reads it. |
| To find the screen at all | The Notifications, Channels and Email-addresses settings pages shipped with **zero inbound links** from anywhere in the product. They are reachable only by typing the URL. |
| Every event to be listed | Five of the events the platform actually emits — credit balance exhausted, payment past due, the two pay-as-you-go cap notices, digest ready, memory ready for review — are **not registered**, so they never appear as a row and can never be routed anywhere but in-app. A sixth, the budget-cap alert, has no event identity at all. |
| Mute to work | Two registered events are filed under categories that are not valid mute targets, so they can never be muted no matter what the user does. |
| Turning everything off for one event to stick | An empty selection is treated as "no preference" and silently falls back to the defaults, so the one gesture a frustrated user reaches for is the one that does not work. |
| A ceiling | There is none. A busy week is an unbounded stream. The only blunt instruments are quiet hours (which delays, and only outside the window) and category mute (which is per-category, not per-event). |
| The digest to actually arrive by email | The Digest settings page tells the user their digest is "delivered in-app and to any notification channel you have connected". Because the digest event is unregistered, it is in-app only. The page's own copy is false. |

**The consequence.** The safety story of the whole program — *"you will be told when only you
can unblock it, and left alone otherwise"* — is currently unenforceable. Users cannot verify it,
tune it, or trust it. [AW-04](../AW-04-live-feed/) makes the routine hum *visible*; this epic is
what makes it *silent*, so that the loud things stay loud.

**Why it must be this epic and not a settings tidy-up.** Making the switches work is only the
visible half. The half that matters is that a notification's route becomes **one decision, taken
in one place, readable by the user** — instead of the four independent decisions taken today
(the producer writes in-app unconditionally; the resolver picks channels; the budget alert
handler sends its own email on a separate boolean column; quiet hours defers some of it).

## 3. User scenarios

### 3.1 Primary scenarios

- **S1 — First look, defaults already right.**
  **Given** a new user who has never opened notification settings and has no chat channel
  connected,
  **when** they open Settings → Notifications,
  **then** they see a two-column matrix (In-app, Email) grouped into **Needs you**, **Signals**,
  **Routine** and **Digest**; the eleven **Needs you** rows are on for both columns; the two
  **Routine** rows are off for both; and a one-line rule above the table explains why.

- **S2 — Turning one thing off.**
  **Given** the matrix is open,
  **when** the user clicks the **Email** switch on *A generation failed*,
  **then** the switch flips immediately, a subtle "Saving…" marker appears on that row, and
  within 2 seconds it becomes "Saved"; reloading the page shows the switch still off.

- **S3 — Turning one thing on that has never been on.**
  **Given** *A run finished* is off in both columns,
  **when** the user turns **In-app** on,
  **then** the next finished run produces a bell notification, and the row's helper text updates
  from "Visible in the Live Feed and on Runs" to "Also shown in your notifications".

- **S4 — Email actually arrives.**
  **Given** *An agent needs your decision* has Email on and the user's account address is
  verified,
  **when** an agent escalates,
  **then** within 60 seconds an email arrives at the account address with the escalation's
  summary, the decision needed, and one button that opens My Decisions.

- **S5 — The budget bites.**
  **Given** the user's email budget is the default 10 per 24 hours and 10 non-urgent emails have
  already been sent today,
  **when** an eleventh non-urgent event fires,
  **then** no email is sent, the in-app notification is written as normal, the matrix's budget
  meter reads **10 of 10 used · 3 held**, and the held item is listed by name in the next digest.

- **S6 — Urgent ignores the budget.**
  **Given** the same exhausted budget,
  **when** an agent escalates (an urgent event),
  **then** the email is sent anyway, the meter reads **11 of 10 used**, and the meter shows the
  over-count in a distinct "over budget" state rather than clamping to 10.

- **S7 — Raising the budget releases nothing retroactively.**
  **Given** 3 items are held,
  **when** the user raises the email budget from 10 to 30,
  **then** the 3 held items stay held (they are already in the digest queue), the meter recomputes
  to **10 of 30 used**, and the next non-urgent event is delivered immediately.

- **S8 — The digest closes the loop.**
  **Given** the user has a weekly digest and 6 items were held during the week,
  **when** the digest is composed,
  **then** it contains a **Held for you** section naming all 6 with their timestamps and links,
  and the held rows are marked released so the following digest does not repeat them.

- **S9 — Connecting a chat channel adds a column.**
  **Given** the user connects a chat channel on Settings → Channels,
  **when** they return to the matrix,
  **then** a third column appears, headed with the channel's own name, every cell off by default,
  and a hint that the channel is subject to the same budget as email.

- **S10 — Turning everything off for one row and having it stick.**
  **Given** *A generation finished* has In-app on,
  **when** the user turns off every column on that row,
  **then** the row saves as an explicit "nothing", and after a reload it is still nothing —
  it does not silently revert to the platform defaults.

- **S11 — Quiet hours and urgency.**
  **Given** quiet hours are 22:00–07:00 in the user's timezone,
  **when** a non-urgent event with Email on fires at 23:10,
  **then** the email is scheduled for 07:00 and the row's cell shows a small "held until 07:00"
  affordance on hover; **when** an urgent event fires at 23:10, the email is sent at 23:10.

- **S12 — Resetting.**
  **Given** the user has changed 14 switches and regrets it,
  **when** they press **Reset to recommended** and confirm,
  **then** every row returns to the shipped default, the confirmation dialog names the number of
  rows that will change, and the reset is one request, not 23.

### 3.2 Edge cases, failures, races and empty states

- **S13 — Save fails.**
  **Given** the API is unreachable,
  **when** a switch is toggled,
  **then** the switch reverts to its previous position within 8 seconds, an inline message on
  that row reads "Couldn't save — try again", the rest of the matrix stays interactive, and no
  toast is shown (the failure is local to the row that failed).

- **S14 — Two tabs, one user.**
  **Given** the matrix is open in two tabs,
  **when** a switch is toggled in tab A,
  **then** tab B is stale until it is refocused; on refocus it refetches and reconciles, and the
  last write wins — the row shows the server's value, not the stale local one.

- **S15 — Rapid clicking.**
  **Given** the user clicks the same switch four times in one second,
  **then** exactly one request is sent, carrying the final position; the row is not left in a
  state that disagrees with the server.

- **S16 — A channel is deleted while the matrix is open.**
  **Given** the matrix shows a channel column and the channel is deleted from another tab,
  **when** the user toggles a cell in that column,
  **then** the save is rejected, the column is removed from the matrix on the next refetch, and
  a single message explains that the channel no longer exists. No other cell is affected.

- **S17 — A channel is disabled, not deleted.**
  **Given** a connected channel has been disabled,
  **then** its column is still shown, greyed, with "Disabled — deliveries are skipped", its
  switches are read-only, and the stored selections are preserved for when it is re-enabled.

- **S18 — Email address unverified or missing.**
  **Given** the account has no verified email address,
  **then** the Email column header shows "Not verified" with a link to verify, every Email switch
  is disabled, and a row-level explanation replaces the switch. Selections already stored are
  preserved and take effect the moment the address is verified.

- **S19 — Email transport is not configured on this deployment.**
  **Given** the deployment has no mail transport configured,
  **then** the Email column header reads "Email is not configured on this workspace", switches
  are disabled, and the page does not pretend a switch will do something.

- **S20 — No events registered at all.**
  **Given** an empty event registry (a fresh, broken bootstrap),
  **then** the matrix shows a single explanatory empty state naming what is missing and linking
  to the Live Feed, rather than an empty table with headers.

- **S21 — A plugin contributes an event, then is uninstalled.**
  **Given** an installed plugin registered its own event and the user turned Email on for it,
  **when** the plugin is uninstalled,
  **then** the row disappears from the matrix, the stored selection is retained (not deleted),
  and reinstalling the plugin restores the row with the user's previous choice intact.

- **S22 — Over the column limit.**
  **Given** the user has connected 9 channels,
  **then** the matrix shows In-app, Email and the 4 most recently used channels as columns, and a
  **+5 more** column control that opens a per-row channel picker. A subscription may still name
  at most 20 channels; attempting a 21st is refused with a message that says the number.

- **S23 — Budget set to zero.**
  **Given** the user sets the email budget to 0,
  **then** every non-urgent email is held, urgent email still sends, and the budget card states
  in words: "Non-urgent email is held and summarised in your digest. Urgent alerts still send."

- **S24 — Budget disabled entirely.**
  **Given** the user switches the attention budget off,
  **then** nothing is held, the meters read "Off", and existing held items are still released by
  the next digest (they are not resurrected as live deliveries).

- **S25 — Holds expire.**
  **Given** the user's digest cadence is off and 12 items have been held,
  **when** 7 days pass,
  **then** those held rows expire; they are never delivered externally; the in-app rows remain,
  and the budget card explains that turning the digest on is how held items get summarised.

- **S26 — A producer emits an unregistered event.**
  **Given** new platform code emits an event key that is not in the registry,
  **then** the notification is still written in-app (never lost), no external delivery is
  attempted, and the platform records a counter so the missing registration is visible to us
  rather than silently degrading to in-app forever.

- **S27 — Category mute and the matrix disagree.**
  **Given** a category is muted and the matrix shows Email on for an event in that category,
  **then** the affected rows render with a "Muted until <time>" badge and a one-click unmute; the
  switch position is preserved and takes effect again the moment the mute ends.

- **S28 — Permission.**
  **Given** a user requests another user's notification preferences by guessing an identifier,
  **then** the request is refused identically to a request for something that does not exist —
  no response distinguishes "not yours" from "not there".

## 4. Functional requirements

### 4.1 The matrix

- **FR-1.** Settings → Notifications MUST render one row per registered event type, grouped
  under exactly four headings: **Needs you**, **Signals**, **Routine**, **Digest**. Grouping is
  derived, not stored per row: an event is **Needs you** when it is marked urgent, **Digest**
  when its category is digest, **Routine** when both its shipped defaults are off, and
  **Signals** otherwise.
- **FR-2.** Every row MUST carry a plain-language title, a one-sentence description, and — for
  rows whose defaults are off — a sentence naming where the information is visible instead.
- **FR-3.** Every row MUST expose exactly two mandatory switches, **In-app** and **Email**, plus
  one switch per connected chat channel. The two mandatory switches are independent: neither
  position constrains the other.
- **FR-4.** Column order MUST be: In-app, Email, then chat channels ordered by most recently
  created. At most **6** columns are shown at once; when more exist, the 6th is replaced by a
  **+N more** control that opens a per-row picker over the remainder.
- **FR-5.** A single event's selection MUST NOT exceed **20** delivery targets. A 21st is
  refused with a message stating the limit as a number.
- **FR-6.** The matrix MUST load in **one** request that returns the event catalogue, the user's
  effective selection per event, the available columns, the quiet-hours window, active category
  mutes and the budget snapshot. p95 for that request MUST be under **400 ms** for a user with
  23 events and 6 channels.
- **FR-7.** The matrix MUST be built from the event registry at request time, so an event
  contributed by a newly installed plugin appears without a deploy, and MUST NOT contain any
  hard-coded list of chat providers.

### 4.2 Saving

- **FR-8.** A switch MUST take effect optimistically on click and MUST persist without any Save
  button.
- **FR-9.** Writes for one row MUST be coalesced with a **400 ms** debounce, so N clicks inside
  the window produce exactly one request carrying the final positions of that row.
- **FR-10.** A write that has not resolved within **8 seconds** MUST be treated as failed: the
  row reverts to the last server-confirmed positions and shows an inline retry affordance.
- **FR-11.** A failed write MUST NOT revert, block, or disable any other row.
- **FR-12.** Each row MUST show its own save state — idle, saving, saved, failed — and the
  "saved" state MUST clear itself after **2 seconds**.
- **FR-13.** An explicit selection of **no targets** MUST persist as "no targets" and MUST NOT
  fall back to platform or organization defaults on the next read. This is a behaviour change
  from today and is required for S10.
- **FR-14.** **Reset to recommended** MUST restore every row's shipped default in one request,
  behind a confirmation that states how many rows will change.
- **FR-15.** When the page regains focus after **30 seconds** or more away, it MUST refetch and
  reconcile; the server's value wins over an unsent local value.

### 4.3 Email as a built-in delivery target

- **FR-16.** **Email** MUST be a built-in delivery target, available to every user without
  configuring anything, delivered to the account's own address. It MUST NOT require creating a
  channel and MUST NOT depend on any chat provider.
- **FR-17.** A notification email MUST contain: the event title, the message, the workspace name,
  one primary action button that deep-links to the place the decision or record lives, the reason
  it was sent ("You get this because *An agent needs your decision* is on for Email"), and a link
  to the matrix.
- **FR-18.** Email delivery MUST be retried on failure with the same bounded backoff the platform
  already uses for chat delivery, and MUST record one delivery-log row per attempt, including
  terminal failures, so an operator can see what was not delivered.
- **FR-19.** Email MUST be disabled in the UI, with an explanation, when the account address is
  unverified (S18) or when the deployment has no mail transport (S19). Stored selections MUST be
  preserved in both cases.
- **FR-20.** A user MUST be able to send themselves a test email from the matrix, throttled to
  **3 per 10 minutes**, and the result (delivered / failed with reason) MUST be shown inline.

### 4.4 In-app, and what "off" means

- **FR-21.** In-app **off** MUST mean "do not interrupt me": the notification record is still
  written, but it is excluded from the unread count and from the notification list's default
  view. It MUST remain retrievable under a **Muted** filter.
- **FR-22.** Turning In-app off MUST never suppress the corresponding Activity record or Live
  Feed entry. The Live Feed is the complete record; the matrix governs interruption only.
- **FR-23.** Persistent notifications — the ones the platform refuses to let a user dismiss —
  MUST ignore an In-app off switch and always appear. The matrix MUST render those rows' In-app
  switch as on and read-only, with the reason stated.

### 4.5 The event catalogue and its defaults

- **FR-24.** The registry MUST contain a row for **every** event key any producer emits. At the
  time of writing that is **23** keys; **8** of them are unregistered today and MUST be added:
  credit balance exhausted, pay-as-you-go at 80% of cap, pay-as-you-go cap reached, payment past
  due, budget cap approaching, budget cap reached, memory ready for review, digest ready.
- **FR-25.** Every registered event's category MUST be a valid mute target. Two rows are filed
  today under categories that are not, and MUST be corrected.
- **FR-26.** The shipped defaults MUST be exactly:

  **Needs you — urgent; In-app ON, Email ON; never budgeted, never deferred by quiet hours**

  | Event | Category |
  | --- | --- |
  | An agent needs your decision | Agent |
  | An agent asked you a question | Agent |
  | An agent is waiting for your approval | Agent |
  | An escalation is waiting for you | Agent |
  | A mission is blocked | System |
  | Your Git sign-in expired | Security |
  | AI credits ran out | AI credits |
  | Your credit balance is empty | AI credits |
  | Pay-as-you-go cap reached | AI credits |
  | A payment failed | AI credits |
  | A budget cap was reached | AI credits |

  **Signals — not urgent; In-app ON, Email OFF; budgeted**

  | Event | Category |
  | --- | --- |
  | Pay-as-you-go at 80% of cap | AI credits |
  | A budget cap is getting close | AI credits |
  | A schedule paused itself | Generation |
  | A model provider keeps failing | AI credits |
  | A generation failed | Generation |
  | A run is waiting for capacity | Agent |
  | A run moved off your computer | Agent |
  | New memory is ready for review | Agent |
  | The platform filed a notice for you | System |

  **Routine — not urgent; In-app OFF, Email OFF; budgeted if switched on**

  | Event | Category | Visible instead in |
  | --- | --- | --- |
  | A run finished | Agent | Live Feed, Runs, Home |
  | A generation finished | Generation | Live Feed, the Work's activity |

  **Digest — not urgent; In-app OFF, Email ON**

  | Event | Category |
  | --- | --- |
  | Your digest is ready | Digest |

- **FR-27.** Four events that are "only you can unblock" are not marked urgent today and MUST
  become urgent: an agent needs your decision, an agent is waiting for your approval, an
  escalation is waiting for you, a mission is blocked. Urgency has exactly two consequences:
  quiet hours does not defer it, and the attention budget does not hold it.
- **FR-28.** The budget-cap alert MUST become a first-class event with the two keys in FR-26, so
  it is routed by the matrix like everything else. The legacy per-user boolean that governs
  budget-alert email today MUST be read once to seed each user's matrix selection and MUST NOT be
  deleted, so account export and import keep working.
- **FR-29.** Changing an event's shipped default MUST NOT change any user who has already made an
  explicit choice for that event.

### 4.6 The attention budget

- **FR-30.** The workspace MUST enforce a per-user ceiling on **interrupting deliveries** in a
  rolling **24 hours**, counted separately for two classes: **email** and **chat channels**.
  Defaults: **10** email, **20** chat. Range **0–200**. In-app is never counted and never held.
- **FR-31.** Urgent events MUST bypass the budget entirely and MUST still increment the counter,
  so the meter tells the truth about how loud the day was.
- **FR-32.** When the ceiling is reached, a non-urgent delivery MUST be **held**, not dropped:
  the in-app record is written as normal, and a hold record is created naming the event, the
  target class, the title, the message and the deep link.
- **FR-33.** Held items MUST be released into the next digest, in a **Held for you** section
  capped at **20** named items plus a count of the remainder, and MUST be marked released so the
  following digest does not repeat them.
- **FR-34.** A held item MUST expire after **7 days** if no digest has released it. Expiry MUST
  never deliver anything, and MUST be visible in the budget card as a number.
- **FR-35.** The budget MUST be switchable off entirely per user; when off, nothing is held.
- **FR-36.** The matrix MUST show a live meter per class — used, ceiling, currently held, and
  time until the oldest counted delivery rolls out of the window — refreshed on load and every
  **60 seconds** while the page is open.
- **FR-37.** Raising or lowering the ceiling MUST NOT retroactively release or hold anything
  (S7). It applies from the next delivery decision.
- **FR-38.** Quiet hours MUST continue to work exactly as they do today (defer non-urgent
  external delivery until the end of the window), and MUST be evaluated **before** the budget, so
  a deferred delivery is counted when it is actually sent, not when it was raised.

### 4.7 Digest

- **FR-39.** The digest event MUST be registered so a digest can be delivered by email, and its
  shipped default MUST be In-app OFF, Email ON.
- **FR-40.** New accounts MUST default to a **weekly** digest. Existing accounts' stored cadence
  MUST NOT be changed by this epic.
- **FR-41.** The digest MUST gain two sections: **Held for you** (FR-33) and a one-line
  **Attention** summary stating how many interrupting deliveries were made against each ceiling
  during the window.
- **FR-42.** The Digest settings page's description of where a digest is delivered MUST be
  corrected to match reality, and MUST link to the matrix row that governs it.
- **FR-43.** The matrix's Digest row MUST NOT duplicate the cadence control. It links to the
  Digest settings page, which remains the single owner of cadence.

### 4.8 Discoverability, permissions and limits

- **FR-44.** The notification bell MUST gain a footer link to the matrix, and the matrix MUST
  link to Channels and to Digest. No settings page in this area may remain reachable only by
  typing its URL.
- **FR-45.** All preferences in this epic are **per user and workspace-global**. They are not
  scoped per Organization, per Work, per Agent or per Mission.
- **FR-46.** Every read and write MUST be scoped to the calling user. A request naming another
  user's preference MUST fail identically to a request naming a preference that does not exist.
- **FR-47.** A selection may only name delivery targets the calling user owns. A target that is
  unknown or belongs to someone else MUST be refused with an identical message.
- **FR-48.** Every user-visible string on these surfaces MUST come from the translation
  catalogue. The matrix today has none.
- **FR-49.** A failure anywhere in routing, budgeting or external delivery MUST NEVER prevent the
  in-app record from being written. In-app is the floor and cannot be taken away by a fault.

## 5. Key entities

| Concept | New? | Description |
| --- | --- | --- |
| **Notification** | Existing | The in-app record. Gains one attribute: whether it was written silently (FR-21). |
| **Notification event type** | Existing | The registry row that makes an event addressable. This epic completes it (FR-24), corrects two categories (FR-25) and four urgency flags (FR-27). No shape change. |
| **Subscription** | Existing | One per user per event, naming the delivery targets. This epic fixes the meaning of an empty selection (FR-13). No shape change. |
| **Delivery target** | Existing concept, one new member | Today: the built-in *in-app*, plus each connected **Connection**-backed chat channel. This epic adds one more built-in member, **email**. It is not a new entity — it is a second sentinel alongside the one that already exists. |
| **Notification preference** | Existing | The per-user row that holds quiet hours. Gains the two budget ceilings and the budget on/off flag. |
| **Delivery log** | Existing | One row per delivery attempt. Gains the owning user and the built-in-target name, so email attempts can be recorded in the same log as chat attempts and so the budget can be counted from one place. |
| **Attention hold** | **New entity** | One record per delivery the budget held. Justified below. |
| **Digest** | Existing | Gains two sections (FR-41) and becomes the release valve for holds. |
| **Category mute** | Existing | Unchanged behaviour; the matrix now surfaces it (S27). |
| **Connection** | Existing | A connected chat account. Each one contributes one matrix column. Unchanged. |
| **Approval / Escalation** | Existing | The source of the loudest events. Unchanged; only their routing changes. |

### 5.1 Why one new entity is justified

The budget's promise is *"held, not dropped."* A counter can enforce a ceiling but cannot keep
that promise: once a delivery is suppressed, nothing in the system remembers **what** was
suppressed, and the digest has nothing to list. The in-app record is not sufficient either — it
does not record that an external delivery was refused, or to which target class, and rebuilding
that by joining the notification list against the delivery log would be a guess.

An **Attention hold** is bookkeeping about a delivery decision: which user, which event, which
target class, the text that would have been sent, when it was held, when it was released or
expired. It introduces no new product noun, appears in no navigation, and is never something the
user creates. It is added to the program's vocabulary table in the same change.

### 5.2 States and transitions

**Attention hold** — created only when the budget refuses a non-urgent delivery.

```
        (no record)
             │  budget ceiling reached for this target class
             ▼
      ┌─────────────┐   digest composed for this user
      │    HELD     │ ───────────────────────────────► ┌────────────┐
      │  releasedAt │                                   │  RELEASED  │
      │   = null    │                                   │  (in the   │
      │             │   7 days pass with no digest      │   digest)  │
      │             │ ───────────────────────────────► ┌────────────┐
      └─────────────┘                                   │  EXPIRED   │
             ▲                                          │ (counted,  │
             │  budget switched off → no new holds       │  never     │
             │  (existing holds keep their path)         │  delivered)│
             └──────────────────────────────────────────└────────────┘
```

A hold is never re-delivered as a live notification. Its only exits are the digest and expiry.

**A delivery decision** — the single ordered pipeline this epic makes authoritative.

```
   event produced
        │
        ▼
   ┌────────────────┐  always, unconditionally, even if everything below fails
   │ in-app record  │──► written; marked silent when In-app is off (FR-21)
   └────────────────┘
        │
        ▼
   ┌────────────────────────┐
   │ registry lookup        │── unknown key ─► counted, stop (FR-49, S26)
   └────────────────────────┘
        │
        ▼
   ┌────────────────────────┐
   │ user's selection       │── empty selection ─► stop (FR-13)
   │ (else org default,     │
   │  else shipped default) │
   └────────────────────────┘
        │
        ▼
   ┌────────────────────────┐   muted category ─► drop external targets
   │ category mute          │
   └────────────────────────┘
        │
        ▼
   ┌────────────────────────┐   quiet hours + not urgent ─► defer to end of window
   │ quiet hours            │
   └────────────────────────┘
        │
        ▼
   ┌────────────────────────┐   ceiling reached + not urgent ─► HOLD (FR-32)
   │ attention budget       │
   └────────────────────────┘
        │
        ▼
   deliver: email (built-in) and/or each selected channel, retried, logged
```

**Notification (silent attribute)** — `loud` by default; `silent` when the user has In-app off
for that event. A silent record never enters the unread count. It is never deleted early and is
retrievable under the Muted filter. Persistent notifications are always `loud` (FR-23).

## 6. UX

### 6.1 Navigation

```
 Settings
   ├── … Digest            ← existing; corrected copy + link to the matrix row
   ├── Notifications       ← this epic rebuilds this page
   ├── Channels            ← existing; matrix links here to add a column
   └── …

 Bell (top bar) ─── footer ─── "Notification settings →"    ← new link (FR-44)
```

### 6.2 The matrix — default state, no channels connected

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│  Notifications                                                                   │
│  You are interrupted only for things that only you can unblock. Everything else  │
│  stays visible in the Live Feed and your digest.                     [Reset ⤺]   │
├──────────────────────────────────────────────────────────────────────────────────┤
│  ATTENTION BUDGET                                                    [ On  ●─ ]  │
│  ┌───────────────────────────┐  ┌───────────────────────────┐                    │
│  │ Email    ▓▓▓▓░░░░░░  4/10 │  │ Channels  ░░░░░░░░░░  0/20 │   Resets in 6h 12m │
│  │ 0 held                    │  │ 0 held                     │   [Edit limits]    │
│  └───────────────────────────┘  └───────────────────────────┘                    │
│  Quiet hours: not set                                    [Set 22:00 – 07:00]     │
├──────────────────────────────────────────────────────────────────────────────────┤
│                                                        In-app        Email       │
│  NEEDS YOU · we interrupt you for these                                          │
│  ────────────────────────────────────────────────────────────────────────────────│
│  An agent needs your decision                            [ ●─ ]      [ ●─ ]      │
│    An agent stopped and a human has to choose.                                   │
│  An agent asked you a question                           [ ●─ ]      [ ●─ ]      │
│    A run is parked until you reply.                                              │
│  An agent is waiting for your approval                   [ ●─ ]      [ ●─ ]      │
│  An escalation is waiting for you                        [ ●─ ]      [ ●─ ]      │
│  A mission is blocked                                    [ ●─ ]      [ ●─ ]      │
│  Your Git sign-in expired                                [ ●─ ]      [ ●─ ]      │
│  AI credits ran out                                      [ ●─ ]      [ ●─ ]      │
│  Your credit balance is empty                            [ ●─ ]      [ ●─ ]      │
│  Pay-as-you-go cap reached                               [ ●─ ]      [ ●─ ]      │
│  A payment failed                                        [ ●─ ]      [ ●─ ]      │
│  A budget cap was reached                                [ ●─ ]      [ ●─ ]      │
│                                                                                  │
│  SIGNALS · worth knowing, not worth an interruption by email                     │
│  ────────────────────────────────────────────────────────────────────────────────│
│  Pay-as-you-go at 80% of cap                             [ ●─ ]      [ ─○ ]      │
│  A budget cap is getting close                           [ ●─ ]      [ ─○ ]      │
│  A schedule paused itself                                [ ●─ ]      [ ─○ ]      │
│  A model provider keeps failing                          [ ●─ ]      [ ─○ ]      │
│  A generation failed                                     [ ●─ ]      [ ─○ ]      │
│  A run is waiting for capacity                           [ ●─ ]      [ ─○ ]      │
│  A run moved off your computer                           [ ●─ ]      [ ─○ ]      │
│  New memory is ready for review                          [ ●─ ]      [ ─○ ]      │
│  The platform filed a notice for you                     [ ●─ ]      [ ─○ ]      │
│                                                                                  │
│  ROUTINE · off, because you can already see it                                   │
│  ────────────────────────────────────────────────────────────────────────────────│
│  A run finished                                          [ ─○ ]      [ ─○ ]      │
│    Visible in the Live Feed, on Runs and on Home.                                │
│  A generation finished                                   [ ─○ ]      [ ─○ ]      │
│    Visible in the Live Feed and on the Work's activity.                          │
│                                                                                  │
│  DIGEST                                                                          │
│  ────────────────────────────────────────────────────────────────────────────────│
│  Your digest is ready                                    [ ─○ ]      [ ●─ ]      │
│    Weekly, on Mondays.  Change cadence →                                         │
├──────────────────────────────────────────────────────────────────────────────────┤
│  Want a chat channel too?  Connect one →        Send yourself a test email →     │
└──────────────────────────────────────────────────────────────────────────────────┘
```

### 6.3 With channels connected (and the overflow control)

```
                                     In-app    Email   #ops-alerts  Ops phone   +5 more
  An agent needs your decision       [ ●─ ]    [ ●─ ]    [ ●─ ]       [ ─○ ]      ⌄
  A generation failed                [ ●─ ]    [ ─○ ]    [ ─○ ]       [ ─○ ]      ⌄
                                                                                  │
                                        ┌─────────────────────────────────────────┘
                                        │  Other channels for this event
                                        │  [x] Weekend duty      [ ] Build room
                                        │  [ ] Founders          [ ] Status page
                                        │  [ ] Night shift
                                        │  2 of 20 targets used         [Done]
                                        └─────────────────────────────────────────
```

### 6.4 Row states

```
  saving   A generation failed        [ ●─ ]  [ ─○ ]   ◌ Saving…
  saved    A generation failed        [ ●─ ]  [ ─○ ]   ✓ Saved
  failed   A generation failed        [ ●─ ]  [ ─○ ]   ⚠ Couldn't save — Try again
  muted    A model provider keeps…    [ ●─ ]  [ ─○ ]   Muted until 18:00 · Unmute
  quiet    A schedule paused itself   [ ●─ ]  [ ●─ ]   Email held until 07:00
  locked   AI credits ran out         [ ●■ ]  [ ●─ ]   Always shown in the app
```

### 6.5 Loading, empty, error and degraded states

```
 LOADING (first paint)              EMPTY REGISTRY
 ┌────────────────────────────┐     ┌────────────────────────────────────────────┐
 │ Notifications              │     │ Nothing to configure yet                   │
 │ ▒▒▒▒▒▒▒▒▒▒▒▒  ▒▒▒▒  ▒▒▒▒   │     │ No events are registered on this           │
 │ ▒▒▒▒▒▒▒▒▒▒▒▒  ▒▒▒▒  ▒▒▒▒   │     │ workspace, so there is nothing to route.   │
 │ ▒▒▒▒▒▒▒▒▒▒▒▒  ▒▒▒▒  ▒▒▒▒   │     │ Everything your agents do is still in the  │
 │ (4 skeleton rows per group)│     │ Live Feed.            Open the Live Feed → │
 └────────────────────────────┘     └────────────────────────────────────────────┘

 EMAIL UNVERIFIED (column header)          EMAIL NOT CONFIGURED (column header)
 ┌──────────────────────────────┐          ┌──────────────────────────────────────┐
 │ Email                        │          │ Email                                │
 │ Not verified · Verify now →  │          │ Not configured on this workspace     │
 │ (switches disabled, choices  │          │ (switches disabled; ask your operator)│
 │  kept)                       │          │                                      │
 └──────────────────────────────┘          └──────────────────────────────────────┘

 LOAD ERROR                                 CHANNEL DELETED ELSEWHERE
 ┌────────────────────────────────────┐     ┌──────────────────────────────────────┐
 │ ⚠ Couldn't load your notification  │     │ ⚠ "#ops-alerts" no longer exists.    │
 │   settings. Nothing has changed.   │     │   Its column has been removed.       │
 │                        [ Retry ]   │     │   Your other choices are unchanged.  │
 └────────────────────────────────────┘     └──────────────────────────────────────┘
```

### 6.6 Over-limit and budget states

```
 OVER BUDGET                                       BUDGET OFF
 ┌───────────────────────────────────┐             ┌─────────────────────────────┐
 │ Email   ▓▓▓▓▓▓▓▓▓▓▓  13/10  ⚠     │             │ Email     Off               │
 │ 3 held · summarised in your digest │             │ Channels  Off               │
 │ Resets in 2h 41m                   │             │ Nothing is held.            │
 └───────────────────────────────────┘             └─────────────────────────────┘

 BUDGET AT ZERO                                    HOLDS EXPIRING, NO DIGEST
 ┌────────────────────────────────────────────┐    ┌────────────────────────────────┐
 │ Email   0/0                                │    │ 12 items are held and will      │
 │ Non-urgent email is held and summarised in │    │ expire in 3 days. Turn on a     │
 │ your digest. Urgent alerts still send.     │    │ digest to receive them.         │
 └────────────────────────────────────────────┘    │                Turn on digest → │
                                                    └────────────────────────────────┘

 TOO MANY TARGETS ON ONE ROW
 ┌───────────────────────────────────────────────────────────────────┐
 │ ⚠ An event can be sent to at most 20 places. Turn one off first.  │
 └───────────────────────────────────────────────────────────────────┘
```

### 6.7 Edit-limits dialog

```
 ┌─────────────────────────────────────────────────────────────────┐
 │  Attention budget                                               │
 │                                                                 │
 │  How many times a day may we interrupt you outside the app?     │
 │  Urgent alerts — decisions, blocked missions, billing — always  │
 │  send, whatever you set here.                                   │
 │                                                                 │
 │  Emails per day        [  10 ]   (0–200)                        │
 │  Channel messages/day  [  20 ]   (0–200)                        │
 │                                                                 │
 │  Anything over the limit is held and listed in your next        │
 │  digest. Nothing is ever silently dropped.                      │
 │                                                                 │
 │                                       [ Cancel ]  [ Save ]      │
 └─────────────────────────────────────────────────────────────────┘
```

### 6.8 Reset confirmation

```
 ┌─────────────────────────────────────────────────────────────────┐
 │  Reset to recommended?                                          │
 │                                                                 │
 │  14 of 23 rows will change back to the recommended setting.     │
 │  Your quiet hours, budget limits and connected channels are     │
 │  not affected.                                                  │
 │                                                                 │
 │                                       [ Cancel ]  [ Reset ]     │
 └─────────────────────────────────────────────────────────────────┘
```

### 6.9 Exact user-visible copy

| Where | Copy |
| --- | --- |
| Page title | **Notifications** |
| Page subtitle | You are interrupted only for things that only you can unblock. Everything else stays visible in the Live Feed and your digest. |
| Group: needs you | **Needs you** — we interrupt you for these |
| Group: signals | **Signals** — worth knowing, not worth an interruption by email |
| Group: routine | **Routine** — off, because you can already see it |
| Group: digest | **Digest** |
| Column: in-app | In-app |
| Column: email | Email |
| Column overflow | +{count} more |
| Row state saving | Saving… |
| Row state saved | Saved |
| Row state failed | Couldn't save — Try again |
| Row locked | Always shown in the app |
| Row muted | Muted until {time} · Unmute |
| Row quiet-deferred | Email held until {time} |
| Routine helper 1 | Visible in the Live Feed, on Runs and on Home. |
| Routine helper 2 | Visible in the Live Feed and on the Work's activity. |
| Digest helper | {cadence}. Change cadence → |
| Budget card title | **Attention budget** |
| Budget meter | {used} of {limit} · {held} held |
| Budget reset | Resets in {duration} |
| Budget off | Off. Nothing is held. |
| Budget over | Over your limit. {held} held and summarised in your digest. |
| Budget zero | Non-urgent email is held and summarised in your digest. Urgent alerts still send. |
| Budget dialog title | Attention budget |
| Budget dialog body | How many times a day may we interrupt you outside the app? Urgent alerts — decisions, blocked missions, billing — always send, whatever you set here. |
| Budget dialog note | Anything over the limit is held and listed in your next digest. Nothing is ever silently dropped. |
| Quiet hours empty | Quiet hours: not set |
| Quiet hours preset | Set 22:00 – 07:00 |
| Quiet hours set | Quiet hours: {start} – {end} ({timezone}) · Change |
| Reset button | Reset to recommended |
| Reset dialog title | Reset to recommended? |
| Reset dialog body | {count} of {total} rows will change back to the recommended setting. Your quiet hours, budget limits and connected channels are not affected. |
| Email unverified | Not verified · Verify now → |
| Email not configured | Not configured on this workspace |
| Channel disabled | Disabled — deliveries are skipped |
| Channel removed | "{name}" no longer exists. Its column has been removed. Your other choices are unchanged. |
| Too many targets | An event can be sent to at most {max} places. Turn one off first. |
| Test email link | Send yourself a test email → |
| Test email sent | Sent. Check {address}. |
| Test email failed | Couldn't send: {reason} |
| Test email throttled | You can send {max} test emails every {minutes} minutes. Try again in {duration}. |
| Connect channel link | Want a chat channel too? Connect one → |
| Empty registry title | Nothing to configure yet |
| Empty registry body | No events are registered on this workspace, so there is nothing to route. Everything your agents do is still in the Live Feed. |
| Load error | Couldn't load your notification settings. Nothing has changed. |
| Holds expiring | {count} items are held and will expire in {duration}. Turn on a digest to receive them. |
| Email footer reason | You get this because **{event}** is on for Email. Change what you hear about → |
| Digest section title | Held for you |
| Digest section body | {count} notifications were held while you were over your attention budget. |
| Digest attention line | {emailUsed} of {emailLimit} emails and {channelUsed} of {channelLimit} channel messages were sent this period. |
| Bell footer link | Notification settings → |

### 6.10 Keyboard

- The matrix is a grid. **Tab** moves into it once and out of it once; the grid holds a single
  tab stop.
- **Arrow Left / Right** move across columns within a row; **Arrow Up / Down** move across rows,
  crossing group headings.
- **Home** / **End** jump to the first / last switch in the row; **Ctrl+Home** / **Ctrl+End**
  jump to the first / last switch in the grid.
- **Space** or **Enter** toggles the focused switch.
- **Shift+Space** toggles every switch in the focused row to the opposite of the focused switch's
  current position — the fast way to say "everything about this, or nothing about this".
- **Esc** closes the overflow picker, the edit-limits dialog and the reset dialog, restoring
  focus to the control that opened it.
- There is no undo shortcut. Toggling back is the undo, and the copy says so nowhere because it
  does not need to.
- Every switch exposes an accessible name of the form "{column} delivery for {event}", and its
  pressed state is announced. Row save state is announced once per settle through a polite live
  region: "Saved" or "Couldn't save {event}".
- Group headings are real headings, so heading navigation lands on the four groups.
- The budget meters are not colour-only: each carries its numbers as text and an explicit
  over-limit word.

## 7. Out of scope

- **Adding or configuring chat channels.** The Channels settings page owns that; the matrix only
  shows a column per channel that already exists and links there.
- **New delivery transports.** No SMS, no push, no browser notifications, no webhooks. Email and
  the existing chat channels only.
- **Per-Agent, per-Mission, per-Work or per-Organization notification routing.** Preferences are
  per user and workspace-global (FR-45).
- **An editor for organization-wide defaults.** The fallback already exists and is honoured; this
  epic neither builds nor removes an admin surface for it. See §9.
- **Redesigning the notification bell.** It gains one footer link (FR-44) and learns to hide
  silent records (FR-21). Nothing else about it changes.
- **The Live Feed.** [AW-04](../AW-04-live-feed/) owns it. This epic never suppresses a feed
  entry or an Activity record.
- **Answering decisions.** [AW-03](../AW-03-decision-queue/) owns My Decisions; this epic only
  routes the notice that one is waiting.
- **Changing what the digest computes.** The digest's existing sections, scan caps and quiet-window
  rule are unchanged; this epic adds two sections and one new-account default.
- **Spending caps.** [AW-17](../AW-17-costs-caps/) owns money ceilings. This epic's ceiling is
  attention, not spend, and the two are deliberately separate numbers.
- **Retention of notifications.** The existing cleanup schedule is unchanged.
- **A second notification store, feed or inbox.** Nothing here creates one.

## 8. Acceptance criteria

- [ ] Every switch on Settings → Notifications changes something, saves without a Save button,
      and survives a reload.
- [ ] The page contains no hard-coded English; every string resolves from the catalogue.
- [ ] The registry contains a row for every event key any producer emits, verified by a test that
      fails when a producer gains a key with no registration.
- [ ] Every registered event's category is a valid mute target, verified by a test.
- [ ] The eleven **Needs you** rows ship on for both In-app and Email; the two **Routine** rows
      ship off for both; the Digest row ships In-app off, Email on.
- [ ] An escalation with Email on produces an email at the account address within 60 seconds,
      carrying a working deep link and the "you get this because…" line.
- [ ] Turning every column off for one event persists as "nothing" and does not revert.
- [ ] With the email budget at 10 and 10 non-urgent emails already sent, an eleventh non-urgent
      event produces an in-app record, a hold, and no email.
- [ ] With the same exhausted budget, an urgent event still produces an email.
- [ ] A held item appears by name in the next digest and does not appear in the one after.
- [ ] A held item that no digest releases expires after 7 days and is never delivered.
- [ ] The budget meters show used, limit, held and time-to-reset, and refresh every 60 seconds.
- [ ] Quiet hours still defers non-urgent external delivery and still never defers an urgent one.
- [ ] A save failure reverts exactly one row and leaves the rest of the matrix usable.
- [ ] Four rapid clicks on one switch produce exactly one write.
- [ ] Deleting a channel removes its column on the next load without disturbing other choices.
- [ ] With no verified email address, Email switches are disabled with an explanation and stored
      choices are preserved.
- [ ] Requesting another user's preferences fails identically to requesting something absent.
- [ ] A selection naming a channel the user does not own is refused.
- [ ] Turning In-app off for an event stops it counting as unread and hides it from the bell's
      default list, while the Activity record and the Live Feed entry are unchanged.
- [ ] A persistent notification still appears when its In-app switch is off.
- [ ] The bell has a link to the matrix; the matrix has links to Channels and Digest; the Digest
      page's delivery copy is true.
- [ ] Every keyboard affordance in §6.10 works, and the grid holds exactly one tab stop.
- [ ] No fault in routing, budgeting or delivery prevents the in-app record from being written.

## 9. Open questions

- [NEEDS CLARIFICATION: should the attention budget be counted per rolling 24 hours, or per
  calendar day in the user's own timezone? Rolling is simpler and is what this spec assumes, but
  "10 a day" reads as a calendar day to most people, and the two disagree most on the day a user
  changes the limit.]
- [NEEDS CLARIFICATION: budget-cap alert emails are rich today — a themed template with a
  progress bar. Once budget alerts route through the matrix, do we keep that template for those
  two events, or standardise every notification email on one layout? Keeping it means the email
  sender carries a small first-party event-to-template map.]
- [NEEDS CLARIFICATION: should the chat-channel ceiling be one number for all channels together
  (as specified) or one number per channel? Per channel is more precise and four times more
  configuration.]
- [NEEDS CLARIFICATION: an organization default map already exists in the data model and is
  honoured by routing, but has no editor. Does an owner need one in this epic, or does it wait
  for a broader admin surface?]
- [NEEDS CLARIFICATION: when the budget holds an item whose category is later muted, should the
  hold still be released in the digest? This spec says yes — the hold records a decision that was
  already taken — but "mute means don't tell me" argues the other way.]
- [NEEDS CLARIFICATION: new accounts default to a weekly digest (FR-40). Should existing accounts
  with the digest off be offered a one-time prompt to turn it on, given the digest is now the
  release valve for held items?]
- [NEEDS CLARIFICATION: should a held item that is subsequently made irrelevant — an escalation
  answered, a failing provider recovered — be dropped from the digest rather than listed? That
  requires the hold to carry a resolvable reference, which it deliberately does not today.]

## 10. References

- Program: [Agent Workspace README](../README.md) · [tracker](../TRACKER.md)
- Upstream: [AW-04 Live Feed](../AW-04-live-feed/) — supplies the "visible instead" surface that
  makes the Routine defaults defensible.
- Downstream: [AW-17 Costs & caps](../AW-17-costs-caps/), [AW-19 Home](../AW-19-home/)
- Adjacent: [AW-03 My Decisions](../AW-03-decision-queue/) — the destination of the loudest events
- Implementation: [plan.md](./plan.md) · [tasks.md](./tasks.md)
- Governance: [Constitution](../../../../../.specify/memory/constitution.md)
