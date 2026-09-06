# AW-14 — What's new · in-product changelog · Product Spec

**Epic:** `AW-14-whats-new` · **Program:** [Agent Workspace](../README.md)
**Status:** Draft v1 · **Owner:** Product · **Date:** 2026-09-06
**Audience:** Product, Engineering (backend + frontend), Design
**Size:** S · **Blocking dependencies:** none
**Soft dependencies:** [AW-01](../README.md#3-epics) (a palette command that opens this panel),
[AW-25](../README.md#3-epics) (the Help centre links to it)

> **Additive-only (program rule #1, NN #20).** This epic removes nothing, renames nothing,
> and re-binds no existing keyboard shortcut. It adds one header control, one slide-over
> panel, one full-page list, and one read-state record per person per entry.
>
> **One new noun, already sanctioned.** The program overview names *Changelog entry* as one of
> the three genuinely-new nouns this program is allowed to introduce
> ([program overview §0](../README.md#0-why-this-program-exists)). §5 justifies it and, more
> importantly, fences it off from the Work content history that already exists.

---

## 1. Overview

A **What's new** panel, opened from a control in the dashboard top bar that carries an unread
count. It lists the changes we have shipped to Ever Works itself — newest first, each one a
short title, two or three sentences of plain language, a category, a "New / Improved / Fixed /
Security" badge, a date, and — where it earns one — a single button that takes the reader
straight into the thing being described. Entries are read individually as they scroll past,
the count goes down as they do, and one button clears the lot. Filter chips narrow the list to
one area of the product. A permalink page carries the same list for people who want to scroll
the whole history or share one entry.

The capability behind it is deliberately boring, because the maintenance cost of a changelog is
the whole game: **the entry list ships with the build**. Announcing a feature is one more small
block added in the same change that ships the feature, reviewed by the same reviewer, released
by the same deploy. There is no content management screen, no publishing workflow, no separate
system to keep alive, and no way for the changelog to describe a feature the running build does
not actually have.

## 2. Why now

**The user's question this answers:** *"What can it even do — and what changed since I last
looked?"* The program overview names the first half of that question and hands it to the
capability catalogue ([AW-21](../README.md#3-epics)). This epic owns the second half, which is
the half that repeats every week forever.

**What our users do today.** Nothing, because there is nothing to do. Ever Works ships changes
continuously and tells the people using it in exactly two places, neither of which is a
changelog:

| Where a change can surface today | Why it does not work as a changelog |
| --- | --- |
| The build/version chip in the dashboard footer | It is a build identifier. It tells you the deploy changed; it cannot tell you *what* changed or why you should care. |
| The notification bell | Every alert there is about **your** workspace — credits, a failed generation, an escalation. A product announcement dropped into that stream competes with, and dilutes, the alerts that are actually urgent, and inherits their dismiss-and-forget semantics. |
| The public documentation site | Off-product, requires leaving the dashboard, is organised by topic rather than by date, and does not know whether you have read a page. |
| The onboarding wizard | Fires once, for new accounts only, and is about setup rather than about change. |

The concrete costs of that gap, all of them ours:

| Gap | What it costs |
| --- | --- |
| Shipped features stay invisible | Every epic in this program adds surfaces. A surface nobody discovers is indistinguishable from a surface that was never built. |
| Returning users cannot tell what moved | Someone who was away for three weeks has no cheap way to catch up, so they carry a stale mental model of the product and keep using the old, slower path. |
| Support answers the same "can it…?" question repeatedly | The answer is often "yes, since last month" — and there is nowhere to point. |
| Behaviour changes arrive unannounced | A changed default, a new limit or a tightened permission is invisible until it surprises somebody mid-task. |
| Self-hosted deployments are worst off | An operator running their own build has no release feed at all inside the product they are running, and no reliable way to know which changes their build actually contains. |

**Why it is worth doing now, and why it is cheap.** This program is about to add roughly two
dozen new surfaces to a product whose only navigation is a sidebar. The discovery cost of every
one of those surfaces is paid by this epic or by nobody. Sized S with no blocking dependency,
it also gets *cheaper* the earlier it lands, because from that point on "announce it" is a
paragraph in the feature's own change rather than a retrospective archaeology exercise.

And the ingredients already exist: the dashboard shell already fetches a handful of small
facts on load, already renders a counted badge next to a top-bar control, already ships a
slide-over panel pattern, and already guards in-product links against being pointed anywhere
off-origin. This epic assembles those; it invents one small record type.

## 3. User scenarios

### 3.1 Happy paths

**S-1 — The count is the invitation.**
**Given** an owner who last opened the dashboard two weeks ago, and three entries have been
published since then,
**When** they load any dashboard screen,
**Then** the What's-new control in the top bar shows a badge reading `3`, and hovering it
reads "What's new — 3 unread".

**S-2 — Read the list, watch the count fall.**
**Given** that same owner with 3 unread entries,
**When** they open the panel and scroll so that the newest entry is fully visible for a second,
**Then** that entry's unread dot disappears, the header count becomes `2`, and the entry stays
in place in the list (it does not disappear, move, or grey out).

**S-3 — The entry takes them to the feature.**
**Given** an entry titled "Pause every agent from one switch" that carries a button reading
"Open safety rails",
**When** the owner activates that button,
**Then** the panel closes, the app navigates to that screen, and the entry is marked read
immediately regardless of how long it was on screen.

**S-4 — Narrow to one area.**
**Given** a list of 20 entries spanning five categories,
**When** the owner selects the **Knowledge & Memory** chip,
**Then** only entries in that category remain, the chip shows as selected, the header count
still reflects *all* unread entries (not just the filtered ones), and selecting **All** restores
the full list.

**S-5 — Clear it in one action.**
**Given** 12 unread entries across several categories, with the **Runs & Costs** filter active,
**When** the owner activates "Mark all as read",
**Then** every published entry — including the ones the current filter is hiding — becomes
read, the badge disappears entirely, and the list stays exactly where it was.

**S-6 — Read state follows the person, not the browser.**
**Given** an owner who cleared their unread count on a laptop this morning,
**When** they open the dashboard on a phone that afternoon,
**Then** the badge is absent and every entry they read is shown as read.

**S-7 — A brand-new account starts at zero.**
**Given** a person who signs up today, into a deployment with 180 published entries stretching
back a year,
**When** they land on the dashboard for the first time,
**Then** there is no badge and no unread state at all: everything published before their
account existed counts as already read. From their first day forward, the badge only ever
counts things that happened while they were a user.

**S-8 — Scroll the whole history and share one entry.**
**Given** an owner who wants more than the newest 20,
**When** they activate "See all updates" at the foot of the panel,
**Then** a full-page list opens showing entries 20 at a time with a "Load more" control; each
entry has a copyable permalink, and opening that permalink in a fresh tab scrolls to and
highlights that entry.

**S-9 — Announce on release day, land the entry on merge day.**
**Given** an entry authored with a publish date three days in the future,
**When** anyone opens the panel before that date,
**Then** the entry is invisible — it is not listed, not counted, and not reachable by
permalink — and it appears for everyone on the stated date without any further deploy.

### 3.2 Unhappy paths, races and empty states

**S-10 — The entry list cannot be fetched.**
**Given** the panel is open and the request for entries fails,
**When** the failure is observed,
**Then** the panel shows "Couldn't load updates." with a "Try again" button, the rest of the
dashboard is unaffected, and the top-bar badge is hidden rather than showing a stale or
guessed number.

**S-11 — The count cannot be fetched on page load.**
**Given** the dashboard shell loads and the unread-count request fails or times out,
**When** the top bar renders,
**Then** the What's-new control still renders and is still clickable, with **no badge at all** —
never a `0`, never a spinner that persists, never an error toast. The shell must not degrade
because a changelog count is unavailable.

**S-12 — A filter matches nothing.**
**Given** the **Decisions & Safety** chip is selected and no entry in the loaded page belongs
to it,
**When** the list renders,
**Then** the panel shows "Nothing here yet — no updates in Decisions & Safety." with a "Show
all updates" action, which is a *different* message from the never-any-entries empty state.

**S-13 — A deployment with no entries at all.**
**Given** a freshly-installed self-hosted deployment whose build shipped an empty entry list,
**When** an operator opens the panel,
**Then** it shows "No updates yet. New releases will show up here." and the top-bar control
carries no badge. It must not render an error and must not hide the control.

**S-14 — An older build cannot describe a newer feature.**
**Given** a self-hosted deployment pinned to a build from two months ago,
**When** an operator opens the panel,
**Then** they see only the entries that shipped in that build — nothing newer — because the
entry list is part of the build. There is no network call to a hosted feed and no
"available in a newer version" teaser.

**S-15 — A permalink for an entry this build does not have.**
**Given** somebody pastes a permalink from a newer deployment into an older one,
**When** the page loads,
**Then** it shows "That update isn't available on this version." with a link to the full list,
and it must not 500, must not render a blank page, and must not leak whether the identifier
ever existed anywhere.

**S-16 — Two tabs, one clear.**
**Given** the dashboard open in two tabs, both showing a badge of `4`,
**When** the owner clears the count in tab A,
**Then** tab B keeps showing `4` until it is refocused, at which point it refetches and shows
no badge. A second "Mark all as read" — from either tab — is accepted and changes nothing.

**S-17 — The same entry is read twice at once.**
**Given** an entry that becomes visible in two tabs simultaneously,
**When** both tabs record it as read,
**Then** exactly one read record exists, no error surfaces in either tab, and the count is
correct in both after refocus.

**S-18 — A call-to-action that cannot be trusted.**
**Given** an entry whose call-to-action target is anything other than an in-product path — an
absolute URL to another origin, a protocol-relative address, a scheme-bearing string,
a backslash-obfuscated path,
**When** the entry renders,
**Then** the button is **not rendered at all** and the rest of the entry renders normally. The
reader is never offered a button that navigates off-product.

**S-19 — A call-to-action that lands somewhere the reader cannot use yet.**
**Given** an entry pointing at a screen that requires a connection the reader has not made,
**When** they follow it,
**Then** they land on that screen's own empty or setup state — the changelog does not
pre-check, hide, or disable the button based on the reader's configuration, because a hidden
button teaches nobody that the feature exists.

**S-20 — Someone hammers the endpoints.**
**Given** a client that re-requests the list or replays mark-read calls in a tight loop,
**When** the per-person limits in FR-44 are exceeded,
**Then** further calls are refused with a retryable error and the panel shows the same
"Couldn't load updates. / Try again" state — no partial or duplicated read state results.

**S-21 — Keyboard only, no mouse.**
**Given** an owner navigating entirely by keyboard,
**When** they tab to the What's-new control and press `Enter`,
**Then** the panel opens, focus moves inside it, `Escape` closes it and returns focus to the
control they came from, and every action in the panel — chips, each entry's button, "Mark all
as read", "See all updates" — is reachable without a pointer.

**S-22 — Screen reader announcement.**
**Given** a screen-reader user on the dashboard,
**When** the top bar renders with 3 unread,
**Then** the control is announced as a button named "What's new, 3 unread updates", the panel
is announced as a dialog with the heading "What's new", and each entry announces its category
and kind before its title.

## 4. Functional requirements

Every requirement below is testable. Every default, limit, threshold and cadence is a number.

### 4.1 The entry catalogue

- **FR-1.** The set of changelog entries is **part of the running build**. A deployment shows
  exactly the entries that shipped in its build and makes no network call to any external or
  hosted feed to obtain them.
- **FR-2.** Authoring a new entry MUST be possible by adding one record to a single
  version-controlled list, in the same change that ships the feature it describes, with no
  schema change, no data migration and no separate publishing step.
- **FR-3.** There is **no runtime authoring surface**: no screen, no endpoint, and no
  administrator capability creates, edits, or deletes an entry in a running deployment.
- **FR-4.** Each entry carries exactly: a stable identifier, a title, a body, one category, one
  kind, one publish timestamp, an optional pinned flag, and at most one call-to-action
  (label + in-product target).
- **FR-5.** Limits, enforced at build time by an automated check and re-validated at load:
  title ≤ **80** characters; body ≤ **600** characters; call-to-action label ≤ **32**
  characters; at most **1** call-to-action per entry; body rendered as plain text with line
  breaks preserved and a maximum of **3** paragraphs. No markup is interpreted in title or body.
- **FR-6.** The stable identifier is a lowercase slug of 3–64 characters matching
  `[a-z0-9-]+`, unique across the catalogue, and MUST never be reused for a different entry —
  it is the permalink.
- **FR-7.** An entry whose publish timestamp is in the future is **invisible** to every reader:
  excluded from the list, excluded from unread counts, and not resolvable by permalink.
- **FR-8.** At most **1** entry may be pinned at any moment. The pinned entry sorts first
  regardless of date; all other entries sort by publish timestamp descending, ties broken by
  identifier ascending so ordering is stable.
- **FR-9.** Category is exactly one of **6** values, surfaced as: *Agents & Missions*,
  *Decisions & Safety*, *Knowledge & Memory*, *Connections & Computers*, *Runs & Costs*,
  *Platform*. The set is closed; adding a seventh is a spec change, not an authoring decision.
- **FR-10.** Kind is exactly one of **4** values, surfaced as a badge: *New*, *Improved*,
  *Fixed*, *Security*. Kind is **not** a filter dimension in this epic.
- **FR-11.** An entry's title and body are authored in English and are **not** translated per
  locale in this epic; the surrounding interface chrome (headings, chips, buttons, empty
  states, counts, dates) is fully localised. Dates are formatted in the reader's locale.

### 4.2 Read state and the unread count

- **FR-12.** Read state is recorded **per person per entry**, is durable server-side, and is
  identical on every device and browser that person signs in from.
- **FR-13.** Read state is **not** scoped to an Organization or Workspace: switching workspace
  scope never changes the unread count or which entries appear read.
- **FR-14.** **Signup baseline.** Every entry whose publish timestamp is earlier than the
  reader's account-creation timestamp counts as read for that reader, with no records written.
  A new account therefore always starts at zero unread.
- **FR-15.** The unread count is the number of published entries that are (a) newer than the
  reader's account-creation timestamp and (b) have no read record for that reader, computed
  over at most the newest **50** published entries.
- **FR-16.** An entry is marked read when any one of these occurs: at least **50 %** of its
  card has been continuously visible in the viewport for **≥ 1000 ms**; its call-to-action is
  activated; it is expanded or otherwise explicitly opened; or "Mark all as read" is used.
- **FR-17.** Visibility-driven read marks are **batched**: at most one write per **2000 ms**,
  carrying up to **25** entry identifiers per write.
- **FR-18.** Marking an entry read is **idempotent** — repeating it for the same person and
  entry succeeds and changes nothing.
- **FR-19.** "Mark all as read" marks every entry currently visible to that reader under
  FR-14/FR-7, **ignoring any active category filter**, and is idempotent.
- **FR-20.** Marking an entry read never removes, reorders, collapses, or greys out the entry.
  The only visible change is the loss of its unread indicator and the decrement of the count.
- **FR-21.** There is **no un-read action** in this epic: read state moves one way only.
- **FR-22.** Read records for entries that are no longer present in the running build are
  ignored when counting and are eligible for removal after **30** days.

### 4.3 Surfaces and navigation

- **FR-23.** A single What's-new control sits in the dashboard top bar, adjacent to the
  existing notification and help controls, on every authenticated dashboard screen at every
  viewport width including mobile.
- **FR-24.** The control carries a badge showing the unread count when it is ≥ 1, displaying
  `9+` for any count above **9**. It shows **no badge** when the count is `0` or unknown.
- **FR-25.** Activating the control opens a slide-over panel anchored to the right edge,
  **420 px** wide on viewports ≥ 768 px and full-width below that.
- **FR-26.** The panel lists the newest **20** visible entries and ends with a "See all
  updates" action.
- **FR-27.** A dedicated full-page list shows entries **20** at a time behind a "Load more"
  control, up to a maximum of **200** entries; beyond that the list ends with a note pointing at
  the public release notes.
- **FR-28.** Each entry on the full page has a copyable permalink. Opening a permalink scrolls
  the entry into view and applies a highlight for **2000 ms**.
- **FR-29.** Opening the panel does not navigate; the screen behind it is preserved, and
  closing returns the reader exactly where they were.
- **FR-30.** The panel MUST NOT open itself. It opens only on explicit activation of the
  control, a permalink, or a command that the reader invoked. No release-day modal, no
  interstitial, no auto-open on first load after a deploy.
- **FR-31.** The unread count is fetched **once per dashboard shell load**, server-side, with
  at most a **300 s** server-side cache, and refreshed on window focus only when **≥ 900 s**
  have passed since the last fetch. **No new polling interval is introduced.**
- **FR-32.** The changelog is available only to authenticated readers. This epic adds no
  public, unauthenticated changelog surface.

### 4.4 Filtering

- **FR-33.** The panel and the full page both present a single row of filter chips: **All**
  plus the **6** categories — **7** chips total.
- **FR-34.** Exactly one chip is selected at a time; **All** is the default on every open.
- **FR-35.** The filter selection is **not** persisted between sessions and resets to **All**
  each time the panel opens.
- **FR-36.** On the full page the filter is reflected in the address so a filtered view can be
  shared; in the panel it is not.
- **FR-37.** A category chip whose category has no visible entry in the current build is
  **disabled**, not hidden, and carries a tooltip reading "No updates in this area yet".
- **FR-38.** The unread count in the top bar always reflects **all** unread entries and is
  never affected by the active filter.

### 4.5 Call-to-action

- **FR-39.** A call-to-action target MUST be an in-product path beginning with exactly one `/`.
  Anything else — a scheme, a protocol-relative prefix, a backslash-obfuscated prefix, or an
  off-origin absolute URL — is invalid.
- **FR-40.** An invalid target causes the button not to render; the entry still renders in full.
  The reader is never shown a broken or off-product button.
- **FR-41.** An automated check that runs in continuous integration MUST fail the build if any
  entry's call-to-action target is invalid under FR-39 or does not correspond to a route the
  build actually serves.
- **FR-42.** Following a call-to-action closes the panel, navigates within the app (no full page
  reload, no new tab), and marks the entry read.
- **FR-43.** The changelog never inspects the reader's plan, connections, or provisioning state
  to decide whether to show a call-to-action; the destination screen owns its own empty state.

### 4.6 Limits, errors and performance

- **FR-44.** Per-person rate limits: entry list **120** requests/minute; unread count **120**
  requests/minute; mark-read **60** requests/minute; mark-all-read **10** requests/minute.
  Exceeding a limit returns a retryable error and never applies a partial change.
- **FR-45.** With the entry list already resolved, the panel becomes visible within **150 ms**
  of activation. A cold fetch of 20 entries completes within **1000 ms** at p95.
- **FR-46.** Any failure to load entries results in the panel's error state (FR in S-10) and
  never in a blank panel, an infinite spinner, a toast, or a dashboard-level error.
- **FR-47.** Any failure to load the unread count results in no badge, and never blocks,
  delays, or errors the dashboard shell.
- **FR-48.** Marking read is best-effort from the reader's point of view: a failed mark-read
  write is retried at most **2** times, then dropped silently. It never surfaces an error and
  never blocks reading.

### 4.7 Privacy, telemetry and accessibility

- **FR-49.** Read records contain only a person identifier, an entry identifier and a
  timestamp. No page, referrer, device, address or dwell information is stored.
- **FR-50.** Product analytics for this surface are limited to four counted events — panel
  opened, entry read, call-to-action followed, mark-all-read used — each carrying at most the
  entry identifier, the entry category and the surface (panel or page). No title, no body text.
- **FR-51.** The panel is a modal dialog with a labelled heading, an initial focus target, a
  focus trap while open, and focus restoration to the opener on close.
- **FR-52.** Keyboard affordances, exactly: `Enter`/`Space` on the control opens the panel;
  `Escape` closes it; `Tab`/`Shift+Tab` cycle within it; `↑`/`↓` move between entry cards;
  `Home`/`End` jump to the first and last card; `Enter` on a focused card follows its
  call-to-action if it has one; `←`/`→` move between filter chips, which form a single tab stop.
- **FR-53.** Unread state is conveyed by more than colour: an unread entry carries both a dot
  and the accessible text "Unread".
- **FR-54.** Every string in the interface chrome is a translation key; none is hard-coded.
  (Entry titles and bodies are content, not chrome — see FR-11.)

## 5. Key entities

### 5.1 New

**Changelog Entry** — *new, and deliberately so.*
A dated, human-readable description of one change we shipped to the Ever Works product.

*Why a new noun is unavoidable.* Every existing noun in the vocabulary describes something
that happens **inside a customer's workspace**: a Mission is work they delegated, an Activity
Log row is something their agents did, a Notification is an alert about their account. A
changelog entry is the opposite direction of travel — it is us telling them what we changed
about the product. Folding it into any of those would corrupt them: routed through
Notifications it inherits dismiss semantics and competes with credit and escalation alerts for
the same attention budget; routed through the Activity Log it pollutes an audit trail whose
value is that every row is attributable to somebody in the workspace.

*How it is fenced off from what exists.* Ever Works already has a per-Work content history that
records what a generation run added, updated and removed inside one directory. That is a record
of **content inside a Work**. A Changelog Entry is a record of **a change to the product**.
They share no data, no surface and no reader intent; nothing in this epic reads, writes or
renders the other. Where ambiguity is possible, this one is qualified as the *product*
changelog.

*Attributes (conceptual):* identifier (slug, permalink), title, body, category (1 of 6), kind
(1 of 4), publish timestamp, pinned flag, optional call-to-action (label + in-product path).

*States and transitions:*

```
   authored in a change          publish timestamp passes
   ┌──────────────┐   deploy    ┌────────────┐   (no action)   ┌────────────┐
   │  not present │ ──────────► │ SCHEDULED  │ ──────────────► │ PUBLISHED  │
   │  in build    │             │ (invisible)│                 │ (visible)  │
   └──────────────┘             └────────────┘                 └────────────┘
                                                                     │
                                                    build no longer ships it
                                                                     ▼
                                                              ┌────────────┐
                                                              │  ABSENT    │
                                                              │ (not an    │
                                                              │  archive — │
                                                              │  simply    │
                                                              │  gone from │
                                                              │  the build)│
                                                              └────────────┘
```

There is no manual state transition. `SCHEDULED → PUBLISHED` is time alone. `PUBLISHED →
ABSENT` only happens when a later build stops shipping the entry; read records that point at an
absent entry are ignored, then cleaned up (FR-22).

**Changelog Read** — *new, and the smallest possible record.*
One record per (person, entry) meaning "this person has seen this entry".

*States:* it exists or it does not. Absent = unread; present = read. There is no un-read
transition (FR-21), no partial state, and no per-workspace variant (FR-13).

```
                mark-all-read  ·  card visible ≥1s  ·  CTA followed
   ┌──────────┐ ──────────────────────────────────────────────────► ┌────────┐
   │  UNREAD  │                                                     │  READ  │
   │ (no row) │ ◄────────────────── no transition ───────────────── │ (row)  │
   └──────────┘                                                     └────────┘
```

### 5.2 Existing, and how this epic touches them

| Existing entity | Relationship | Changed by this epic? |
| --- | --- | --- |
| **Person / account** | Its creation timestamp is the read baseline (FR-14). | No — read only. |
| **Organization / Workspace scope** | Explicitly **not** part of read state or visibility (FR-13). | No. |
| **Notification** | Explicitly not used to deliver changelog entries; the bell keeps meaning "something about *your* workspace needs you". | No. |
| **Activity Log** | Not written to by this epic; a changelog entry is not workspace activity. | No. |
| **Build/version identity** | Already surfaced in the footer; the changelog is the human-readable companion to that machine identifier. | No. |

## 6. UX

### 6.1 Top-bar control

Placement: in the existing right-hand control cluster of the dashboard top bar, immediately
before the notification bell so that "about the product" reads left of "about your workspace".

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│  ☰   [ Acme Directory ▾ ]   ( Onboarding 3/9  ✕ )                                     │
│                                                                          ┌─┐         │
│                                                                          │3│         │
│                                                            [ ✨ ]  [ 🔔 ]  [ ☀ ]  [ ? ] │
│                                                              ▲                        │
│                                                       What's new                      │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

States of the control:

```
  unread = 0 or unknown      unread = 3                unread = 27
  ┌───────┐                  ┌───────┐ ┌─┐             ┌───────┐ ┌──┐
  │  ✨   │                  │  ✨   │ │3│             │  ✨   │ │9+│
  └───────┘                  └───────┘ └─┘             └───────┘ └──┘
  tooltip: "What's new"      "What's new — 3 unread"   "What's new — 9+ unread"
```

### 6.2 Panel — loaded, with unread entries

```
                     ┌───────────────────────────────────────────────────────┐
                     │  What's new                                       ✕   │
                     │  3 updates you haven't read                           │
                     ├───────────────────────────────────────────────────────┤
                     │ ┌────┐┌────────┐┌─────────┐┌─────────┐┌────────┐  ▸   │
                     │ │All ││Agents &││Decisions││Knowledge││Connect…│      │
                     │ └────┘└────────┘└─────────┘└─────────┘└────────┘      │
                     │                                    Mark all as read   │
                     ├───────────────────────────────────────────────────────┤
                     │  ┌─────────────────────────────────────────────────┐  │
                     │  │ 📌 Pinned                                       │  │
                     │  │ ● [New]  Agents & Missions       4 Sept 2026    │  │
                     │  │ Steer a mission without stopping it             │  │
                     │  │ Add a note to a running mission and the agent   │  │
                     │  │ picks it up on its next step — no cancel, no    │  │
                     │  │ restart, no lost context.                       │  │
                     │  │ ┌───────────────────┐                           │  │
                     │  │ │ Open missions     → │                           │  │
                     │  │ └───────────────────┘                           │  │
                     │  └─────────────────────────────────────────────────┘  │
                     │  ┌─────────────────────────────────────────────────┐  │
                     │  │ ● [Security]  Connections & Computers           │  │
                     │  │                                  2 Sept 2026    │  │
                     │  │ Per-agent scopes on every connection            │  │
                     │  │ Each agent now gets its own read-only or        │  │
                     │  │ read-write grant on a connected account, and    │  │
                     │  │ you can see which agent used which grant.       │  │
                     │  │ ┌────────────────────┐                          │  │
                     │  │ │ Review scopes   →  │                          │  │
                     │  │ └────────────────────┘                          │  │
                     │  └─────────────────────────────────────────────────┘  │
                     │  ┌─────────────────────────────────────────────────┐  │
                     │  │   [Improved]  Runs & Costs      28 Aug 2026     │  │
                     │  │ Every run now shows what it spent               │  │
                     │  │ A run's receipt lists the models it called and  │  │
                     │  │ the cost of each call.                          │  │
                     │  └─────────────────────────────────────────────────┘  │
                     │                                                       │
                     │              See all updates  →                       │
                     └───────────────────────────────────────────────────────┘

   ● = unread dot (accessible text: "Unread").  A read entry keeps its place,
   loses the dot, and its title drops from semibold to regular weight.
```

### 6.3 Panel — loading

```
                     ┌───────────────────────────────────────────────────────┐
                     │  What's new                                       ✕   │
                     ├───────────────────────────────────────────────────────┤
                     │  ┌─────────────────────────────────────────────────┐  │
                     │  │ ▒▒▒▒▒▒▒  ▒▒▒▒▒▒▒▒▒▒▒▒                          │  │
                     │  │ ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒            │  │
                     │  │ ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒                      │  │
                     │  └─────────────────────────────────────────────────┘  │
                     │  ┌─────────────────────────────────────────────────┐  │
                     │  │ ▒▒▒▒▒▒▒  ▒▒▒▒▒▒▒▒▒▒▒▒                          │  │
                     │  │ ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒             │  │
                     │  └─────────────────────────────────────────────────┘  │
                     │        (3 skeleton cards, no spinner, no text)        │
                     └───────────────────────────────────────────────────────┘
```

### 6.4 Panel — empty (nothing has ever been published)

```
                     ┌───────────────────────────────────────────────────────┐
                     │  What's new                                       ✕   │
                     ├───────────────────────────────────────────────────────┤
                     │                                                       │
                     │                        ✨                             │
                     │                                                       │
                     │                  No updates yet                       │
                     │        New releases will show up here.                │
                     │                                                       │
                     └───────────────────────────────────────────────────────┘
```

### 6.5 Panel — filter matched nothing

```
                     ┌───────────────────────────────────────────────────────┐
                     │  What's new                                       ✕   │
                     │  All caught up                                        │
                     ├───────────────────────────────────────────────────────┤
                     │ ┌────┐┌────────┐┌═════════┐┌─────────┐┌────────┐  ▸   │
                     │ │All ││Agents &││Decisions││Knowledge││Connect…│      │
                     │ └────┘└────────┘└═════════┘└─────────┘└────────┘      │
                     ├───────────────────────────────────────────────────────┤
                     │                                                       │
                     │              Nothing here yet                         │
                     │      No updates in Decisions & Safety.                │
                     │                                                       │
                     │              ┌────────────────────┐                   │
                     │              │  Show all updates  │                   │
                     │              └────────────────────┘                   │
                     └───────────────────────────────────────────────────────┘
```

### 6.6 Panel — error

```
                     ┌───────────────────────────────────────────────────────┐
                     │  What's new                                       ✕   │
                     ├───────────────────────────────────────────────────────┤
                     │                                                       │
                     │              Couldn't load updates.                   │
                     │                                                       │
                     │                ┌─────────────┐                        │
                     │                │  Try again  │                        │
                     │                └─────────────┘                        │
                     │                                                       │
                     └───────────────────────────────────────────────────────┘
```

### 6.7 Full page — `See all updates`

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│  What's new                                                                          │
│  Everything we've shipped, newest first.                    [ Mark all as read ]     │
│                                                                                      │
│  ┌────┐┌──────────────────┐┌───────────────────┐┌───────────────────┐┌─────────────┐ │
│  │All ││ Agents & Missions││ Decisions & Safety││ Knowledge & Memory││ Connections…│ │
│  └────┘└──────────────────┘└───────────────────┘└───────────────────┘└─────────────┘ │
│                                                                                      │
│  ────────────────────────────────────────────────────────────────────────────────    │
│  SEPTEMBER 2026                                                                      │
│                                                                                      │
│  ● [New]  Agents & Missions · 4 September 2026                              🔗       │
│    Steer a mission without stopping it                                               │
│    Add a note to a running mission and the agent picks it up on its next step —      │
│    no cancel, no restart, no lost context.                                           │
│    ┌───────────────────┐                                                             │
│    │ Open missions     → │                                                             │
│    └───────────────────┘                                                             │
│                                                                                      │
│  ● [Security]  Connections & Computers · 2 September 2026                   🔗       │
│    Per-agent scopes on every connection                                              │
│    …                                                                                 │
│                                                                                      │
│  ────────────────────────────────────────────────────────────────────────────────    │
│  AUGUST 2026                                                                         │
│                                                                                      │
│    [Improved]  Runs & Costs · 28 August 2026                                🔗       │
│    Every run now shows what it spent                                                 │
│    …                                                                                 │
│                                                                                      │
│                          ┌─────────────────┐                                         │
│                          │   Load more     │                                         │
│                          └─────────────────┘                                         │
└──────────────────────────────────────────────────────────────────────────────────────┘

   🔗 = "Copy link to this update" (icon button, appears on hover and on focus).
   Month headings are rendered from the entry dates; they are not authored.
```

### 6.8 Full page — permalink to an entry this build doesn't have

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│  What's new                                                                          │
│                                                                                      │
│              That update isn't available on this version.                            │
│                                                                                      │
│                     ┌────────────────────────┐                                       │
│                     │  See all updates       │                                       │
│                     └────────────────────────┘                                       │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

### 6.9 Exact user-visible copy

| Where | String |
| --- | --- |
| Control tooltip / accessible name, no unread | `What's new` |
| Control accessible name, with unread | `What's new — {count} unread` |
| Badge, count > 9 | `9+` |
| Panel heading | `What's new` |
| Panel subheading, unread ≥ 1 | `{count} updates you haven't read` |
| Panel subheading, unread = 1 | `1 update you haven't read` |
| Panel subheading, unread = 0 | `All caught up` |
| Filter chips | `All` · `Agents & Missions` · `Decisions & Safety` · `Knowledge & Memory` · `Connections & Computers` · `Runs & Costs` · `Platform` |
| Disabled chip tooltip | `No updates in this area yet` |
| Kind badges | `New` · `Improved` · `Fixed` · `Security` |
| Pinned marker | `Pinned` |
| Unread indicator, accessible text | `Unread` |
| Mark-all button | `Mark all as read` |
| Mark-all confirmation (inline, 3 s) | `All caught up` |
| Panel footer link | `See all updates` |
| Page heading | `What's new` |
| Page subheading | `Everything we've shipped, newest first.` |
| Permalink button, accessible name | `Copy link to this update` |
| Permalink copied toast | `Link copied` |
| Load-more button | `Load more` |
| End of list, at the 200-entry cap | `That's the last 200 updates.` |
| Empty — never any entries | `No updates yet` / `New releases will show up here.` |
| Empty — filter matched nothing | `Nothing here yet` / `No updates in {category}.` / `Show all updates` |
| Error | `Couldn't load updates.` / `Try again` |
| Unknown permalink | `That update isn't available on this version.` / `See all updates` |
| Close button, accessible name | `Close what's new` |

### 6.10 Keyboard affordances

| Key | Where | Effect |
| --- | --- | --- |
| `Tab` | Top bar | Reaches the What's-new control in visual order, before the notification bell. |
| `Enter` / `Space` | On the control | Opens the panel; focus moves to the panel heading. |
| `Escape` | Panel open | Closes the panel; focus returns to the control. |
| `Tab` / `Shift+Tab` | Panel open | Cycles within the panel only (focus trap). |
| `↑` / `↓` | Panel or page list | Moves focus between entry cards. |
| `Home` / `End` | Panel or page list | Focuses the first / last card. |
| `Enter` | On a focused card | Follows that card's call-to-action, if it has one. |
| `←` / `→` | On the chip row | Moves between chips (roving tab stop); selection follows focus. |
| `Enter` / `Space` | On a chip | Applies that filter (for assistive tech that does not follow focus). |

No new global shortcut is introduced and no existing one is re-bound. Where the command palette
exists, it offers a "What's new" command that opens this panel.

## 7. Out of scope

1. **A public, unauthenticated changelog page.** The marketing site and the docs site own the
   outward-facing release notes; this epic is inside the product only.
2. **Per-plan, per-organization or per-role targeting of entries.** Every authenticated reader
   in a deployment sees the same entries.
3. **Any runtime authoring surface** — no admin screen, no write endpoint, no scheduling UI.
   Authoring is a code change, and that is the point (FR-2, FR-3).
4. **Translating entry titles and bodies** into the 20 non-English locales. Chrome is
   localised; content is not (FR-11, and see open question Q-1).
5. **Rich content** — images, video, embedded media, tables, code blocks, links inside the body.
   One title, one plain-text body, one button.
6. **Delivering entries through email, the notification bell, chat channels or the digest.**
   The bell keeps meaning "your workspace needs you"; mixing product announcements into it is
   the failure mode this epic exists to avoid.
7. **Reactions, comments, votes, or a feedback widget** on entries.
8. **Un-reading, hiding, snoozing or dismissing** an individual entry.
9. **Auto-opening the panel** after a release, or any interstitial / modal announcement
   (FR-30).
10. **Search within the changelog.** With a 200-entry ceiling and six category filters, search
    is not yet earning its keep; if the archive outgrows that, it becomes a candidate for the
    command palette rather than a bespoke box.
11. **Version-aware "you're behind" messaging** for self-hosted deployments — telling an
    operator that a newer build exists is an upgrade-notification concern, not a changelog one.
12. **Per-entry analytics dashboards.** Four counted events, no reporting surface (FR-50).

## 8. Acceptance criteria

A reviewer can run this list end to end against a deployment.

**Catalogue and publishing**

- [ ] Adding one entry to the version-controlled list and deploying makes it visible, with no
      migration and no manual step.
- [ ] An entry with a future publish date is absent from the list, absent from the count, and
      not resolvable by permalink; it appears on its date without a redeploy.
- [ ] The build fails when an entry exceeds the title (80), body (600) or label (32) limits.
- [ ] The build fails when an entry's call-to-action target is off-origin, protocol-relative,
      backslash-prefixed, scheme-bearing, or points at a route the build does not serve.
- [ ] Two entries cannot share an identifier; the build fails if they do.
- [ ] At most one entry is pinned; the build fails if two are.

**Count and read state**

- [ ] A fresh account, on a deployment with 100+ published entries, shows no badge.
- [ ] Publishing three entries after that account was created makes the badge read `3`.
- [ ] Scrolling one entry into view for one second decrements the badge to `2` without the
      entry moving or disappearing.
- [ ] Following an entry's call-to-action marks it read immediately.
- [ ] "Mark all as read" with a category filter active clears **every** unread entry, not just
      the filtered ones.
- [ ] Read state set on one browser is reflected on a second browser after sign-in.
- [ ] Switching Organization does not change the badge or any entry's read state.
- [ ] A count above 9 renders as `9+`.
- [ ] Marking the same entry read twice, and marking all read twice, both succeed and change
      nothing.

**Surfaces**

- [ ] The control appears on every authenticated dashboard screen, including at 375 px width.
- [ ] The panel opens without navigating and closes back to the same scroll position.
- [ ] The panel never opens by itself after a deploy.
- [ ] The panel lists 20 entries and offers "See all updates".
- [ ] The full page loads 20 at a time, caps at 200, and shows the cap message at the end.
- [ ] A permalink scrolls to and highlights its entry for two seconds.
- [ ] An unknown permalink shows the version message, not a 500 or a blank page.

**Filters**

- [ ] Seven chips render; `All` is selected on every open.
- [ ] Selecting a category filters the list and does not change the badge.
- [ ] A category with no entries in this build renders disabled with its tooltip.
- [ ] The panel's filter resets to `All` on reopen; the page's filter is shareable in the
      address.

**Failure and degradation**

- [ ] With the entry endpoint failing, the panel shows the error state with a working retry and
      the dashboard is otherwise unaffected.
- [ ] With the count endpoint failing, the control renders with no badge and the shell loads
      normally.
- [ ] With mark-read failing, reading is unaffected and no error is shown to the reader.
- [ ] Exceeding the mark-all-read limit returns a retryable error and leaves state unchanged.

**Accessibility and i18n**

- [ ] The control announces as a button with its unread count.
- [ ] The panel announces as a dialog, traps focus, and restores focus on close.
- [ ] Every keyboard affordance in §6.10 works as described.
- [ ] Unread state is perceivable without colour.
- [ ] Every chrome string comes from a translation key; switching locale translates all chrome
      and formats every date for that locale.
- [ ] No new polling interval exists: with the panel closed, the dashboard issues no repeating
      changelog request.

## 9. Open questions

- **Q-1.** [NEEDS CLARIFICATION: Should entry titles and bodies be translated?] Today's answer
  is no (FR-11): 20 locales × every release is a recurring cost with no owner, and a stale
  translation of a product announcement is worse than an English one. The alternative — an
  optional per-locale override map, English as fallback — is cheap to add later and would not
  change any surface. Decide whether "later" needs a trigger (a locale crossing some share of
  active accounts?).
- **Q-2.** [NEEDS CLARIFICATION: What is the retention story past 200 entries?] The full page
  caps at 200 (FR-27) and points at the public release notes. At roughly one entry a week that
  is ~4 years, so this is not urgent — but the pointer target has to exist. Confirm the public
  release-notes destination before the cap message ships.
- **Q-3.** [NEEDS CLARIFICATION: Does an operator of a self-hosted deployment want to add their
  own entries?] An operator who forks or extends Ever Works might reasonably want to announce
  *their* changes in the same panel. That is a natural extension of a build-shipped catalogue
  and needs no runtime authoring — but it does need a documented extension point, and we should
  decide whether that is in scope for a later phase or explicitly declined.
- **Q-4.** [NEEDS CLARIFICATION: Should Security-kind entries be allowed to bypass the "never
  auto-open" rule?] FR-30 forbids interstitials without exception. A change that alters a
  security default is the one case where a passive badge may be too quiet. The safer
  alternative is a one-line banner owned by a different epic; confirm which.
- **Q-5.** [NEEDS CLARIFICATION: Where exactly does the control sit on mobile?] The top bar at
  375 px already carries a menu button, a switcher, the bell, the theme toggle and help. §6.1
  places What's-new before the bell at all widths; design should confirm whether the theme
  toggle or help moves into an overflow instead.
- **Q-6.** [NEEDS CLARIFICATION: Do we want a "since your last visit" divider?] A horizontal
  rule reading "New since you were last here" between unread and read entries is a small,
  well-liked affordance, but it needs a per-person last-visit timestamp, which is a second
  piece of state this epic otherwise avoids. Defer unless there is demand.
</content>
</invoke>
