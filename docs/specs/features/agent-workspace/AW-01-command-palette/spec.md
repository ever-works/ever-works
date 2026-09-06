# AW-01 — Command palette & global search · Product Spec

**Epic:** `AW-01-command-palette` · **Program:** [Agent Workspace](../README.md)
**Status:** Draft v1 · **Owner:** Product · **Date:** 2026-09-06
**Audience:** Product, Engineering (backend + frontend), Design
**Size:** M · **Blocking dependencies:** none
**Depended on by:** [AW-25](../README.md#3-epics) (Help centre in product)

> **Additive-only (program rule #1, NN #20).** Nothing in this epic removes a screen, a
> route, a sidebar entry, or an entity. The sidebar stays exactly as it is. The Works
> switcher in the top bar stays exactly as it is. The two Knowledge-Base search palettes stay
> exactly as they are. This epic adds **one new overlay** and **one new read-only search
> capability** on top of them.
>
> **One deliberate re-binding.** `Ctrl/Cmd+K` today jumps to the Works list and focuses that
> page's filter box. After this epic `Ctrl/Cmd+K` opens the palette instead. The old
> destination is not removed — it becomes a first-class palette command ("Search Works") and
> the Works page keeps honouring its `focus=search` entry point. See FR-4 and §7.

---

## 1. Overview

A single overlay — opened from anywhere in the dashboard with `Ctrl+K` / `Cmd+K` — where the
user types a few characters and gets, in one ranked and grouped list: every screen in the
product, every Agent, Mission, Task, Work, Idea, Skill, Team and Knowledge-Base document they
can open, and every **action** they can take without leaving the keyboard ("New Mission",
"Open Help", "Switch workspace to …", later "Pause Ivy"). Arrow keys move, `Enter` opens,
`Esc` closes, `Tab` narrows to one group. It remembers what the user opened recently, so the
overlay is useful the instant it opens, before a single character is typed.

The capability behind it is a **workspace-wide search read model**: one request answers
"where is anything called *X* in my workspace", scoped to exactly what the caller is allowed
to open, across every first-class noun the product owns.

## 2. Why now

**The user's question this answers:** *"Where do I go?"* — one of the six questions the
Agent Workspace program exists to make cheap ([program overview §0](../README.md#0-why-this-program-exists)).

**What they do today.** Navigation is entirely sidebar-click-driven. The left nav carries 14
top-level entries; behind them sit well over sixty routes. To reach one specific Agent an
owner clicks *Teams* → *Agents* → scans a grid → maybe types into that page's own filter box.
To reach one specific Task: *Tasks* → filter box. To reach one Knowledge-Base document:
*Works* → pick the Work → *KB* → the Work-scoped palette. Every list page has its own filter
input; **not one of them is reachable from anywhere else**, and none of them can find
anything outside its own page.

The concrete gaps this creates:

| Gap | What it costs the user today |
| --- | --- |
| No cross-entity search | "Find the Skill called *invoice-triage*" requires knowing that Skills live behind the Teams nav entry. |
| No keyboard route to a named record | You cannot get to a specific Agent, Task, Mission, Team, Goal or Meeting by typing its name from anywhere. |
| `Ctrl+K` is misleading | It is advertised in the Help drawer as "Search works" — a modal-less hard navigation to one list page. Users press it expecting an overlay. |
| Actions need a mouse | "Create a Mission" means: find the nav entry, land on the list page, find the button. |
| Deep routes are invisible | Roughly 20 Settings sub-pages and 14 Work sub-pages have no entry point except clicking through their parent. |
| Nothing remembers | Returning to the Mission you were in five minutes ago is a fresh navigation every time. |

As the product's surface area grows — every subsequent epic in this program adds screens —
sidebar-only navigation gets **worse monotonically**. This epic is sized M, has no blocking
dependency, and every later epic gets cheaper to reach the moment it lands: a new screen
becomes reachable by registering one entry, not by contending for one of 14 sidebar slots.

Finally, the ingredients are already paid for. The palette component library is already a
dependency and already proven in the Knowledge-Base workbench. The portable
case-insensitive search helpers already exist and are already used by six repositories. The
scope-aware read-aggregation pattern already exists and already ships in production. This
epic assembles what is there rather than inventing it.

## 3. User scenarios

### 3.1 Happy paths

**S-1 — Jump to a named record from anywhere.**
**Given** an owner is on the Activity screen and has an Agent named "Ivy",
**When** they press `Ctrl+K`, type `ivy`, and press `Enter`,
**Then** the palette opens within 100 ms, shows an **Agents** group whose first row is "Ivy"
selected by default, and `Enter` navigates to that Agent's detail screen and closes the
palette.

**S-2 — The empty state is already useful.**
**Given** an owner who opened a Mission and two Works earlier today,
**When** they press `Ctrl+K` and type nothing,
**Then** the palette shows a **Recent** group with up to 5 of their most recently opened
records (newest first), followed by a **Suggested** group of up to 6 commands, and `Enter`
opens the top Recent row.

**S-3 — Type what you want to do, not where you want to go.**
**Given** an owner anywhere in the dashboard,
**When** they press `Ctrl+K` and type `new mission`,
**Then** a **Commands** group appears above the record groups with "New Mission" first, and
`Enter` opens the Mission creation screen.

**S-4 — Reach Help without knowing where Help lives.**
**Given** an owner who has never opened the Help drawer,
**When** they press `Ctrl+K` and type `help`,
**Then** the **Commands** group contains "Open Help" and "Keyboard shortcuts", and `Enter` on
the first opens the Help drawer over the current screen without navigating away.

**S-5 — Narrow to one kind of thing.**
**Given** the query `report` matches 3 Missions, 11 Tasks and 6 Knowledge documents,
**When** the user presses `Tab` while a row inside the **Tasks** group is highlighted,
**Then** the palette applies a "Tasks" filter chip, re-queries with that filter, shows up to
25 Task rows, and `Shift+Tab` (or `Backspace` on an empty query) removes the chip.

**S-6 — Deep routes become reachable.**
**Given** an owner who wants the job-runtime settings page,
**When** they type `runtime`,
**Then** a **Screens** group offers "Settings → Job runtime" with its breadcrumb visible, and
`Enter` navigates there.

**S-7 — Mouse users are not punished.**
**Given** an owner who never learns the shortcut,
**When** they click the "Search…  ⌘K" control in the top bar,
**Then** the same palette opens with the input focused, and clicking any row opens it.

**S-8 — Recency beats alphabet.**
**Given** two Missions match `q3` and the user opened one of them yesterday from the palette,
**When** they type `q3`,
**Then** the recently opened Mission ranks above the other even though both are exact
substring matches.

### 3.2 Unhappy paths

**S-9 — Query too short.**
**Given** the palette is open,
**When** the user has typed exactly one character,
**Then** **no** search request is issued, the palette continues to show Recent + Commands
(both filtered client-side by that character), and a muted footer reads
"Keep typing — 2 characters minimum."

**S-10 — Nothing matches.**
**Given** the user types `zzzqqq`,
**When** the search returns zero rows across every group,
**Then** the palette shows "No matches for “zzzqqq”" plus exactly three fallback rows —
"Ask the AI chat panel about “zzzqqq”", "Create a Mission from “zzzqqq”", "Open Help" — and
`Enter` activates the first.

**S-11 — One source is broken, the rest are not.**
**Given** the Knowledge-Base source errors while the other sources succeed,
**When** the results render,
**Then** every healthy group renders normally, the Knowledge group is absent, and a footer row
reads "Some results couldn't be loaded. Showing what we have." The palette does **not** show
an error screen and does **not** drop the healthy results.

**S-12 — The search is slow.**
**Given** the server has not answered within 3.5 s,
**When** the client aborts,
**Then** the palette keeps the previous result set visible, greys it, and shows
"Search took too long. Press Enter to try again." `Enter` re-issues the same query rather
than opening the greyed selection.

**S-13 — The user is offline.**
**Given** the browser reports no connectivity,
**When** the user types,
**Then** the palette shows Recent + Commands only (both local), with a footer reading
"You're offline. Showing recent items only." No request is attempted.

**S-14 — The record was deleted underneath them.**
**Given** a Recent row points at a Mission another session has since deleted,
**When** the user activates it,
**Then** the palette closes, a toast reads "That Mission no longer exists. It's been removed
from Recent.", the Recent entry is deleted, and the user stays on the screen they were on —
they are **not** dropped on a 404 page.

**S-15 — A command the user may not run.**
**Given** a user whose role does not permit pausing Agents,
**When** they type `pause`,
**Then** the "Pause Agent…" row renders disabled with the trailing note "Needs owner access",
is skipped by arrow-key navigation, and activating it with `Enter` or a click does nothing
except announce the reason to screen readers.

**S-16 — Nothing from another workspace ever appears.**
**Given** a user who belongs to two Organizations, currently scoped to Organization A,
**When** they search for a term that matches a Mission that exists **only** in Organization B,
**Then** zero rows are returned. Switching scope to Organization B and repeating the identical
query returns the Mission.

**S-17 — Scope changes while the palette is open.**
**Given** the palette is open with results on screen,
**When** the active Organization changes in another tab and this tab re-syncs,
**Then** the palette discards the current results, re-runs the query in the new scope, and
keeps any group filter chip that is still valid.

**S-18 — Typing fast.**
**Given** a user types 12 characters in under a second,
**When** the debounce elapses,
**Then** exactly **one** request is issued (for the final query), any earlier in-flight request
is aborted, and no out-of-order response can overwrite a newer one.

**S-19 — Opening the palette from inside a text field.**
**Given** the caret is inside the AI chat composer,
**When** the user presses `Ctrl+K`,
**Then** the palette opens (the modifier combination is unambiguous) and no character is
inserted into the composer. Pressing `/` in the same situation types a slash and does
**not** open the palette.

**S-20 — A destructive command asks first.**
**Given** the user selects "Pause Agent — Ivy",
**When** they press `Enter`,
**Then** the palette replaces its list with an inline confirmation ("Pause Ivy? It will stop
picking up work until you resume it." / **Cancel** · **Pause**), `Esc` returns to the results
without acting, and only the explicit confirm issues the change.

**S-21 — Very large workspaces.**
**Given** a workspace with more than 25 matching Tasks for the query,
**When** results render,
**Then** the Tasks group shows 5 rows plus a "Show all 137" row; activating it applies the
Tasks filter chip and shows the first 25, with the remainder reachable through the Tasks list
screen (the palette never paginates past 25 in one group).

## 4. Functional requirements

### 4.1 Opening, closing and focus

- **FR-1** The palette opens on `Ctrl+K` (Windows/Linux) and `Cmd+K` (macOS) from **every**
  authenticated dashboard screen, including while focus is inside an input, textarea, select
  or contenteditable element. The keystroke is consumed (no default browser action, no
  character inserted).
- **FR-2** The palette also opens on `/` **only** when focus is not in an input, textarea,
  select or contenteditable element and no modifier key is held.
- **FR-3** The palette also opens by activating a persistent control in the top bar labelled
  "Search…" with a trailing hint chip reading `⌘K` on macOS and `Ctrl K` elsewhere.
- **FR-4** The pre-existing behaviour of `Ctrl/Cmd+K` — navigate to the Works list with its
  filter focused — remains reachable as the palette command **"Search Works"**, which
  navigates to the Works list and focuses its filter exactly as before. The Works list keeps
  honouring its existing focus-the-filter entry point unchanged.
- **FR-5** `Esc` closes the palette. Closing restores DOM focus to the element that held it
  when the palette opened. Clicking outside the palette closes it. Navigating away closes it.
- **FR-6** Opening the palette when it is already open is a no-op (it does not reset the query).
- **FR-7** Only one palette may be open at a time. If a screen-scoped palette already exists
  on the current screen (the Knowledge-Base workbench), `Ctrl/Cmd+K` on that screen continues
  to open the screen-scoped one; the global palette is reachable there via the top-bar control.

### 4.2 Querying

- **FR-8** Typing issues a search request after a **150 ms** debounce.
- **FR-9** No search request is issued for a trimmed query shorter than **2** characters.
  Below that threshold, Recent and Commands are filtered client-side only.
- **FR-10** At most one search request is in flight. A newer query aborts the older request;
  a response for a superseded query is discarded.
- **FR-11** The client aborts a request that has not completed within **3 500 ms** and enters
  the timeout state (S-12).
- **FR-12** Matching is case-insensitive and diacritic-insensitive for Latin scripts, and
  operates on: an entity's display name/title, its human identifier (slug or short reference
  where one exists), and one secondary field per kind (description, path, or tag list).
- **FR-13** In addition to substring matching, a query matches when its characters occur
  **in order** within the display name (subsequence/"fuzzy" match). Fuzzy-only matches score
  strictly below every substring match (FR-14).
- **FR-14** Every result carries a deterministic integer score in `0..100`:

  | Match quality | Score |
  | --- | --- |
  | Query equals the display name or identifier (case-insensitive) | 100 |
  | Display name starts with the query | 90 |
  | A word inside the display name starts with the query | 80 |
  | Display name contains the query | 65 |
  | Identifier contains the query | 60 |
  | Secondary field contains the query | 40 |
  | Fuzzy subsequence match on the display name | 25 |

  Two additive boosts apply, capped at 100: **+10** if this user opened this exact record from
  the palette within the last 7 days; **+5** if the record changed within the last 24 hours.
- **FR-15** Ties break in this order: higher score → more recently changed → kind priority
  (Commands, Screens, Missions, Tasks, Agents, Works, Ideas, Skills, Teams, Knowledge, then
  the P2 kinds in the order listed in FR-18) → display name ascending, case-insensitive.
- **FR-16** Results are grouped by kind. Group order follows the kind priority in FR-15, except
  that any group containing a score-100 result is promoted to the top.
- **FR-17** A group renders at most **5** rows, followed by a "Show all {n}" row when more
  matched. Applying a group filter shows at most **25** rows for that group. The palette never
  shows more than **25** rows for one group and never more than **60** rows in total.

### 4.3 What is searchable

- **FR-18** The following kinds are searchable. Every one of them is an entity Ever Works
  already owns; **none is new**:

  | Phase | Kind (group label) | Matched on |
  | --- | --- | --- |
  | P1 | **Commands** | command label + its alias list |
  | P1 | **Screens** | screen title + its breadcrumb path |
  | P1 | **Missions** | title, description |
  | P1 | **Tasks** | reference, title, description, labels |
  | P1 | **Agents** | name, slug, title |
  | P1 | **Works** | name, slug, description |
  | P1 | **Ideas** | title, description |
  | P1 | **Skills** | name, slug, description |
  | P1 | **Teams** | name, slug, description |
  | P1 | **Knowledge** | document title, path, description, tags |
  | P2 | **Runs** | run reference, summary, owning Agent name |
  | P2 | **My Decisions** | approval/escalation subject line |
  | P2 | **Memory** | folder name, folder path, file name |
  | P2 | **Goals** | title |
  | P2 | **Meetings** | title, summary |
  | P2 | **Computers** | node name (the Fleet node surface) |
  | P2 | **Connections** | installed plugin name + connected account label |

- **FR-19** Every result row carries: kind, display name, an optional secondary line
  (breadcrumb, status, owner or timestamp), an optional status badge, and a destination.
- **FR-20** The **Screens** registry contains one entry per navigable screen in the dashboard,
  including every Settings sub-page and every Work sub-page, each with its full breadcrumb.
  A screen the user cannot reach in the current scope is not listed.
- **FR-21** The **Connections** group resolves installed integrations through the platform's
  capability resolution, not from a hardcoded list of integration identifiers.

### 4.4 Commands

- **FR-22** P1 ships these commands, all of which are pure navigation or pure client-side UI
  state and therefore need no confirmation:
  1. `New Mission`, `New Idea`, `New Work`, `New Task`, `New Agent`, `New Team`, `New Skill`,
     `New Goal`, `New Meeting` — open the matching creation screen.
  2. `Search Works` — the preserved legacy destination (FR-4).
  3. `Open Help`, `Keyboard shortcuts` — open the Help drawer, on its Shortcuts tab for the
     second.
  4. `Toggle dark mode`, `Collapse sidebar` / `Expand sidebar`, `Open AI chat` / `Close AI chat`.
  5. `Copy link to this page` — copies the current absolute URL to the clipboard and toasts
     "Link copied".
  6. `Switch workspace → {organization}` — one row per Organization the user belongs to.
  7. `Switch Work → {work}` — one row per Work, mirroring the top-bar Work switcher.
  8. `Sign out`.
- **FR-23** P3 adds commands that change server state. Each one **must** show an inline
  confirmation before acting (S-20): `Pause Agent…`, `Resume Agent…`, `Run Agent now…`,
  `Pause Mission…`, `Resume Mission…`, `Run Work schedule now…`, `Run Task…`. Each takes a
  target chosen in a second palette step.
- **FR-24** A command the caller is not permitted to run is rendered disabled with a trailing
  reason, is skipped by keyboard navigation, and cannot be activated.
- **FR-25** Every command has at least two aliases so it is findable by intent as well as by
  name (e.g. `New Mission` also matches `create mission`, `start mission`).

### 4.5 Recent

- **FR-26** Opening any record **from the palette** records it as Recent for that user in that
  scope. Opening a Command does not.
- **FR-27** At most **12** Recent entries are kept per user per scope; a repeat open moves the
  existing entry to the top rather than duplicating it. The empty state shows the top **5**.
- **FR-28** Recent entries older than **90 days** are discarded.
- **FR-29** A Recent entry whose target no longer exists or is no longer visible to the user is
  removed the first time it is activated (S-14) and is skipped by the reconcile sweep.
- **FR-30** In P1 Recent is per-browser. From P2 it is stored per user and therefore follows
  them across devices. Where per-user storage is unavailable, the per-browser fallback still
  works and the palette never errors because of it.

### 4.6 Permissions, scope and safety

- **FR-31** A result is returned **only** if the caller could open its destination directly.
  There is no result the user can see but not open — the palette does not become an
  enumeration oracle.
- **FR-32** Every query is scoped to the caller and the active workspace scope: the caller's
  own records always; Organization-scoped records only while that Organization is active;
  personal-scope records only while no Organization is active.
- **FR-33** Knowledge documents are returned only for Works the caller owns or is a member of.
- **FR-34** No secret-bearing field is ever matched against or returned. Credentials, tokens,
  webhook secrets and encrypted columns are excluded from the search read model entirely.
- **FR-35** The search endpoint is rate-limited to **120 requests per 60 seconds** per user.
  Exceeding it returns the standard throttled response; the palette shows
  "Too many searches. Try again in a moment." and stops issuing requests for 5 seconds.
- **FR-36** Query strings are never written to any analytics event. Only the query **length**,
  the result count, the latency and the kinds that matched are recorded.

### 4.7 Availability and freshness

- **FR-37** A failure in one kind's source must not fail the request. A failed kind contributes
  zero rows and is reported in the response so the client can render S-11.
- **FR-38** Server-side p95 latency budget: **≤ 600 ms** in P1 (live fan-out), **≤ 250 ms** from
  P2 (index-backed).
- **FR-39** From P2, a change to a searchable record is reflected in search results within
  **60 seconds** at p95. A reconcile sweep runs every **15 minutes** and repairs any drift; a
  full verification pass runs nightly.
- **FR-40** If the index is unavailable or a kind has no index coverage, the endpoint falls back
  to the P1 live fan-out for that kind rather than returning nothing.

### 4.8 Accessibility and input

- **FR-41** Keyboard model:

  | Key | Behaviour |
  | --- | --- |
  | `↑` / `↓` | Move selection across groups, skipping disabled rows and group headers |
  | `Home` / `End` | First / last selectable row |
  | `Enter` | Activate the selected row |
  | `Ctrl/Cmd + Enter` | Open the selected record in a new browser tab (records only) |
  | `Tab` | Apply the selected row's group as a filter chip |
  | `Shift + Tab` | Remove the filter chip |
  | `Backspace` on an empty query | Remove the filter chip, else close |
  | `Ctrl/Cmd + 1..9` | Activate the nth visible row |
  | `Esc` | Dismiss confirmation → remove chip → close |

- **FR-42** The overlay is a modal dialog with a focus trap; background content is inert while
  it is open. The input/list pair follows the combobox-with-listbox pattern, with the active
  row announced via active-descendant.
- **FR-43** The result count is announced politely on every settled result set
  ("{n} results"), not on every keystroke.
- **FR-44** Every row has a visible focus indicator meeting 3:1 contrast in both themes, and no
  information is conveyed by colour alone (status is a badge with text).
- **FR-45** On viewports narrower than 768 px the palette renders full-screen, the top-bar
  trigger collapses to an icon, and rows meet a 44 px minimum touch target.
- **FR-46** All user-visible strings are translated; the palette works in right-to-left locales
  with the hint chips and group headers mirrored.

## 5. Key entities

### 5.1 Existing — searched, never modified

| Entity | Role in this epic |
| --- | --- |
| Mission, Task, Agent, Work, Idea, Skill, Team | P1 result kinds |
| Knowledge Base document | P1 result kind |
| Run, Approval / Escalation, Memory folder, Goal, Meeting, Node, Plugin + Connection | P2 result kinds |
| Organization / Workspace scope | Scopes every query (FR-32) |

This epic **reads** all of the above and writes to none of them.

### 5.2 New — two internal records, no new user-facing noun

Per program rule #2, both are named explicitly here and justified. Neither introduces a word
the user ever sees; the user-facing vocabulary is unchanged.

**A. Search Index Entry** *(new, internal projection — P2)*

One denormalized row per searchable record, holding only what ranking and rendering need:
the owning scope, the kind, the source record's identity, its display name, its identifier,
its secondary text, its status label, its destination, and its last-changed timestamp.

*Why it must exist:* P1 answers each query by fanning out across ten repositories. That is
correct and shippable, but it costs ten scoped queries per keystroke-batch, it cannot rank
across kinds without materialising every candidate, and it grows linearly with every kind a
later epic adds. A projection makes ranking one ordered read and holds FR-38's 250 ms budget.
It is a **cache of rows that already exist**, never a source of truth.

States and transitions:

```
        (source row created)            (source row changed)
                │                                │
                ▼                                ▼
          ┌──────────┐   marked by writer   ┌─────────┐
          │ CURRENT  │ ───────────────────► │  STALE  │
          └──────────┘                      └─────────┘
             ▲    │                              │
             │    │ (source row deleted)         │ refreshed by the
             │    ▼                              │ maintenance job
             │  ┌────────────┐                   │
             │  │ TOMBSTONED │◄──────────────────┘  (row gone at refresh)
             │  └────────────┘
             │        │  swept after 24h
             └────────┴─── refresh writes new values, returns to CURRENT
```

- `CURRENT` — matches its source; eligible for results.
- `STALE` — source changed, refresh pending; **still eligible** (a slightly stale title is
  better than a missing row), and re-ranked with its stored timestamp.
- `TOMBSTONED` — source is gone or no longer visible; **never** returned; hard-deleted by the
  sweep 24 hours later so a resurrected record can be re-indexed cleanly.

**B. Workspace Search Recent** *(new, internal, tiny — P2)*

One row per (user, scope, target) recording the last time this user opened that target from
the palette. Holds no content beyond the target's identity and a timestamp.

*Why it must exist:* FR-14's recency boost and FR-27's empty state are what make the palette
useful in its first 200 ms, before anything is typed. Per-browser storage cannot follow a user
between their laptop and their desktop, and browser storage access legitimately throws in
private/locked-down browsers — so it is the fallback, not the mechanism. States: `ACTIVE` →
`EXPIRED` (older than 90 days, swept) or `ORPHANED` (target gone — deleted on first activation
per FR-29).

**C. Command** *(new, but not persisted)*

A registry entry in the web application: a stable identifier, a label, an alias list, an icon,
a permission predicate, an optional confirmation, and a handler. Commands are code, not data —
there is no table, no migration and no API for them.

## 6. UX

### 6.1 Where the trigger lives

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ ▤  [Work switcher ▾]   ⌕ Search…            ⌘K │   🔔   ☾   ?               │  ← top bar
└──────────────────────────────────────────────────────────────────────────────┘
                          └──────── new ────────┘
```

The trigger sits between the existing Work switcher and the existing right-hand cluster.
Nothing is moved or removed. Below 768 px it collapses to the `⌕` icon alone.

### 6.2 Open, empty query

```
        ╔══════════════════════════════════════════════════════════════════╗
        ║  ⌕  Search or type a command…                                    ║
        ╟──────────────────────────────────────────────────────────────────╢
        ║  RECENT                                                          ║
        ║  ▸ ◈  Q3 partner outreach            Mission · active    2m ago  ║ ← selected
        ║    ▤  TASK-418 Draft the follow-up   Task · in review    18m ago ║
        ║    ⬢  acme-directory                 Work · ready        1h ago  ║
        ║    ✦  Ivy                            Agent · active      3h ago  ║
        ║    ▤  TASK-402 Reconcile invoices    Task · done         y'day   ║
        ╟──────────────────────────────────────────────────────────────────╢
        ║  SUGGESTED                                                       ║
        ║    ＋ New Mission                                                ║
        ║    ＋ New Task                                                   ║
        ║    ⌂  Go to Home                                                 ║
        ║    ?  Open Help                                                  ║
        ║    ☾  Toggle dark mode                                           ║
        ║    ⇄  Switch workspace…                                          ║
        ╟──────────────────────────────────────────────────────────────────╢
        ║  ↑↓ Navigate   ↵ Open   ⇥ Filter group   esc Close               ║
        ╚══════════════════════════════════════════════════════════════════╝
```

### 6.3 Typing — grouped results

```
        ╔══════════════════════════════════════════════════════════════════╗
        ║  ⌕  invoice                                                  ✕   ║
        ╟──────────────────────────────────────────────────────────────────╢
        ║  COMMANDS                                                        ║
        ║  ▸ ＋ New Task “invoice”                                         ║
        ╟──────────────────────────────────────────────────────────────────╢
        ║  MISSIONS                                                    3   ║
        ║    ◈  Invoice reconciliation           active     · updated 2m   ║
        ║    ◈  Q3 invoicing cleanup             paused     · updated 4d   ║
        ║    ◈  Supplier invoice intake          active     · updated 2w   ║
        ╟──────────────────────────────────────────────────────────────────╢
        ║  TASKS                                                     137   ║
        ║    ▤  TASK-418 Invoice follow-up       in review  · Ivy          ║
        ║    ▤  TASK-402 Reconcile invoices      done       · Ivy          ║
        ║    ▤  TASK-377 Invoice template        blocked    · unassigned   ║
        ║    ▤  TASK-311 Late invoice sweep      todo       · Ivy          ║
        ║    ▤  TASK-289 Invoice import errors   backlog    · unassigned   ║
        ║    ⋯  Show all 137                                               ║
        ╟──────────────────────────────────────────────────────────────────╢
        ║  SKILLS                                                      1   ║
        ║    ⚙  invoice-triage                   3 Agents use this         ║
        ╟──────────────────────────────────────────────────────────────────╢
        ║  KNOWLEDGE                                                   4   ║
        ║    ▦  Invoice policy      acme-directory / legal / invoice-policy║
        ║    ▦  Billing glossary    acme-directory / glossary / billing    ║
        ║    ⋯  Show all 4                                                 ║
        ╟──────────────────────────────────────────────────────────────────╢
        ║  ↑↓ Navigate   ↵ Open   ⌘↵ New tab   ⇥ Filter   esc Close        ║
        ╚══════════════════════════════════════════════════════════════════╝
```

### 6.4 Group filter applied

```
        ╔══════════════════════════════════════════════════════════════════╗
        ║  ⌕  [ Tasks ✕ ] invoice                                          ║
        ╟──────────────────────────────────────────────────────────────────╢
        ║  TASKS · showing 25 of 137                                       ║
        ║  ▸ ▤  TASK-418 Invoice follow-up       in review  · Ivy          ║
        ║    …  (24 more rows)                                             ║
        ║    →  Open the Tasks screen for the full list                    ║
        ╟──────────────────────────────────────────────────────────────────╢
        ║  ⇧⇥ Remove filter   ↵ Open   esc Close                           ║
        ╚══════════════════════════════════════════════════════════════════╝
```

### 6.5 Loading (first query only — later queries keep prior rows)

```
        ╔══════════════════════════════════════════════════════════════════╗
        ║  ⌕  invoi                                                        ║
        ╟──────────────────────────────────────────────────────────────────╢
        ║    ▭▭▭▭▭▭▭▭▭▭▭▭▭▭▭▭▭▭▭▭        ▭▭▭▭▭▭▭▭                          ║
        ║    ▭▭▭▭▭▭▭▭▭▭▭▭▭▭              ▭▭▭▭▭▭                            ║
        ║    ▭▭▭▭▭▭▭▭▭▭▭▭▭▭▭▭▭▭          ▭▭▭▭▭▭▭▭▭                         ║
        ║                                                                  ║
        ║                      Searching…                                  ║
        ╚══════════════════════════════════════════════════════════════════╝
```

### 6.6 Query too short (S-9)

```
        ║  ⌕  i                                                            ║
        ╟──────────────────────────────────────────────────────────────────╢
        ║  RECENT                                                          ║
        ║    ◈  Q3 partner outreach            Mission · active            ║
        ╟──────────────────────────────────────────────────────────────────╢
        ║  Keep typing — 2 characters minimum.                             ║
```

### 6.7 No results (S-10)

```
        ║  ⌕  zzzqqq                                                       ║
        ╟──────────────────────────────────────────────────────────────────╢
        ║                                                                  ║
        ║              No matches for “zzzqqq”                             ║
        ║        Try a shorter word, or one of these:                      ║
        ║                                                                  ║
        ║  ▸ ✧  Ask the AI chat panel about “zzzqqq”                       ║
        ║    ＋ Create a Mission from “zzzqqq”                             ║
        ║    ?  Open Help                                                  ║
        ╚══════════════════════════════════════════════════════════════════╝
```

### 6.8 Partial failure (S-11), timeout (S-12), offline (S-13), throttled (FR-35)

```
        ║  … healthy groups render exactly as in §6.3 …                    ║
        ╟──────────────────────────────────────────────────────────────────╢
        ║  ⚠  Some results couldn't be loaded. Showing what we have.       ║
        ╚══════════════════════════════════════════════════════════════════╝

        ║  … previous results, dimmed to 50% …                             ║
        ╟──────────────────────────────────────────────────────────────────╢
        ║  ⚠  Search took too long. Press Enter to try again.              ║
        ╚══════════════════════════════════════════════════════════════════╝

        ║  RECENT  (local)                                                 ║
        ╟──────────────────────────────────────────────────────────────────╢
        ║  ⚠  You're offline. Showing recent items only.                   ║
        ╚══════════════════════════════════════════════════════════════════╝

        ╟──────────────────────────────────────────────────────────────────╢
        ║  ⚠  Too many searches. Try again in a moment.                    ║
        ╚══════════════════════════════════════════════════════════════════╝
```

### 6.9 Disabled command (S-15) and confirmation (S-20)

```
        ║  COMMANDS                                                        ║
        ║    ⏸  Pause Agent…                       Needs owner access      ║  ← dimmed, skipped
        ╚══════════════════════════════════════════════════════════════════╝

        ╔══════════════════════════════════════════════════════════════════╗
        ║  ⌕  pause ivy                                                    ║
        ╟──────────────────────────────────────────────────────────────────╢
        ║                                                                  ║
        ║   Pause Ivy?                                                     ║
        ║   It will stop picking up work until you resume it.              ║
        ║                                                                  ║
        ║                                   [ Cancel ]   [ ▸ Pause ]       ║
        ╟──────────────────────────────────────────────────────────────────╢
        ║  esc Cancel   ↵ Confirm                                          ║
        ╚══════════════════════════════════════════════════════════════════╝
```

### 6.10 Mobile (< 768 px)

```
        ┌────────────────────────────┐
        │ ‹  ⌕ invoice          ✕    │
        ├────────────────────────────┤
        │ MISSIONS                   │
        │  ◈ Invoice reconciliation  │
        │    active · 2m             │
        │  ◈ Q3 invoicing cleanup    │
        │    paused · 4d             │
        ├────────────────────────────┤
        │ TASKS                  137 │
        │  ▤ TASK-418 Invoice foll…  │
        │    in review · Ivy         │
        │  ⋯ Show all 137            │
        └────────────────────────────┘
```

### 6.11 Exact user-visible copy

| Where | Copy |
| --- | --- |
| Top-bar trigger | `Search…` |
| Trigger hint (mac / other) | `⌘K` / `Ctrl K` |
| Input placeholder | `Search or type a command…` |
| Dialog accessible name | `Search and commands` |
| Group headers | `Recent`, `Suggested`, `Commands`, `Screens`, `Missions`, `Tasks`, `Agents`, `Works`, `Ideas`, `Skills`, `Teams`, `Knowledge`, `Runs`, `My Decisions`, `Memory`, `Goals`, `Meetings`, `Computers`, `Connections` |
| Overflow row | `Show all {count}` |
| Filtered header | `{group} · showing {shown} of {total}` |
| Escape hatch under a filter | `Open the {group} screen for the full list` |
| Loading | `Searching…` |
| Too short | `Keep typing — 2 characters minimum.` |
| No results title | `No matches for “{query}”` |
| No results hint | `Try a shorter word, or one of these:` |
| No results fallbacks | `Ask the AI chat panel about “{query}”` · `Create a Mission from “{query}”` · `Open Help` |
| Partial failure | `Some results couldn't be loaded. Showing what we have.` |
| Timeout | `Search took too long. Press Enter to try again.` |
| Offline | `You're offline. Showing recent items only.` |
| Throttled | `Too many searches. Try again in a moment.` |
| Missing target toast | `That {kind} no longer exists. It's been removed from Recent.` |
| Disabled command note | `Needs owner access` |
| Confirm title / body | `Pause {name}?` / `It will stop picking up work until you resume it.` |
| Confirm buttons | `Cancel` · `Pause` |
| Footer hints | `↑↓ Navigate` · `↵ Open` · `⌘↵ New tab` · `⇥ Filter group` · `⇧⇥ Remove filter` · `esc Close` |
| Screen-reader announcement | `{count} results` |
| Clipboard toast | `Link copied` |

### 6.12 Help drawer

The Help drawer's Shortcuts tab today lists exactly three shortcuts and describes `Ctrl/Cmd+K`
as "Search works". It is updated to describe the real set — palette open, `/`, navigation keys,
filter keys, `?`, and `C` — without removing the `C` binding or renaming any key. `Open Help`
and `Keyboard shortcuts` become palette commands so the drawer is reachable by typing `help`
(S-4), which is the entry point [AW-25](../README.md#3-epics) builds on.

## 7. Out of scope

1. **Removing or replacing the sidebar.** The sidebar is untouched; the palette is additive.
2. **Removing the Work switcher.** It stays; `Switch Work →` mirrors it, it does not replace it.
3. **Consolidating the two Knowledge-Base palettes.** Two implementations of a Work-scoped KB
   palette exist. Deduplicating them is a separate cleanup; this epic neither uses nor changes
   them, and FR-7 defines how they coexist.
4. **Removing per-page filter inputs.** Every list screen keeps its own filter. The palette is
   a way *in*, not a replacement for filtering inside a screen.
5. **Semantic / embedding search.** Ranking is lexical and deterministic (FR-14). Meaning-based
   retrieval over Knowledge documents already exists as its own capability and is not merged in.
6. **Searching item content inside a Work.** A Work's generated items are content in the user's
   own repositories, not platform records (Constitution III). The palette finds the Work; the
   Work's own screens search its items.
7. **Searching message bodies** — chat transcripts, run logs, email bodies. Titles and summaries
   only. Full-text over conversations belongs to [AW-12](../README.md#3-epics).
8. **Cross-Organization search.** Results never span the active scope (FR-32, S-16). A "search
   everywhere" mode is deliberately not offered.
9. **Query history / saved searches.** Recent tracks *opened records*, not typed queries. Queries
   are never persisted (FR-36).
10. **Command palette outside the authenticated dashboard.** Not on marketing pages, auth pages,
    the onboarding wizard, or generated Work sites.
11. **Natural-language commands.** "Pause everything that's failing" is an AI-chat request, not
    a palette command. The palette matches labels and aliases only.

## 8. Acceptance criteria

**Opening and closing**

- [ ] `Ctrl+K` and `Cmd+K` open the palette from Home, a Mission detail, a Work sub-page, and
      Settings, and while focus is inside the AI chat composer, with no character inserted.
- [ ] `/` opens the palette when focus is outside a text field, and types a slash when inside one.
- [ ] The top-bar trigger opens the same palette; the sidebar and Work switcher are unchanged.
- [ ] `Esc`, an outside click, and a route change all close it; focus returns to the previously
      focused element in all three cases.

**Searching**

- [ ] One character issues no request; two characters issue exactly one request after 150 ms.
- [ ] Typing 12 characters quickly issues exactly one request and no stale response renders.
- [ ] An exact-name match ranks above a prefix match, which ranks above a substring match,
      which ranks above a fuzzy match, for a fixture set covering all four.
- [ ] Every P1 kind in FR-18 returns at least one row for a seeded fixture.
- [ ] No group renders more than 5 rows without a "Show all {n}" row; no group exceeds 25 rows
      under a filter; no response exceeds 60 rows.

**Commands**

- [ ] All 8 command families in FR-22 appear, are findable by at least two aliases each, and act.
- [ ] `help` surfaces `Open Help` and opens the drawer without navigating.
- [ ] `Copy link to this page` places the current absolute URL on the clipboard and toasts.
- [ ] A P3 state-changing command shows the inline confirmation and does nothing on `Esc`.

**Recent**

- [ ] Opening a record from the palette puts it at the top of Recent; re-opening it does not
      duplicate it; the list never exceeds 12; the empty state shows 5.
- [ ] Activating a Recent row whose target was deleted removes the row, toasts, and leaves the
      user where they were.

**Permissions and scope**

- [ ] A user in Organization A gets zero rows for a record that exists only in Organization B,
      and gets it after switching scope.
- [ ] A Knowledge document in a Work the caller is not a member of never appears.
- [ ] Every returned destination is openable by the caller — an automated check opens every row
      of a fixture result set and gets no 403/404.
- [ ] No response field, log line or analytics event contains a secret-bearing value, and none
      contains the raw query string.
- [ ] The 121st request inside 60 s is throttled and the palette shows the throttled copy.

**Resilience**

- [ ] With one source forced to fail, the other groups still render and the partial-failure
      footer appears.
- [ ] With the server held past 3.5 s, prior results stay visible, dimmed, with the timeout copy,
      and `Enter` retries instead of opening.
- [ ] With the browser offline, no request is attempted and the offline copy appears.

**Index (P2)**

- [ ] Creating, renaming and deleting a record is reflected in results within 60 s.
- [ ] A deleted record is never returned, before or after the sweep.
- [ ] With the index emptied, results still return via the fallback path and the endpoint stays
      under 600 ms.

**Accessibility and i18n**

- [ ] The overlay traps focus, is announced as a modal dialog, and exposes the combobox/listbox
      relationship with an active-descendant.
- [ ] Result count is announced once per settled result set, not per keystroke.
- [ ] An automated accessibility audit reports no serious or critical violations on the open
      palette in both themes.
- [ ] Every string comes from a translation key; there are no literals in the component tree.
- [ ] At 375 px the palette is full-screen and every row is at least 44 px tall.

## 9. Open questions

- **[NEEDS CLARIFICATION: `/` as a second open key.]** `/` is fast and conventional, but it is
  also a character people type. FR-2 guards it behind "focus is not in a text field". Do we ship
  it in P1, or hold it until we have telemetry on mis-fires?
- **[NEEDS CLARIFICATION: Should Runs be searchable at all?]** A Run's most useful handle is
  "the run at 09:14 yesterday", which is a time query, not a name query. Runs may belong in
  [AW-09](../README.md#3-epics)'s calendar navigation rather than here. Included in P2 as a
  proposal, not a commitment.
- **[NEEDS CLARIFICATION: Recent scope key.]** Should Recent be keyed per Organization
  (a Mission you opened in Organization A never shows while Organization B is active) or per
  user across scopes with the inaccessible entries filtered at render time? FR-27 assumes
  per-scope; per-user is cheaper but leaks the existence of names across scopes at render time
  unless carefully filtered.
- **[NEEDS CLARIFICATION: How many Screens entries is too many?]** The Screens registry as
  specified in FR-20 covers every settings and Work sub-page, which is roughly 70 entries. Do
  Work sub-pages belong in the global registry at all, or only once a Work is in context?
- **[NEEDS CLARIFICATION: Diacritic folding.]** FR-12 promises diacritic-insensitive matching
  for Latin scripts. The portable matching mechanism this platform uses today does not fold
  diacritics on every supported database. Do we fold in the application layer at index time
  (cheap, P2-only) and accept exact-diacritic matching in P1?
- **[NEEDS CLARIFICATION: Result staleness on the P2 index.]** FR-14 boosts recently changed
  records using the index's stored timestamp. If a record's title changed 3 seconds ago and the
  index has not caught up, the palette shows the old title. Is showing the stale title
  acceptable (current position), or should a match re-read the source row before rendering?
- **[NEEDS CLARIFICATION: Should the palette be reachable from the generated Work sites?]**
  Out of scope today (§7.10), but operators editing a Work often have the site open. Revisit
  after [AW-19](../README.md#3-epics).
