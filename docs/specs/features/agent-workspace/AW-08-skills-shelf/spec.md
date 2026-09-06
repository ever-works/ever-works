# Feature Specification: Skills shelf

> Behaviour-first spec per [Constitution Principle IX](../../../../../.specify/memory/constitution.md#ix-specs-are-behaviour-first).
> Describes **what** the system does for the user. Implementation lives in [`plan.md`](./plan.md).

**Feature ID**: `AW-08-skills-shelf`
**Program**: [Agent Workspace](../README.md) — Wave 2
**Branch**: `feat/aw-08-skills-shelf`
**Status**: `Draft`
**Created**: 2026-09-06
**Last updated**: 2026-09-06
**Owner**: Product
**Size**: M · **Depends on**: — · **Depended on by**: AW-21 (capability catalogue)

> **Additive-only (program rule #1).** Nothing here removes, renames or consolidates an
> existing surface. The Skills catalogue keeps living where navigation consolidation put it
> (a block on the Agents page, anchored `#skills`), the `Installed / Available / Custom`
> sections keep their names, `/skills/new`, `/skills/templates` and `/skills/[id]` keep their
> routes and their behaviour, and every existing Skill keeps working with zero user action.
> Bindings keep meaning exactly what they mean today. Everything below is new surface bolted
> onto what already ships.

---

## 1. Overview

A workspace owner gets one place to see every capability their agents can reach, and to tell
at a glance which of those capabilities actually work. The **Skills shelf** lists every Skill
installed in the workspace as a card carrying its title, its one-line "use this when…"
description, its tags, and — the part that changes the product — a **readiness badge** that
says whether the Skill will really be picked up on the next run. A Skill that reaches no agent
says so. A Skill whose declared tools need a credential or a connection nobody has set up
**names the exact missing item** rather than saying "something is wrong". Each badge carries a
repair path that is either one click (the platform fixes it) or one click plus a name (an
agent is asked to fix it, and the request becomes a Task you can watch). The shelf can be
searched, filtered by tag and by readiness, sorted, and every Skill can be switched off and
back on with a single toggle that is reversible and does not touch its bindings. Finally,
when a run has just done something well, the run's own page offers **"Save this as a Skill"**:
an agent drafts the capability from what it just did — the steps, and the edge cases it hit —
and the draft lands on the shelf marked for review, never live until a human accepts it.

## 2. Why now

### 2.1 The user's question

> *"What can my agents actually do — and which of the things I set up are quietly not
> working?"*

and, ten seconds after a run goes well:

> *"That worked. How do I make sure it happens the same way next time without me explaining
> it again?"*

### 2.2 What they do today instead

| The need | What Ever Works offers today | What the user actually does |
| --- | --- | --- |
| Browse what the agents can do | The Skills block on the Agents page lists installed Skills as cards showing title, description, owner type, version, slug and `/invocation` — and nothing about whether they work. | Opens each Skill in turn and guesses. |
| Filter by tag | Catalogue entries carry `tags`, and the first-party Skill definitions document those tags as the thing that "drives the Skills page filters". **No tag filter exists on any surface.** Tags are stored inside a Skill's frontmatter blob, so nothing can even query them. | Uses free-text search and hopes the tag word appears in the title. |
| Switch one Skill off | There is no off switch on a Skill. The closest thing is a per-binding "inject into agent" flag, buried on the Skill detail page, one row per binding. Turning a Skill off across a workspace means editing every binding it has. | Deletes the Skill, then reinstalls it later. |
| Know a Skill is reaching an agent | Nothing. A Skill created from `/skills/new` has **zero bindings** the moment it is created, so it is resolved by nothing, injected into nothing, and looks completely healthy on the shelf. | Discovers it months later, if ever. |
| Know a Skill is being suppressed | A Skill that declares tools the workspace's access rules refuse is dropped from the run at assembly time and a `WARN` line is written into that run's log. No surface reads it. | Nothing — the Skill silently stops working and nobody is told. |
| Know a Skill's dependencies are unmet | Nothing. Credential requirements are resolved at the moment a tool is invoked, mid-run, and a missing one becomes a refusal inside an autonomous run that has already spent tokens and may already have made half a change. | Reads the run transcript afterwards. |
| Turn a good run into a reusable capability | Write the Skill by hand: `/skills/new` → title → a Markdown textarea → then create a binding on the detail page in a second, separate step. | Doesn't. Re-explains the same procedure in the next task description. |

### 2.3 The three gaps, all of them ours

1. **A Skill can be completely inert and look perfectly fine.** We already have three distinct
   ways for a Skill to never reach a run — no binding at all, every binding muted, or the
   workspace's access rules refusing every tool it declares. We detect all three. We surface
   none of them. The one place a suppression is recorded is a `WARN` line inside a single run's
   log, which is the one place a person browsing capabilities will never look.

2. **Dependency failure is discovered at the worst possible moment.** Our own credential port
   is deliberately built to report *which keys it could not supply* rather than returning
   blanks — the information needed to say "this needs an API key nobody has set" exists, in the
   right shape, and is currently only consulted after a run has started and a tool is being
   called. Moving that check left, onto a card, converts a mid-run failure into a setup chore.

3. **Capture is a form, and forms do not get filled in.** The agent that just completed a
   procedure holds the whole transcript, including the two things that went wrong and how it
   recovered. We ask the human — who only supervised — to retype it into a Markdown box, and
   then, in a second unrelated step, to attach it to something. Nobody does this twice.

### 2.4 What this epic changes

```
   BEFORE                                        AFTER
   ──────                                        ─────
   Agents ▸ Skills                               Agents ▸ Skills  (the shelf)
   ┌──────────────────────────────┐              ┌───────────────────────────────────────┐
   │ [Installed][Available][Custom]│             │ [Installed][Available][Custom]        │
   │ search ▸ title/slug/desc      │             │ search ▸ title/slug/desc/tag          │
   │                               │             │ tags: (billing)(email)(+9)  ▾readiness│
   │ ┌───────┐ ┌───────┐ ┌───────┐ │             │ ┌─────────────┐ ┌─────────────┐       │
   │ │ title │ │ title │ │ title │ │             │ │ title   [ON]│ │ title  [OFF]│  …    │
   │ │ desc  │ │ desc  │ │ desc  │ │             │ │ desc        │ │ desc        │       │
   │ │ tenant│ │ agent │ │ work  │ │             │ │ ⚠ Needs 1   │ │ Switched off│       │
   │ │ v1.0.0│ │ v1.0.0│ │ v1.0.0│ │             │ │   thing     │ │             │       │
   │ └───────┘ └───────┘ └───────┘ │             │ └─────────────┘ └─────────────┘       │
   └──────────────────────────────┘              └───────────────────────────────────────┘
        every card looks healthy                    a card tells you what needs you,
        whether or not it works                     and hands you the one click that fixes it

   Run finished ──► (nothing)                    Run finished ──► "Save this as a Skill"
                                                        │
                                                        ▼
                                                  agent drafts it from the run
                                                        │
                                                        ▼
                                                  shelf card marked  Needs your review
                                                        │  Accept
                                                        ▼
                                                  live, bound, reaching agents
```

## 3. User scenarios

### 3.1 Primary

- **S1 — See what works.**
  **Given** a workspace with 34 installed Skills, four of which cannot reach any agent and two
  of which declare a tool whose credential is unset,
  **when** the owner opens Agents ▸ Skills,
  **then** the shelf renders 34 cards, six of them carry a readiness badge, the summary line
  above the grid reads **"6 of 34 Skills need you"**, and clicking that line filters the shelf
  to exactly those six.

- **S2 — Filter by tag.**
  **Given** the shelf is showing all Skills,
  **when** the owner clicks the tag chip **`billing`**,
  **then** the grid narrows to the Skills tagged `billing`, the chip renders selected, the URL
  carries the tag so the view can be shared or bookmarked, and a **Clear** control appears next
  to the chip row.

- **S3 — Read exactly what a Skill does.**
  **Given** a Skill card,
  **when** the owner clicks it,
  **then** the Skill detail page opens showing, above the instructions, a **Readiness** panel
  (what state it is in and why), a **Requirements** list (every tool and credential the Skill
  declares, each marked met or missing), and below them the full instruction body rendered as
  formatted text — no truncation, no "click to expand", the whole definition is readable.

- **S4 — Switch a Skill off, then back on.**
  **Given** a Skill that is producing bad output,
  **when** the owner flips its card toggle to off,
  **then** the card immediately shows the **Switched off** state with the helper line
  **"Off. Nothing else changed — flip it back on any time."**, the Skill stops being injected
  into every run started from that moment, its bindings are left exactly as they were, and
  flipping the toggle back on restores the previous behaviour with no further steps.

- **S5 — A Skill that reaches nobody, fixed in one click.**
  **Given** a Skill created from `/skills/new` that has no bindings,
  **when** the owner opens the shelf,
  **then** its card reads **"Not reaching any agent"**, and the card's primary action
  **Attach to…** opens a picker of the workspace's agents; choosing one creates the binding,
  the badge clears within the same interaction, and the card shows **"Reaching 1 agent"**.

- **S6 — Missing requirement, named exactly.**
  **Given** a Skill whose declared tools include one served by a connection nobody has set up,
  **when** the owner reads its card,
  **then** the badge reads **"Missing 1 requirement"** and the card lists the missing item by
  its own name — for example **"Connection: `billing-api` (not connected)"** or
  **"Credential: `stripe_key` (not set)"** — never a generic "a dependency is missing", and
  never the value of anything.

- **S7 — Ask an agent to repair it.**
  **Given** a Skill badged **Missing 2 requirements**,
  **when** the owner clicks **Ask an agent to fix this** and picks the agent Wren,
  **then** a Task titled **"Fix requirements for Skill: <title>"** is created, assigned to
  Wren, its description enumerates the two missing items verbatim, a Run starts, the dialog
  closes onto a confirmation reading **"Wren is on it."** with a link to the Task, and the
  card switches to the **Repair in progress** state until the run ends.

- **S8 — Capture a Skill from a run that just worked.**
  **Given** a completed run whose result the owner is happy with,
  **when** they click **Save this as a Skill** on the run page, choose the scope, and confirm,
  **then** the dialog closes on **"Drafting — this takes about a minute."**, an agent reads the
  run and drafts a Skill with a title, a "use this when…" description, numbered steps and a
  separate **Edge cases** section, and the draft appears on the shelf badged
  **Needs your review**.

- **S9 — Accept the draft.**
  **Given** a Skill badged **Needs your review**,
  **when** the owner opens it, reads the drafted body, edits two lines, and clicks **Accept**,
  **then** the review badge clears, the Skill becomes injectable, and if it has no binding yet
  the accept dialog offers the same **Attach to…** picker inline so the Skill is live in one
  pass rather than two.

### 3.2 Unhappy paths

- **S10 — Search returns nothing.**
  **Given** the shelf with a `refund` search and the `email` tag both active,
  **when** no Skill matches,
  **then** the grid is replaced by **"No Skills match `refund` in `email`."** plus a
  **Clear filters** button, and the tag chip row stays visible and interactive so the filter can
  be narrowed rather than restarted.

- **S11 — The workspace has no Skills at all.**
  **Given** a brand-new workspace,
  **when** the owner opens the shelf,
  **then** the grid is replaced by **"No Skills yet."** / **"Skills are how one good run
  becomes something your agents can repeat. Install one from the catalogue, write one, or
  finish a run and save it."**, with three buttons — **Browse catalogue**, **New Skill**, and a
  disabled-with-tooltip **Save from a run** that explains it lights up after the first
  completed run.

- **S12 — Readiness cannot be computed.**
  **Given** the check that decides a Skill's badge fails (the access rules cannot be resolved,
  or a connection's health is unknown),
  **when** the shelf renders,
  **then** those cards show **"Couldn't check"** with a **Re-check** action — never a false
  **Ready**, and never a false **Missing requirement**. Ambiguity is reported as ambiguity.

- **S13 — Two people toggle the same Skill.**
  **Given** two members of the same workspace with the shelf open,
  **when** both flip the same Skill's toggle within a second of each other,
  **then** the last write wins, both clients converge on the same state on their next read,
  and neither sees an error dialog. The toggle is idempotent: switching an already-off Skill
  off is a no-op that returns success.

- **S14 — Repair is asked for twice.**
  **Given** a repair Task already open for a Skill,
  **when** the owner clicks **Ask an agent to fix this** again,
  **then** no second Task is created; the dialog instead shows **"Wren is already fixing this
  — opened 4 minutes ago"** with a link to the existing Task and a **Cancel that and start
  over** secondary action.

- **S15 — The user cannot repair it themselves.**
  **Given** a Skill whose requirement is a workspace-level connection the current member is not
  allowed to configure,
  **when** they open its repair panel,
  **then** the **Fix it here** action is disabled with the reason
  **"Only a workspace owner can connect this."**, the **Ask an agent** action stays enabled,
  and the missing item is still named in full so the person can go ask for it by name.

- **S16 — Capture from a failed run.**
  **Given** a run that ended `failed` or `cancelled`,
  **when** the owner opens it,
  **then** **Save this as a Skill** is present but disabled, with the tooltip **"Save a Skill
  from a run that finished cleanly — this one didn't."**

- **S17 — Capture produces nothing usable.**
  **Given** a completed run with three log lines and no tool calls,
  **when** the owner asks to save it as a Skill,
  **then** the drafting job finishes without creating a Skill and the run page shows
  **"There wasn't enough in this run to make a Skill. Try one where the agent actually did the
  work end to end."** — no empty Skill is created and no card appears on the shelf.

- **S18 — Someone else's Skill.**
  **Given** a Skill id belonging to another workspace,
  **when** it is requested by id, toggled, repaired, or accepted,
  **then** the response is **not found** in every case — the same answer as for an id that does
  not exist, so no membership can be inferred from the difference.

- **S19 — Too many tags to show.**
  **Given** a workspace whose Skills carry 140 distinct tags,
  **when** the shelf renders the chip row,
  **then** the 12 most-used tags render as chips, followed by **"+128 more"** which opens a
  searchable tag list; the chip row never wraps past two lines and never becomes the tallest
  thing on the page.

- **S20 — Disabling a Skill mid-run.**
  **Given** a run that is already executing with the Skill in its assembled context,
  **when** the owner switches that Skill off,
  **then** the in-flight run is **not** interrupted and continues with the context it was
  admitted with; every run started after the toggle omits the Skill. The toggle's helper text
  says so: **"Takes effect on the next run."**

### 3.3 Race and permission edges

- **S21 — Requirement becomes met while the shelf is open.**
  **Given** a card badged **Missing 1 requirement** because a connection was absent,
  **when** the owner connects it in another tab and returns,
  **then** pressing **Re-check** on the card clears the badge without a page reload, and the
  hourly background check would have cleared it within the hour regardless.

- **S22 — A Skill is deleted while a repair Task is open.**
  **Given** an open repair Task for a Skill,
  **when** the Skill is deleted,
  **then** the Task is left in place (it is a record of work asked for) but its description
  gains a line reading **"This Skill was deleted on <date>."**, and the run, if still going,
  ends cleanly rather than erroring on a missing row.

- **S23 — Capture races a second capture.**
  **Given** a drafting job already running for a run,
  **when** the owner clicks **Save this as a Skill** again for the same run,
  **then** the second request returns the *same* draft id rather than starting a second job,
  and the button reads **Drafting…** and is disabled while the first job runs.

---

## 4. Functional requirements

Every threshold below is a number on purpose. "Reasonable", "recent" and "large" are not
acceptance criteria.

### 4.1 The shelf: listing, search, sort, paging

- **FR-1.** The shelf lists every Skill in the active workspace scope that the current member
  can read, as cards, 50 per page, ordered by the active sort.
- **FR-2.** Sort options are **Recently updated** (default, newest first), **Name (A–Z)**, and
  **Needs attention first** (Skills carrying a readiness badge, then the rest, each group by
  recently updated). The active sort is carried in the URL.
- **FR-3.** Search matches, case-insensitively, on title, slug, description **and tag**. The
  minimum query length is 2 characters; a 1-character query is ignored and the grid is left
  unfiltered. Input is debounced 300 ms before the query is issued.
- **FR-4.** Search, tag filter, readiness filter, sort and page are all reflected in the URL as
  query parameters, so a filtered shelf can be linked and bookmarked. Unknown parameters are
  dropped rather than forwarded.
- **FR-5.** The summary line above the grid reads **"{n} of {total} Skills need you"** whenever
  `n > 0`, and is itself the control that applies the "needs attention" readiness filter.
  When `n = 0` it reads **"All {total} Skills are ready."**
- **FR-6.** Empty states are distinct and never interchangeable: **no Skills at all**,
  **no results for the current filters**, and **no results on this page** (a page offset past
  the end) each have their own copy and their own recovery action.
- **FR-7.** If the installed list fails to load, the shelf renders an error banner and keeps
  the catalogue section usable; if the catalogue fails to load, the installed shelf stays
  usable. Neither failure blanks the page.
- **FR-8.** The shelf renders its first paint from server-fetched data. Readiness badges are
  part of that first paint — they must not arrive in a second wave that reflows the grid.

### 4.2 Tags

- **FR-9.** A Skill's tags come from its definition. Tags are normalised on write: trimmed,
  lower-cased, spaces collapsed to single hyphens, limited to letters, digits and hyphens.
- **FR-10.** A tag is at most **40 characters**. A Skill carries at most **12 tags**; tags past
  the twelfth are dropped on write and the drop is reported in the response.
- **FR-11.** The chip row shows the **12** most-used tags in the current scope, each with its
  count, ordered by count descending then alphabetically. Remaining tags are reachable through
  a **"+{n} more"** control that opens a searchable list.
- **FR-12.** Selecting multiple tag chips narrows the result to Skills carrying **all** selected
  tags (AND, not OR). At most **6** tags can be selected at once; the seventh chip is disabled
  with the tooltip **"Six tags is the limit for one filter."**
- **FR-13.** The tag facet list returns at most **200** distinct tags per request.
- **FR-14.** Editing a Skill's definition re-derives its tags in the same write. There is no
  separate "save tags" action and no way for a Skill's stored tags to disagree with its
  definition.

### 4.3 Enable and disable

- **FR-15.** Every Skill has one workspace-level on/off switch, independent of its bindings.
- **FR-16.** Switching a Skill off excludes it from every run assembled from that moment on,
  for every agent, at every scope, regardless of how many bindings it has or what those
  bindings' per-target injection flags say.
- **FR-17.** Switching a Skill off **never** modifies, deletes or reorders its bindings.
  Switching it back on restores exactly the previous behaviour.
- **FR-18.** Both operations are idempotent: switching off an already-off Skill succeeds and
  changes nothing.
- **FR-19.** A run that has already begun assembling or executing keeps the context it was
  admitted with. The switch takes effect on the next run and the UI says so.
- **FR-20.** Each transition is recorded in the workspace activity record with the actor, the
  Skill and the direction. The record never contains the Skill body.

### 4.4 Readiness and badges

- **FR-21.** Every Skill carries exactly one readiness state, from this closed set:
  | State | Card badge | Meaning |
  | --- | --- | --- |
  | `ready` | *(no badge)* | It will be picked up on the next matching run. |
  | `needs_setup` | **Not reaching any agent** | It has no binding, or every binding it has is muted. |
  | `missing_requirements` | **Missing {n} requirement(s)** | It declares a tool or credential whose backing is not connected/set. |
  | `blocked_by_access` | **Blocked by your access rules** | Every tool it declares is refused by the workspace's access rules. Nothing is missing; permission is withheld. |
  | `needs_review` | **Needs your review** | It was drafted from a run and has not been accepted. |
  | `disabled` | **Switched off** | A person turned it off. |
  | `unknown` | **Couldn't check** | The check itself could not complete. |
- **FR-22.** `disabled` and `needs_review` take precedence over every other state, in that
  order. Below them, the order of precedence is `needs_setup` → `missing_requirements` →
  `blocked_by_access` → `unknown` → `ready`. A card shows exactly one readiness badge.
- **FR-23.** Provenance is a **separate** chip from readiness and may appear alongside it. The
  provenance chips are **First-party** (installed from the catalogue Ever Works maintains),
  **From a plugin** (installed from a third-party catalogue provider), **From a package**
  (supplied by an installed agent package) and **Yours** (written in this workspace). Every
  Skill carries exactly one.
- **FR-24.** `missing_requirements` **enumerates**. The card and the detail panel list every
  unmet requirement by its own identifier and kind — `Tool`, `Credential`, `Connection`,
  `Plugin setting` — with a short reason. A summary such as "some requirements are missing" is
  a defect.
- **FR-25.** A requirement's **value** is never displayed, logged, or returned by any endpoint.
  Only the identifier (the key name, the connection name, the setting name) and whether it
  resolved.
- **FR-26.** Readiness is computed from the Skill's declared tools plus what the workspace can
  currently reach. It is **cached** and re-computed: (a) on demand when a person presses
  **Re-check**, (b) whenever the Skill itself is written, and (c) by a background sweep for any
  Skill whose cached verdict is older than **60 minutes**.
- **FR-27.** The background sweep processes at most **500** Skills per tick and at most **200**
  per workspace per tick, oldest cached verdict first, and never blocks a user-facing request.
- **FR-28.** On-demand re-check is rate-limited to **30 requests per minute** per member and
  completes within **3 seconds** or returns the previous cached verdict with the
  **Couldn't check** state.
- **FR-29.** The readiness check performs **no outbound network calls**. It reads the
  workspace's own stored connection health, its access rules, and asks the credential resolver
  which of the declared keys it can supply. A remote service being slow can never make the
  shelf slow.
- **FR-30.** A Skill that declares no tools is `ready` unless another state applies. Declaring
  nothing is not a fault.
- **FR-31.** A Skill that declares several tools and keeps at least one usable is **not**
  badged `blocked_by_access`. Partial capability is capability.
- **FR-32.** When a run drops a Skill for any of these reasons, the drop is recorded against
  that run **and** reflected in the Skill's cached readiness within the same operation, so a
  suppression discovered at run time cannot stay invisible on the shelf.

### 4.5 Repair

- **FR-33.** Every badge except `ready` offers at least one repair path. `ready` offers none.
- **FR-34.** **Fix it here** is offered whenever the platform can complete the repair itself
  without judgement:
  | State | What "Fix it here" does |
  | --- | --- |
  | `needs_setup` (no binding) | Opens the **Attach to…** picker and creates the binding on confirm. |
  | `needs_setup` (all bindings muted) | Un-mutes them, after showing which ones. |
  | `disabled` | Switches the Skill back on. |
  | `needs_review` | Opens the review view. |
  | `missing_requirements` | Deep-links to the exact settings row for each missing item, one link per item. |
  | `blocked_by_access` | Deep-links to the access rules for the agent in question. |
  | `unknown` | Re-runs the check. |
- **FR-35.** **Ask an agent to fix this** is offered for `needs_setup`,
  `missing_requirements`, `blocked_by_access` and `unknown`. It requires choosing an agent; the
  button label renders the chosen agent's name (**"Ask Wren to fix this"**).
- **FR-36.** Asking an agent creates one **Task**, assigned to that agent, titled
  **"Fix requirements for Skill: {title}"**, whose description enumerates every unmet
  requirement, and starts a **Run** for it. The endpoint returns within 2 seconds and does not
  wait for the run.
- **FR-37.** At most **one** open repair Task exists per Skill at a time. A second request
  returns the existing Task rather than creating another, and the UI says who is already on it
  and when it was opened.
- **FR-38.** While a repair Task is open, the card shows **Repair in progress** with a link to
  the Task, replacing the repair actions.
- **FR-39.** Delegated repair is rate-limited to **10 requests per minute** per member.
- **FR-40.** If the current member lacks the permission a **Fix it here** action needs, the
  action renders disabled with the specific reason, the missing item stays fully named, and
  **Ask an agent** stays available.

### 4.6 Capture from a run

- **FR-41.** A run's page offers **Save this as a Skill** when, and only when, the run finished
  with status `completed`. For any other status the action is present but disabled, with a
  tooltip stating why.
- **FR-42.** Confirming opens a small form with: the scope to attach the new Skill to
  (defaulting to the agent that performed the run), an optional title override, and an optional
  one-line note telling the drafting agent what to emphasise. Nothing else is required.
- **FR-43.** The request returns within 2 seconds with a draft id and a `drafting` state. The
  drafting itself runs in the background with a budget of **90 seconds**.
- **FR-44.** The drafting agent is instructed to produce, at minimum: a **title**, a
  **"use this when…"** description phrased as a *situation* rather than a capability, **numbered
  steps**, a separate **Edge cases** section covering what went wrong in the run and how it was
  handled, and **up to 6 tags**.
- **FR-45.** A drafted Skill is created with the **Needs your review** state. It is **not**
  injected into any run until a person accepts it. This mirrors how proposed knowledge is
  handled elsewhere in the product: nothing an agent writes becomes live without a human
  accepting it.
- **FR-46.** The drafted body is capped at **16,000 characters**. The existing 64 KB Skill body
  ceiling and the existing secret and control-sequence screening apply unchanged to drafted
  bodies — a draft that trips either is rejected and reported, never stored.
- **FR-47.** If the drafting produces nothing usable — no steps, or a body under 200 characters
  — **no Skill row is created**, and the run page reports it in one sentence.
- **FR-48.** A second capture request for the same run while the first is drafting returns the
  same draft id. After a draft exists for a run, the run page's action reads
  **View the Skill from this run**.
- **FR-49.** Capture is rate-limited to **10 requests per hour** per member.
- **FR-50.** Accepting a draft clears the review state, makes the Skill injectable, and — when
  the Skill has no binding — offers the **Attach to…** picker in the same dialog so the Skill
  becomes live in one pass. Discarding a draft deletes it and says so plainly.

### 4.7 Reading the definition

- **FR-51.** The Skill detail view renders the full instruction body as formatted text with no
  truncation and no expand-to-read interaction.
- **FR-52.** Above the body, the detail view shows a **Readiness** panel (the current state,
  when it was last checked, a **Re-check** control) and a **Requirements** list enumerating
  every declared tool and credential, each marked **met** or **missing** with its reason.
- **FR-53.** The detail view shows provenance in words: where the Skill came from, which
  version, and, for a captured Skill, a link to the run it was drafted from.
- **FR-54.** Companion files attached to a Skill are listed with name, kind and size. Their
  contents are not rendered inline.
- **FR-55.** Every element of the readiness and requirements panels is reachable and operable by
  keyboard, and the state of each badge is announced to assistive technology as text, not
  conveyed by colour alone.
- **FR-56.** The existing Skill detail sections — body editor, bindings, companion files,
  delete — keep their position, their behaviour and their copy. The new panels are added above
  them.

### 4.8 Scope, permissions, limits and observability

- **FR-57.** Every read and write is scoped to the caller's workspace. A Skill belonging to
  another workspace answers **not found** on every verb — never a permission error, which would
  itself leak existence.
- **FR-58.** Reading the shelf requires workspace membership. Toggling, repairing, accepting a
  draft and capturing from a run require the same permission that creating a Skill requires
  today; nothing new is granted and nothing existing is tightened.
- **FR-59.** All list responses are paginated with an explicit total, and no list endpoint
  returns more than 200 rows in one response.
- **FR-60.** Every user-visible string is translatable. No string is assembled from
  concatenated fragments.
- **FR-61.** The product records, without any content: shelf opened (with counts per readiness
  state), tag filter applied, Skill toggled, repair started (with kind and whether delegated),
  repair outcome, capture started, capture outcome. These are counters and identifiers only.
- **FR-62.** Any run in which a Skill is dropped links, from the run's own record, to the Skill
  that was dropped and the reason — so the question "why did it not use that?" is answerable
  from the run as well as from the shelf.

---

## 5. Key entities

### 5.1 Already in Ever Works — extended here

| Entity | Today | This epic adds |
| --- | --- | --- |
| **Skill** | A titled Markdown capability with a description, a definition body, a version, an owner scope, an optional slash invocation, and provenance fields recording which catalogue it came from. | An **off switch**, a **cached readiness verdict** with its enumerated detail and the time it was checked, a **review state** for drafts, and a link to the **Run** a captured Skill came from. |
| **Skill binding** | The row that attaches a Skill to an Agent, Work, Mission, Idea or the workspace, with a priority and per-target injection flags. | Nothing changes. The off switch sits *above* bindings; it does not touch them. |
| **Skill companion file** | A script, reference, asset or config file indexed against a Skill. | Nothing changes; the detail view lists them alongside the new panels. |
| **Agent** | A person-shaped worker. | Becomes the assignee of a repair Task and the author of a captured Skill. |
| **Task** | A step of delegated work with an assignee. | A repair is expressed as an ordinary Task — no new work-item concept is introduced. |
| **Run** | One agent execution, with structured step records. | Becomes the *source* a Skill can be captured from, and the place a suppression is recorded. |
| **Connection / Plugin** | An installed integration and the account behind it. | Read (never written) by the readiness check to decide whether a declared tool's backing exists. |

### 5.2 New

| Entity | Why it must exist | Shape |
| --- | --- | --- |
| **Skill tag** | Tags today live inside a Skill's definition blob. Nothing can filter on them, count them, or list them, which is why the tag filter the first-party Skills were written for has never existed. A tag needs to be a row to be a facet. | One row per (Skill, tag). Derived automatically from the Skill's definition on every write; never edited independently. Not a user-managed taxonomy — there is no "create tag" action, no tag rename, no colour. |

> **No other new noun.** Readiness is an attribute of a Skill, not an entity. A repair is a
> Task. A capture produces a Skill. The draft state is a field on the Skill, using the same
> word (`proposed` → accepted) the product already uses for knowledge an agent wrote.

### 5.3 States and transitions

**Skill readiness** — derived, never hand-set:

```
                       ┌───────────────────────────────────────────┐
                       │  computed on: write · Re-check · hourly    │
                       │  sweep · a run dropping the Skill          │
                       └────────────────────┬──────────────────────┘
                                            ▼
   disabled ◄── person switches off ──  [ any state ]  ── person switches on ──► recompute
       │
       ├── needs_review ──accept──► recompute
       │        └──discard──► (row deleted)
       │
       ├── needs_setup ──────── binding created / un-muted ─────────► recompute
       ├── missing_requirements ─ credential set / connection made ─► recompute
       ├── blocked_by_access ──── access rule widened ──────────────► recompute
       ├── unknown ───────────── check succeeds ────────────────────► recompute
       └── ready  (no badge)
```

**Skill review state** — only for captured Skills:

```
   (capture asked for) ──► drafting ──┬──► proposed ──accept──► accepted (normal Skill)
                                      │        └────discard───► deleted
                                      └──► nothing created (not enough in the run)
```

**Repair** — a Task, using the Task lifecycle the product already has:

```
   badge ──"Ask <Agent> to fix this"──► Task(open, assigned) ──► Run
                                              │                    │
                                              │                    ├─ run succeeds → recompute readiness
                                              │                    └─ run fails    → Task stays open, card
                                              │                                      shows "Repair didn't work"
                                              └─ at most ONE open repair Task per Skill
```

---

## 6. UX

All copy below is final English copy, ready to be keyed for translation.

### 6.1 The shelf — loaded

```
╔══════════════════════════════════════════════════════════════════════════════════╗
║  ✨ Skills                                        [ Browse templates ] [+ New ]   ║
║  Skills your Agents can use — installed, available in the catalogue, and custom  ║
║  ones you wrote.                                                                 ║
╟──────────────────────────────────────────────────────────────────────────────────╢
║  [ Installed ] [ Available ] [ Custom ]                                          ║
║                                                                                  ║
║  ┌────────────────────────────────────────────────┐ [ Search ]  Sort: ▾          ║
║  │ 🔍  Search skills by title, tag or description │            Recently updated  ║
║  └────────────────────────────────────────────────┘                              ║
║                                                                                  ║
║  Tags:  (billing 9) (email 7) (research 6) (refunds 4) (pricing 3)  +128 more    ║
║                                                                                  ║
║  ⚠ 6 of 34 Skills need you.                                    [ Show only these ]║
╟──────────────────────────────────────────────────────────────────────────────────╢
║  ┌──────────────────────────┐ ┌──────────────────────────┐ ┌───────────────────┐ ║
║  │ Refund eligibility check │ │ Rate card lookup     ●ON │ │ Weekly digest ●ON │ ║
║  │                     ●ON  │ │                          │ │                   │ ║
║  │ Use when a customer asks │ │ Use when someone asks    │ │ Use when the week │ ║
║  │ whether an order can     │ │ what we charge for a     │ │ needs summarising │ ║
║  │ still be refunded.       │ │ given plan or region.    │ │ for the owner.    │ ║
║  │                          │ │                          │ │                   │ ║
║  │ #billing #refunds        │ │ #billing #pricing        │ │ #reporting        │ ║
║  │                          │ │                          │ │                   │ ║
║  │ ⚠ Missing 1 requirement  │ │ ⚠ Not reaching any agent │ │  First-party      │ ║
║  │   Credential: stripe_key │ │                          │ │  Reaching 3 agents│ ║
║  │   [ Fix it here ]        │ │   [ Attach to… ]         │ │                   │ ║
║  │   [ Ask an agent ▾ ]     │ │   [ Ask an agent ▾ ]     │ │                   │ ║
║  │                          │ │                          │ │                   │ ║
║  │ Yours · v1.2.0           │ │ First-party · v2.0.1     │ │ Yours · v1.0.0    │ ║
║  └──────────────────────────┘ └──────────────────────────┘ └───────────────────┘ ║
║                                                                                  ║
║                            Showing 1–50 of 34   [ Previous ] [ Next ]            ║
╚══════════════════════════════════════════════════════════════════════════════════╝
```

Exact copy on this surface:

| Element | Copy |
| --- | --- |
| Search placeholder | `Search skills by title, tag or description` |
| Sort label / options | `Sort` · `Recently updated` · `Name (A–Z)` · `Needs attention first` |
| Tag row label | `Tags:` |
| Tag overflow | `+{count} more` |
| Attention summary (n > 0) | `{count} of {total} Skills need you.` |
| Attention summary (n = 0) | `All {total} Skills are ready.` |
| Attention filter button | `Show only these` / when active: `Show all` |
| Toggle, on | `On` — announced as `Skill is on` |
| Toggle, off | `Off` — announced as `Skill is off` |
| Reach line | `Reaching {count, plural, =0 {no agents} =1 {1 agent} other {# agents}}` |
| Pagination | `Showing {start}–{end} of {total}` · `Previous` · `Next` |

### 6.2 Badges — every state, exact copy

```
  ┌────────────────────────────────────────────────────────────────────────────┐
  │  (no badge)          Ready. Nothing is shown; the absence IS the signal.   │
  │                                                                            │
  │  ⚠  Not reaching any agent                                                 │
  │     Nothing is bound to it, so no run will pick it up.                     │
  │     [ Attach to… ]  [ Ask an agent ▾ ]                                     │
  │                                                                            │
  │  ⚠  Missing 2 requirements                                                 │
  │     • Credential: stripe_key — not set                                     │
  │     • Connection: billing-api — not connected                              │
  │     [ Fix it here ]  [ Ask an agent ▾ ]                                    │
  │                                                                            │
  │  ⛔  Blocked by your access rules                                           │
  │     Every tool this Skill uses is refused for this Agent.                  │
  │     [ Review access ]  [ Ask an agent ▾ ]                                  │
  │                                                                            │
  │  ✦  Needs your review                                                      │
  │     Drafted from a run on 3 Sep. It won't be used until you accept it.     │
  │     [ Review it ]                                                          │
  │                                                                            │
  │  ○  Switched off                                                           │
  │     Off. Nothing else changed — flip it back on any time.                  │
  │                                                                            │
  │  ?  Couldn't check                                                         │
  │     We couldn't work out whether this is ready. Last checked 2 hours ago.  │
  │     [ Re-check ]                                                           │
  │                                                                            │
  │  ⟳  Repair in progress                                                     │
  │     Wren is fixing this — opened 4 minutes ago.  [ Open the Task ]         │
  └────────────────────────────────────────────────────────────────────────────┘
```

Provenance chips, rendered next to the version line, never in the badge slot:
`First-party` · `From a plugin` · `From a package` · `Yours`.

### 6.3 The shelf — loading, empty, no-results, over-limit, error

```
LOADING (first paint)                        NO SKILLS AT ALL
┌──────────────────────────────┐             ┌────────────────────────────────────────┐
│ ░░░░░░░░░░░  ░░░░░░  ░░░░░   │             │              No Skills yet.            │
│ ┌────────┐ ┌────────┐ ┌─────┐│             │                                        │
│ │░░░░░░░░│ │░░░░░░░░│ │░░░░░││             │  Skills are how one good run becomes   │
│ │░░░░░   │ │░░░░░   │ │░░░  ││             │  something your agents can repeat.     │
│ │░░░░░░  │ │░░░░░░  │ │░░░░ ││             │  Install one from the catalogue, write │
│ └────────┘ └────────┘ └─────┘│             │  one, or finish a run and save it.     │
│  6 skeleton cards, no shift  │             │                                        │
└──────────────────────────────┘             │ [Browse catalogue] [New Skill]         │
                                             │ [Save from a run]  ← disabled, tooltip:│
                                             │   "Available once a run finishes."     │
                                             └────────────────────────────────────────┘

NO RESULTS FOR THESE FILTERS                 PAGE PAST THE END
┌────────────────────────────────────────┐   ┌────────────────────────────────────────┐
│ Tags: (billing 9) (email 7) …          │   │      No results on this page.          │
│                                        │   │      [ Back to the first page ]        │
│  No Skills match "refund" in "email".  │   └────────────────────────────────────────┘
│                                        │
│  [ Clear filters ]                     │   LOAD ERROR
└────────────────────────────────────────┘   ┌────────────────────────────────────────┐
                                             │ ⚠ Installed skills could not be loaded.│
TOO MANY TAGS (over-limit)                   │   Try refreshing the page.             │
┌────────────────────────────────────────┐   │   (the catalogue below still works)    │
│ Tags: (billing 9) … 12 chips … +128 more│  └────────────────────────────────────────┘
│        ▲ clicking opens a searchable    │
│          list; the row never exceeds    │   TOO MANY TAGS SELECTED
│          two lines                      │   Seventh chip is disabled, tooltip:
└────────────────────────────────────────┘   "Six tags is the limit for one filter."
```

### 6.4 Repair panel (opened from a badge)

```
╔═══════════════════════════════════════════════════════════════════════╗
║  Fix "Refund eligibility check"                                  [×]  ║
╟───────────────────────────────────────────────────────────────────────╢
║  Two things are missing.                                              ║
║                                                                       ║
║   ●  Credential: stripe_key                                           ║
║      Not set for this workspace.                    [ Set it → ]      ║
║                                                                       ║
║   ●  Connection: billing-api                                          ║
║      No connection with this name is set up.        [ Connect → ]      ║
║                                                                       ║
║  ─────────────────────────────────────────────────────────────────    ║
║  Or hand it to someone:                                               ║
║                                                                       ║
║   Agent  [ Wren                     ▾ ]      [ Ask Wren to fix this ] ║
║                                                                       ║
║   They'll get a Task listing exactly what's missing, and you'll see    ║
║   it on the mission board like any other work.                                ║
╚═══════════════════════════════════════════════════════════════════════╝

 PERMISSION-DENIED VARIANT              ALREADY-IN-PROGRESS VARIANT
 [ Set it → ]  disabled                 ╔══════════════════════════════════════╗
 "Only a workspace owner can            ║ Wren is already fixing this — opened ║
  connect this."                        ║ 4 minutes ago.                       ║
 (the item stays fully named)           ║ [ Open the Task ]                    ║
                                        ║ [ Cancel that and start over ]       ║
                                        ╚══════════════════════════════════════╝
```

### 6.5 Skill detail — new panels above the existing sections

```
╔═════════════════════════════════════════════════════════════════════════════╗
║ ← Back to Skills                                                            ║
║ Refund eligibility check                        Yours · v1.2.0 · /refund    ║
╟─────────────────────────────────────────────────────────────────────────────╢
║  READINESS                                        Checked 6 minutes ago  ⟳  ║
║  ⚠ Missing 1 requirement                                                    ║
║     This Skill won't be able to finish the job until it's connected.        ║
║     [ Fix it here ]   [ Ask an agent ▾ ]                                    ║
╟─────────────────────────────────────────────────────────────────────────────╢
║  REQUIREMENTS                                                               ║
║  ✓  Tool     · createTask                       available                   ║
║  ✓  Tool     · getSkillBody                     available                   ║
║  ✗  Credential · stripe_key                     not set                     ║
╟─────────────────────────────────────────────────────────────────────────────╢
║  WHERE IT CAME FROM                                                         ║
║  Written in this workspace. Drafted from a run by Wren on 3 September.      ║
║  [ Open that run ]                                                          ║
╟─────────────────────────────────────────────────────────────────────────────╢
║  INSTRUCTIONS                              [ Write ] [ Preview ]            ║
║  … the existing body editor, unchanged …                                    ║
╟─────────────────────────────────────────────────────────────────────────────╢
║  BINDINGS            … the existing bindings section, unchanged …           ║
║  FILES               … the existing companion-file section, unchanged …     ║
╚═════════════════════════════════════════════════════════════════════════════╝
```

Requirement row copy: `available` · `not set` · `not connected` · `refused by your access
rules` · `couldn't check`.

### 6.6 Capture from a run

```
RUN PAGE HEADER (existing surface, one new action)
┌───────────────────────────────────────────────────────────────────────────┐
│ Run · Wren · completed · 2m 14s          [ Save this as a Skill ]  [ ⋯ ]  │
└───────────────────────────────────────────────────────────────────────────┘
   disabled variant tooltip:
   "Save a Skill from a run that finished cleanly — this one didn't."
   after a draft exists, the button reads:  [ View the Skill from this run ]

DIALOG
╔══════════════════════════════════════════════════════════════════════╗
║  Save this as a Skill                                           [×]  ║
╟──────────────────────────────────────────────────────────────────────╢
║  Wren will write it up from what it just did — the steps and the     ║
║  things that went sideways — so the next run does it the same way.   ║
║                                                                      ║
║  Attach it to        [ Wren (this agent)              ▾ ]            ║
║  Title (optional)    [                                  ]            ║
║  Anything to stress? [ Mention the 14-day cutoff        ]            ║
║                                                                      ║
║                                    [ Cancel ]  [ Draft the Skill ]   ║
╚══════════════════════════════════════════════════════════════════════╝

AFTER CONFIRM (inline, replaces the button)
   ⟳ Drafting — this takes about a minute.

NOTHING USABLE
   There wasn't enough in this run to make a Skill. Try one where the
   agent actually did the work end to end.
```

### 6.7 Reviewing a drafted Skill

```
╔═════════════════════════════════════════════════════════════════════════════╗
║  ✦ Needs your review                                                        ║
║  Wren drafted this from a run on 3 September. It won't be used until you    ║
║  accept it.                                          [ Accept ] [ Discard ] ║
╚═════════════════════════════════════════════════════════════════════════════╝
   … the normal detail page below, fully editable before accepting …

ACCEPT DIALOG (only when the Skill has no binding yet)
╔══════════════════════════════════════════════════════════════════════╗
║  Accept "Refund eligibility check"                              [×]  ║
║  Nothing is attached to it yet, so nothing would pick it up.         ║
║  Attach it to  [ Wren                                    ▾ ]         ║
║                              [ Accept without attaching ] [ Accept ] ║
╚══════════════════════════════════════════════════════════════════════╝

DISCARD CONFIRMATION
   "Discard this draft? It'll be deleted. The run it came from is untouched."
   [ Keep it ]  [ Discard ]
```

### 6.8 Keyboard affordances

| Where | Key | Action |
| --- | --- | --- |
| Shelf | `/` | Focus the search box (does not fire when a text field already has focus). |
| Shelf | `Esc` in search | Clear the query and blur. |
| Tag chip row | `←` `→` | Move between chips. `Space` / `Enter` toggles the focused chip. |
| Tag chip row | `Backspace` on a selected chip | Deselect it. |
| Card grid | `Tab` | Card → toggle → primary repair action → next card. Cards are in DOM order = visual order. |
| Card | `Enter` | Open the Skill. |
| Card toggle | `Space` | Flip it. State change is announced, not just recoloured. |
| Any dialog | `Esc` | Close without acting. Focus returns to the control that opened it. |
| Any dialog | `Enter` | Fire the primary action, unless focus is in a multi-line field. |
| Readiness panel | `R` | Re-check (only while the panel has focus). |

Every badge is text plus an icon; colour is never the only carrier of meaning. Toggle state,
readiness state and requirement met/unmet state each expose a text label to assistive
technology.

---

## 7. Out of scope

- **Skill versioning, history, diff and rollback.** A Skill has a version string today and
  keeps it. Revision history is not built here.
- **Editing a Skill by conversation.** Asking an agent to *rewrite* an existing Skill is a chat
  concern (AW-12); this epic only asks an agent to *repair* readiness and to *draft* from a run.
- **A tag taxonomy.** No tag creation, renaming, merging, colouring or hierarchy. Tags are
  derived from Skill definitions, full stop.
- **Automatic capture.** Nothing is ever drafted without a person asking for it. There is no
  "we noticed this worked, we saved it" behaviour.
- **Publishing or sharing Skills between workspaces.** The catalogue remains the only inbound
  path.
- **Update-available badges for catalogue Skills.** The mechanism to detect a newer catalogue
  version exists but has no caller; wiring it is separate work and is listed as an open
  question, not a requirement here.
- **Live probing of remote services.** The readiness check reads what the workspace already
  knows. It never calls a third party to find out.
- **Changing how Skills are selected at run time.** Priority, dedup and scope resolution are
  untouched. This epic adds one exclusion (the off switch) and reports on the exclusions that
  already exist.
- **Bulk operations.** No multi-select, no "disable all", no bulk attach.
- **The catalogue's own browse experience** beyond what exists — the `Available` section keeps
  its current behaviour; the shelf work is about what is *installed*.

---

## 8. Acceptance criteria

A reviewer can run this list top to bottom against a running build.

**Shelf**

- [ ] Opening Agents ▸ Skills renders installed Skills as cards, 50 per page, with badges
      present on first paint (no reflow after load).
- [ ] Typing a 1-character query changes nothing; a 2-character query filters; the URL updates;
      reloading the URL reproduces the view.
- [ ] Searching a word that appears only in a Skill's tag returns that Skill.
- [ ] Each of the three sort options reorders the grid and survives a reload.
- [ ] `{n} of {total} Skills need you` is accurate; clicking it filters to exactly those Skills.
- [ ] The three empty states (no Skills / no results / page past the end) each render their own
      copy and recovery action.
- [ ] Breaking the installed-list fetch leaves the catalogue section usable, and vice versa.

**Tags**

- [ ] A Skill whose definition lists tags shows them on its card and is reachable by clicking
      the matching chip.
- [ ] Selecting two chips returns only Skills carrying both.
- [ ] The seventh chip is disabled with the stated tooltip.
- [ ] A workspace with more than 12 distinct tags shows `+{n} more`, and the overflow list is
      searchable.
- [ ] Editing a Skill's tags in its definition updates the chip counts on the next shelf load
      with no separate save step.

**On/off**

- [ ] Toggling a Skill off and starting a new run: the Skill is absent from that run.
- [ ] Toggling off and inspecting the Skill's bindings: unchanged in number, target, priority
      and injection flags.
- [ ] Toggling off twice returns success both times.
- [ ] A run already in flight when the toggle happens completes with the Skill still in context.
- [ ] The activity record shows the toggle, the actor and the direction, and contains no body
      text.

**Readiness**

- [ ] A Skill with zero bindings badges **Not reaching any agent**.
- [ ] A Skill whose bindings are all muted badges **Not reaching any agent**.
- [ ] A Skill declaring a tool whose credential is unset badges **Missing 1 requirement** and
      names the key.
- [ ] A Skill whose every declared tool is refused badges **Blocked by your access rules**.
- [ ] A Skill declaring three tools of which one is allowed does **not** badge blocked.
- [ ] A Skill declaring no tools and bound to an agent shows no badge.
- [ ] No endpoint or rendered surface anywhere exposes a credential value.
- [ ] Forcing the check to fail yields **Couldn't check**, never **Ready**.
- [ ] **Re-check** updates the badge without a page reload and is refused past 30 per minute.
- [ ] The background sweep updates verdicts older than 60 minutes and stops at 500 per tick.
- [ ] A run that drops a Skill leaves the shelf badge reflecting that within the same operation.

**Repair**

- [ ] Every non-ready badge exposes at least one repair path; a ready card exposes none.
- [ ] **Attach to…** on an unbound Skill creates the binding and clears the badge in-place.
- [ ] **Fix it here** on a missing credential deep-links to the exact settings row for that key.
- [ ] **Ask an agent** creates exactly one Task, assigned to the chosen agent, whose description
      names every unmet requirement, and starts a run; the request returns in under 2 seconds.
- [ ] A second **Ask an agent** while the first Task is open returns the existing Task and does
      not create a second.
- [ ] A member without the required permission sees the disabled action with its reason, still
      sees the missing item's name, and can still delegate.

**Capture**

- [ ] **Save this as a Skill** is enabled only for a run whose status is `completed`.
- [ ] Confirming returns in under 2 seconds and the button becomes **Drafting…**.
- [ ] The produced Skill has a title, a situation-phrased description, numbered steps, an
      **Edge cases** section, and at most 6 tags.
- [ ] The produced Skill badges **Needs your review** and is absent from every run until
      accepted.
- [ ] A run with no substance produces no Skill row and the stated message.
- [ ] A drafted body containing a secret-shaped string or a model control sequence is rejected
      and reported; no row is written.
- [ ] Requesting capture twice for the same run returns the same draft.
- [ ] Accepting clears the review badge; a Skill with no binding is offered the picker inline.
- [ ] Discarding deletes the draft and leaves the run untouched.

**Cross-cutting**

- [ ] Every id belonging to another workspace answers not found on every verb.
- [ ] Every visible string resolves through translation; none is concatenated.
- [ ] The whole shelf, both dialogs and both new detail panels are operable by keyboard alone
      and pass an automated accessibility check with no new violations.
- [ ] No badge relies on colour alone.

---

## 9. Open questions

- **[NEEDS CLARIFICATION: how far do we go for third-party tool requirements?]** Our own
  credential catalogue is currently empty by design — no built-in tool requires a secret yet.
  The requirement enumeration is therefore exercised in practice mainly by connection-backed
  tools. Do we ship the credential branch anyway (mechanism first, as the credential catalogue
  itself was shipped), or defer it until the first built-in tool needs a key?
- **[NEEDS CLARIFICATION: who is the default repair agent?]** The picker requires a choice
  today. Should the workspace be able to nominate a default so the button can read
  "Ask Wren to fix this" with no dropdown interaction at all?
- **[NEEDS CLARIFICATION: should a repair Task be visible on the mission board?]** It is an
  ordinary Task, so by default it appears. Owners may find a shelf of maintenance chores noisy
  next to real work. Hide behind the existing "hidden from board" flag, or show it?
- **[NEEDS CLARIFICATION: staleness.]** Should a Skill that has not been picked up by any run in
  N days carry a signal? It is a genuine hygiene question, but "unused" is not "broken", and the
  badge slot is explicitly reserved for things that need a person. Deferred unless research says
  owners want it.
- **[NEEDS CLARIFICATION: catalogue updates.]** The ability to ask a catalogue provider whether a
  newer version of an installed Skill exists is implemented and has no caller. Adding an
  **Update available** chip would fit the shelf naturally, but it is a different question from
  readiness. Own epic, or a small addition here?
- **[NEEDS CLARIFICATION: capture from a Work generation run.]** Runs come in more than one
  shape. This epic scopes capture to agent runs. Should generation runs be capturable too, and
  if so what would the Skill be attached to?
- **[NEEDS CLARIFICATION: what happens to a Skill's readiness when it is bound to a scope with
  many agents?]** A Skill bound at the workspace level may be ready for one agent and blocked
  for another. This spec resolves it optimistically (ready if it works for at least one agent
  in scope) and shows the per-agent detail in the requirements panel. Is optimistic the right
  default, or should the badge report the worst case?
