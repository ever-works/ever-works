# AW-21 — Capability & playbook catalogue · Product Spec

**Epic:** `AW-21-capability-catalog` · **Program:** [Agent Workspace](../README.md)
**Status:** Draft v1 · **Owner:** Product · **Date:** 2026-09-06
**Audience:** Product, Engineering (backend + frontend), Design
**Size:** M · **Blocking dependencies:** [AW-08](../README.md#3-epics) (Skills shelf — the Skills
section of the catalogue links into the shelf it builds)
**Soft dependencies:** [AW-01](../README.md#3-epics) (palette commands that reach the catalogue),
[AW-03](../README.md#3-epics) (adopted playbooks route their escalation points into My Decisions),
[AW-09](../README.md#3-epics) (an adopted playbook's cost rollup reads run receipts),
[AW-10](../README.md#3-epics) (an adopted playbook's cadence appears on the schedules calendar),
[AW-20](../README.md#3-epics) (the last onboarding step hands off to this catalogue)

> **Additive-only (program rule #1, NN #20).** Nothing here removes, renames or replaces the six
> template surfaces Ever Works already ships. `/templates`, `/agents/templates`,
> `/skills/templates`, `/tasks/templates`, the Work-blueprint chips and the prebuilt-company
> picker all keep their routes, their behaviour and their bookmarks. This epic adds **one index
> above them** and **one new kind of catalogue entry** underneath.
>
> **Two new nouns, justified in §5 and added to the program vocabulary table in the same PR**
> (program rule #2): **Playbook** (a packaged outcome in the catalogue) and **Playbook
> adoption** (the record of a workspace having set one up). Every _other_ thing this epic touches
> is an existing Ever Works noun — Agent, Skill, Task, Mission, Schedule, Trigger, Approval,
> Escalation, Run, Knowledge Base, Plugin, Connection, Workflow.

---

## 1. Overview

**Catalog** is one browsable page that answers "what can this workspace actually do?" — and, for
each answer, lets somebody set it up without assembling it by hand.

It has five sections. The headline one is **Playbooks**: packaged outcomes, each of which
names its trigger, its steps, the connections it needs, the artefacts it produces and the exact
moments it will stop and ask a human. A playbook is adoptable as a single confirmed action that
provisions the real Ever Works rows behind it — an Agent from a template, the Skills it needs
bound to that Agent, a Task template for its steps, a Schedule or Trigger for its cadence, and
the approval guardrails that make its escalation points real. The other four sections make the
capabilities that already exist findable in the same place: **Skills** (installable from the
catalogue), **Workflows** (saved graphs, listed and runnable for the first time), **Task
templates** (the multi-step shapes that already instantiate a task tree), and **Starting points**
(the Work, Website and Mission template catalogue that already ships).

Every card in every section carries the same four facts: what it produces, what it needs before
it will work, what it will ask you about, and what it is likely to cost. An adopted playbook
keeps a receipt: what it created, whether it is running, how many runs it has had in the last 30
days and what those runs cost.

## 2. Why now

### 2.1 The user's question

> _"I have agents, skills, missions, schedules, a knowledge base and forty-odd plugins. What do I
> actually **do** with them on a Monday morning?"_

Ever Works has a capability problem that is the opposite of the usual one. The capabilities are
built. What is missing is any surface that names an **outcome** and shows the path to it. A new
owner lands on a dashboard of nouns — Agents, Missions, Tasks, Skills, Memory, Works, Plugins —
and every one of them is a container waiting to be filled with an idea the owner has to supply.

### 2.2 What our users do today

They assemble it by hand, across six screens, in this order, with nothing telling them the order:

| Step                           | Where they go today                                                                                                  | What can go wrong                                                                         |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| 1. Create an agent             | `/agents/new`, or `/agents/templates` for one of the 6 built-in presets                                              | The preset list is a scaffold page that carries no outcome, only a role                   |
| 2. Give it skills              | `/agents#skills` → catalogue → install → bind                                                                        | Nothing tells them _which_ skills that role needs                                         |
| 3. Write its instructions      | Agent instructions editor                                                                                            | Blank page. This is where most attempts die                                               |
| 4. Give it a cadence           | Agent settings heartbeat, or a recurring Task, or a Work schedule, or an inbound trigger — four different mechanisms | No guidance on which mechanism fits which job                                             |
| 5. Decide what it may do alone | Agent guardrails (`require_approval` / `autonomous`, blocked action types)                                           | Defaults to asking about everything, which trains people to click Approve without reading |
| 6. Connect what it needs       | `/plugins` → install → enable → settings                                                                             | Discovered at run time, as a failure, after all five steps above                          |

Six screens, five judgement calls, and the first evidence that any of it was right arrives a week
later. The measurable costs, all of them ours:

| Gap                                                    | What it costs us                                                                                                                                                                                                                                      |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No outcome-shaped entry point                          | The onboarding wizard ends by creating a Work and then stops. There is no second step that says "here is a job your agents can do this week."                                                                                                         |
| Capability catalogues are scattered across five routes | Four of the five (`/agents/templates`, `/skills/templates`, `/tasks/templates`, the Work-blueprint chips) are labelled by their own authors as scaffolds, three of them are not internationalised, and none of them is reachable from a single index. |
| Multi-step task templates are invisible                | The mechanism that instantiates a parent Task plus one sub-task per step, with dependency edges, assignees and approvers, in one transaction, is rendered underneath an unrelated catalogue on a page nothing links to.                               |
| Saved workflow graphs have no screen at all            | A user can save a graph, run it, and read its trace — but only with a raw HTTP client. Nothing in the product lists them.                                                                                                                             |
| Nothing states an escalation point up front            | Guardrails are configured on the agent, days after the agent was created, by somebody who has not yet seen the agent do anything. The result is an all-or-nothing choice made with no evidence.                                                       |
| Nothing states a cost up front                         | An owner cannot find out what a weekly research job costs until they have run one.                                                                                                                                                                    |

### 2.3 Why a catalogue and not more documentation

Documentation tells you a thing is possible. It cannot tell you whether **your** workspace can do
it right now — whether the search plugin is enabled, whether an agent exists, whether the daily
budget has room. The catalogue can, because it reads your workspace before it offers you the
button. A playbook card that says _"needs a search connection — you do not have one"_ and links
straight to the plugin page is worth more than a paragraph that says the same thing to everybody.

And it closes the loop the program is built around: an adopted playbook produces Runs with
receipts, Approvals that land in My Decisions, artefacts in the Knowledge Base, and a Schedule on
the calendar. It is the shortest path from "I signed up" to "the loop in the program overview is
turning."

## 3. User scenarios

### 3.1 First visit — an owner with nothing set up

**Given** an owner whose workspace has one Work, no Agents, and only the default plugins,
**when** they open **Catalog** from the sidebar,
**then** the page shows five sections; **Playbooks** is first and shows 8 cards; each card shows
its outcome line, its cadence, an estimated cost band, and a readiness chip; 5 of the 8 read
`Ready — needs no connections`, and 3 read `Needs 1 connection`,
**and** a one-line banner above the grid reads `Nothing set up yet. Start with one that needs no
connections.` with the three zero-connection playbooks visually first in the default sort.

### 3.2 Reading a playbook before committing

**Given** the owner opens **Weekly operations report**,
**when** the detail page renders,
**then** they can read, without leaving the page: the outcome in one sentence; the trigger
(`Every Monday 07:00, in your workspace timezone`); the 4 numbered steps with what each produces;
the connections required (`none`); the artefacts it will produce (`1 Knowledge Base document per
week, in Reports`); the escalation points (`the report's "Needs you" section links every open
decision — it never creates one of its own`); the guardrails it will apply
(`Asks before: send_message, budget_override`); the caps it will apply (`≤ 600 words, ≤ 3
recommendations`); and the estimated cost (`~8–20k tokens per run`),
**and** a single primary button reads `Set it up`.

### 3.3 Adopting a playbook (the happy path)

**Given** the owner presses `Set it up`,
**when** the setup sheet opens,
**then** it lists exactly what will be created — `1 Agent ("Ops reporter"), 2 Skills, 1 Task
template with 4 steps, 1 weekly Schedule, guardrails set to ask before sending anything` — with
an editable instance name and an editable run time,
**and** pressing `Create it` returns immediately with the card switching to `Setting up…`,
**and** within 60 seconds the card reads `Active · next run Monday 07:00`, with links to the
Agent, the Skills, the Task template and the Schedule that were created.

### 3.4 A required connection is missing

**Given** an owner opens **Market watch brief**, which declares a required `search` capability and
an optional `content-extractor`,
**and** their workspace has no enabled search plugin,
**when** the detail page renders,
**then** the readiness panel reads `Not ready — 1 required connection missing`, lists
`Search — no enabled plugin provides it` with a `Connect` link to the plugins page, lists the
optional one separately as `Optional — page text extraction. Without it, entries link out instead
of quoting.`, and the `Set it up` button is disabled with the hint `Connect a search provider
first`,
**and** returning to the page after enabling one shows `Ready` without a manual refresh (the
readiness read is not cached across a connection change for more than 60 seconds).

### 3.5 Adoption fails halfway

**Given** an adoption that created the Agent and installed one of two Skills, and then the skills
catalogue provider became unreachable,
**when** the job gives up after its third attempt,
**then** the adoption shows `Setup incomplete` with a plain-language reason
(`Could not install the skill "weekly-rollup" — the skills catalogue did not answer`), an itemised
list of what **was** created with links, a `Try again` button that resumes from the failed step
without duplicating the Agent, and a `Remove what was created` option that lists each item with
its own checkbox and is unchecked by default,
**and** nothing that was created is deleted automatically.

### 3.6 The same playbook, twice

**Given** an owner who already runs **Market watch brief** for one Work,
**when** they open it again and press `Set it up`,
**then** the sheet pre-fills the instance name as `Market watch brief 2` and warns
`You already run this once. A second copy runs on its own cadence and costs the same again.`,
**and** on the 4th attempt the button is disabled with `Limit reached — 3 copies of one playbook
per workspace. Retire one first.`

### 3.7 The workspace hits its adoption ceiling

**Given** a workspace with 25 active adoptions,
**when** the owner opens any un-adopted playbook,
**then** `Set it up` is disabled with `You have 25 playbooks running — the maximum. Retire one to
add another.` and a link to the adoptions list sorted by least-recently-run.

### 3.8 Two people adopt the same playbook at the same moment

**Given** two members of one organization who both press `Create it` on the same playbook within
the same second,
**when** the second request lands,
**then** it is refused with `Someone else is setting this up right now` and a link to the
in-flight adoption — one adoption row exists, one Agent exists, and no duplicate Skills, Task
template or Schedule were created.

### 3.9 A viewer tries to adopt

**Given** a person whose role in the organization is read-only,
**when** they open the catalogue,
**then** they can browse and read every card and every detail page,
**but** `Set it up`, `Pause`, `Retire` and `Run` are absent (not merely disabled), and the detail
page carries the line `You can browse the catalogue. Setting a playbook up needs edit access.`

### 3.10 The catalogue provider is unreachable

**Given** the playbook catalogue provider cannot be reached,
**when** the catalogue page loads,
**then** the built-in playbooks that ship with the build still render, a quiet line above the grid
reads `Showing the built-in catalogue — the hosted list could not be reached (last updated 3 hours
ago)`, and no error dialog appears,
**and** if nothing at all can be resolved, the section renders an empty state reading
`The playbook catalogue is unavailable right now. Everything else on this page still works.`

### 3.11 Pausing and retiring

**Given** an active adoption,
**when** the owner presses `Pause`,
**then** the adoption reads `Paused`, its Schedule stops firing, its Agent is **not** paused (it
may serve other work), and the card offers `Resume`,
**and when** they press `Retire`,
**then** a confirmation reads `Retire "Weekly operations report"? Its schedule stops. The agent,
skills, task template and everything it produced are kept.` and on confirm the adoption reads
`Retired` and moves to a collapsed `Retired` group at the bottom of the adoptions list.

### 3.12 Removing what a playbook created

**Given** a retired adoption with 5 recorded artefacts, one of which (the Agent) the owner has
since renamed and bound extra skills to,
**when** they choose `Remove what was created`,
**then** each artefact is listed with its current name, its type, and a checkbox unchecked by
default; the renamed Agent carries the note `Changed since setup — review before removing`; the
Knowledge Base documents the playbook produced are **not** listed at all (produced output is never
offered for bulk removal),
**and** on confirm only the checked items are removed, each removal is written to the activity
log, and any artefact that no longer exists is skipped and reported as `already gone`.

### 3.13 Browsing Workflows for the first time

**Given** a user who saved two workflow graphs through the API,
**when** they open the **Workflows** section,
**then** both are listed with name, status (`Draft` / `Active` / `Archived`), node count, run
count and last run,
**and** pressing `Run` on an `Active` one returns immediately with `Queued`, the row shows a live
status, and opening the run shows which nodes ran, each node's outcome, the edges traversed, any
decision points and the final output,
**and** pressing `Run` on an `Archived` one is refused with `This workflow is archived. Reactivate
it to run it.`

### 3.14 Searching the whole catalogue

**Given** anybody on the catalogue index,
**when** they press `/` and type `weekly`,
**then** the search narrows every section at once, showing counts per section, matching on title,
summary, tags and step titles, ranked title-first, with the term highlighted,
**and** a search that matches nothing shows `Nothing matches "zzz". Try a shorter word, or clear
the search.` with a `Clear` button, and the section counts all read `0`.

### 3.15 An adopted playbook's first real run

**Given** an adoption whose first scheduled run has completed,
**when** the owner opens the adoption,
**then** it shows `1 run in the last 30 days · about $0.04` sourced from the run receipts, a link
to the run itself, a link to the artefact it produced, and — if the run raised one — a link to the
decision waiting in My Decisions,
**and** if the run failed, the adoption shows `Last run failed` with the failure reason and a
`Run now` button, and does not silently keep failing without surfacing it.

### 3.16 The 14-day review period ends

**Given** an adoption that has been active for 14 days with guardrails at `Asks before everything`
and 11 approvals granted with 0 rejections,
**when** the owner next opens it,
**then** a single non-blocking suggestion reads `You have approved 11 of 11 actions from this
playbook. Let it send routine replies on its own?` with `Not yet` and `Review the change` — where
`Review the change` shows exactly which action types would stop asking,
**and** nothing changes unless the owner confirms; dismissing it does not ask again for 30 days.

## 4. Functional requirements

Every threshold below is a number on purpose. "Reasonable", "quickly" and "a few" do not appear.

### 4.1 The catalogue index

- **FR-1** The catalogue is reachable at a dedicated dashboard route and from a sidebar entry
  labelled `Catalog`. The page heading reads `What you can do`.
- **FR-2** The index renders exactly five sections in this fixed order: **Playbooks**, **Skills**,
  **Workflows**, **Task templates**, **Starting points**.
- **FR-3** Each section shows at most **6** cards on the index plus a `See all (N)` control. `N`
  is the true total for that section, not the number rendered.
- **FR-4** A section whose backing source fails renders its own error state and does not prevent
  the other four from rendering. At most one section may be in an error state without the page
  being considered failed.
- **FR-5** Section order and membership are identical for every user. Sections are not
  personalised, reordered by usage, or hidden when empty — an empty section renders its empty
  state so the capability stays discoverable.
- **FR-6** Search (`/` to focus) filters all five sections simultaneously, requires **2**
  characters minimum, debounces at **250 ms**, matches case-insensitively against title, summary,
  tags and (for playbooks) step titles, and ranks title matches above tag matches above summary
  matches.
- **FR-7** Filter chips on the Playbooks section filter by category. Categories in v1 are exactly
  five: `Reporting`, `Content`, `Operations`, `Research`, `Inbox`.
- **FR-8** A second chip row filters by readiness: `Ready now`, `Needs a connection`, `Already set
up`. Chips are additive within a row and intersecting across rows.
- **FR-9** The index makes at most **1** network round trip after first paint. All five sections
  are server-rendered on first load.
- **FR-10** Catalogue reads are cached server-side for **300 s** per scope. Readiness (which
  depends on the caller's plugins) is cached for **60 s** and never longer.

### 4.2 What a playbook declares

- **FR-11** Every playbook declares, and the UI renders, all nine of: `slug`, `title`, a one-line
  `outcome`, `category`, `version`, `trigger`, an ordered list of `steps`, `requiredConnections`,
  and `artefacts`.
- **FR-12** Every playbook additionally declares `escalations` (when it will stop and ask),
  `guardrails` (the approval posture applied at adoption), `caps` (its own volume limits), and a
  `costBand` of `low` (< 15k tokens/run), `medium` (15k–60k), or `high` (> 60k).
- **FR-13** A trigger is exactly one of four kinds: `schedule` (a cadence), `inbound_trigger` (an
  external event), `event` (an in-product event), or `manual` (run on demand). A playbook with a
  `schedule` trigger declares a default cadence and a default local time.
- **FR-14** A playbook declares between **2** and **8** steps. Each step declares a title, a
  one-sentence description of what it produces, an optional agent-template hint, and whether it
  `requiresApproval`.
- **FR-15** Each required connection names a **capability** (for example `search`,
  `email-outbound`), never a specific provider, and carries a one-sentence `reason`. Optional
  connections are declared separately and describe what degrades without them.
- **FR-16** Each declared artefact names its kind (one of: Knowledge Base document, Mission, Task,
  email draft, Run receipt) and where it will land.
- **FR-17** Each declared escalation point names its trigger condition and which surface it
  becomes — an **Approval** or an **Escalation** — and states that it carries a recommendation.
- **FR-18** v1 ships **8** built-in playbooks, of which **at least 5** require no external
  connection at all.
- **FR-19** The built-in catalogue is available even when no remote catalogue source can be
  reached, and is never empty.
- **FR-20** A remote catalogue entry with the same slug as a built-in one replaces it only when
  its `version` is strictly greater; otherwise the built-in wins. Version comparison is
  `MAJOR.MINOR.PATCH`.
- **FR-21** Every string in a catalogue entry from a remote source is HTML-stripped and
  length-capped before rendering: title **120**, outcome **200**, summary **600**, step title
  **120**, reason **200**. A slug that does not match `^[a-z0-9][a-z0-9-]{0,63}$` is dropped.

### 4.3 Readiness and preflight

- **FR-22** A playbook's readiness is one of exactly four states: `ready`, `needs_connection`,
  `blocked`, `adopted`.
- **FR-23** `needs_connection` lists every missing required capability by name, each with a direct
  link to where it is connected.
- **FR-24** `blocked` covers the three non-connection blockers: the workspace is at its adoption
  ceiling; this playbook is at its per-playbook copy limit; the caller lacks edit access.
- **FR-25** Preflight is a read-only operation with **no** side effects. It never creates,
  enables, installs or writes anything.
- **FR-26** Preflight returns within **2 s** or returns a partial result marking the unresolved
  checks as `unknown` — it never hangs the page.
- **FR-27** Preflight additionally reports name collisions: if the Agent name the playbook would
  create already exists for this user, the sheet pre-fills a de-duplicated name rather than
  failing at write time.

### 4.4 Adoption

- **FR-28** Adoption is a **single confirmed action**. There is no multi-page wizard. The setup
  sheet has exactly one primary button.
- **FR-29** The setup sheet itemises every row that will be created, by type and name, before the
  confirm. A playbook may not create anything it did not itemise.
- **FR-30** The setup sheet allows editing exactly three things in v1: the instance name, the run
  time (for `schedule` triggers), and which Work the playbook is scoped to (when it needs one).
- **FR-31** The adopt request returns within **1 s** with an adoption id and the status
  `provisioning`. Provisioning itself runs in the background.
- **FR-32** Provisioning performs its steps in this fixed order, and each step is idempotent:
  (1) create or reuse the Agent, (2) install and bind the Skills, (3) create the Task template
  and its steps, (4) apply guardrails to the Agent, (5) create the Schedule or Trigger,
  (6) save the Workflow graph if the playbook declares one.
- **FR-33** Every row provisioning creates is recorded as an artefact of the adoption, with its
  type, its id, and the name it had at creation.
- **FR-34** Provisioning is retried up to **3** times. An adoption still `provisioning` after
  **15 minutes** is moved to `failed` by a sweep and stops consuming a slot.
- **FR-35** A failed adoption can be resumed. Resuming re-runs only the steps that did not
  complete; it never creates a second Agent, Skill binding, Task template or Schedule.
- **FR-36** Concurrent adoption of the same playbook slug in the same organization is serialised:
  the second request is refused with a conflict and a link to the in-flight adoption.
- **FR-37** A workspace may hold at most **25** adoptions in `provisioning`, `active` or `paused`.
  `retired` and `failed` adoptions do not count.
- **FR-38** A workspace may hold at most **3** non-retired adoptions of the same playbook slug.
- **FR-39** Every adoption applies `require_approval` guardrails on the Agent it creates,
  regardless of what the playbook's `guardrails` field declares as its graduated posture. The
  graduated posture is only ever **offered**, never applied at adoption.
- **FR-40** Adoption writes an activity-log entry naming the playbook, the instance, and the count
  of rows created.
- **FR-41** Adopting a playbook never changes an existing Agent's instructions, guardrails or
  bindings. If the sheet offers to reuse an existing Agent, that reuse only **adds** skill
  bindings and never edits the Agent's own configuration.

### 4.5 Living with an adoption

- **FR-42** An adoption is in exactly one of six states: `provisioning`, `active`, `paused`,
  `failed`, `retired`, `removed`.
- **FR-43** `Pause` stops the adoption's Schedule or Trigger only. It does not pause the Agent,
  cancel in-flight runs, or unbind skills.
- **FR-44** `Retire` stops the cadence and keeps every artefact. It is reversible only by adopting
  again; the confirmation says so.
- **FR-45** `Remove what was created` lists every artefact with a checkbox **unchecked by
  default**, flags any artefact whose name changed since creation, and never lists produced output
  (Knowledge Base documents, Missions, Tasks, drafts, run receipts).
- **FR-46** Removal is per-item and confirmed once. An artefact that no longer exists is reported
  as `already gone` and does not fail the batch.
- **FR-47** An adoption shows a 30-day rollup: run count, total cost in the workspace currency to
  2 decimal places, and last run outcome. When there have been no runs it reads `No runs yet ·
first run <date>`.
- **FR-48** An adoption whose last **3** consecutive runs failed shows a persistent warning with
  the last failure reason and a `Run now` control. It is not silently left failing.
- **FR-49** After **14** days active with **zero** rejected approvals, an adoption shows one
  non-blocking graduation suggestion. Dismissing it suppresses it for **30** days. It never
  auto-applies.
- **FR-50** Every artefact links to the thing it created, and every created thing shows which
  playbook and adoption produced it.

### 4.6 The other four sections

- **FR-51** The **Skills** section lists catalogue skills with title, description, tags and an
  install control, and marks skills already installed for this scope as `Installed`.
- **FR-52** The **Workflows** section lists the caller's saved workflow graphs with name, status,
  node count, run count and last run time, newest-updated first.
- **FR-53** A workflow with status `Active` or `Draft` can be run from the list. The run control
  returns within **1 s** with a run id and a `Queued` status; it never waits for the graph.
- **FR-54** Running an `Archived` workflow is refused with an explanatory message and a link to
  reactivate it.
- **FR-55** A workflow's run history is readable — newest first, with each run's status, duration,
  step count and, on opening one, the full trace: nodes executed, per-node outcome, edges
  traversed, decision points and the final output.
- **FR-56** The **Task templates** section lists the caller's multi-step task templates with step
  count and an `Use it` control that instantiates the parent Task plus one sub-task per step,
  preserving dependency edges, assignees and approvers.
- **FR-57** The **Starting points** section lists the existing Work / Website / Mission template
  kinds with a count each and links to the existing template pages. It does not duplicate their
  browse or fork behaviour.
- **FR-58** Every section's `See all` control goes to that capability's existing page where one
  exists, and to a new catalogue sub-page only where none does (Workflows).

### 4.7 Access, i18n, accessibility

- **FR-59** Browsing the catalogue requires read access to the active workspace. Adopting,
  pausing, retiring, removing, running a workflow and instantiating a task template all require
  edit access. Controls the caller cannot use are **absent**, not disabled-and-mysterious, except
  where the disabled state carries an actionable reason (FR-4.3 blockers).
- **FR-60** Every user-visible string on every new surface is a translation key. No hardcoded
  English ships on this epic's surfaces.
- **FR-61** The whole catalogue is keyboard-operable: `/` focuses search, arrow keys move card
  focus within a section, `Tab` moves between sections, `Enter` opens the focused card, `Esc`
  closes any sheet, and the setup sheet traps focus and returns it to the card that opened it.
- **FR-62** Every card is a single focusable element with an accessible name of the form
  `<title>, <category>, <readiness>`. Readiness is never conveyed by colour alone — each state
  carries a text label.

## 5. Key entities

### 5.1 New — and why they have to be new

#### Playbook (catalogue entry — **no table**)

A **Playbook** is a packaged outcome: trigger, steps, required connections, artefacts,
escalation points, guardrails and caps, packaged under one slug and one version.

_Why it cannot be an existing noun._ Every existing Ever Works template is a template of **one
thing**: an Agent template makes an Agent, a Skill template makes a Skill, a Task template makes a
Task tree, a Work template makes a Work. A Playbook is the only object that spans them — it is a
packaged outcome whose output is an Agent **and** its Skills **and** a Task template **and** a Schedule
**and** a guardrail posture, plus the promise about what it will and will not do alone. Modelling
it as a sixth kind of `Template` would misuse an entity whose whole shape (repository owner, repo
name, branch, fork target) is about git-hosted starting points.

_Why it has no table._ Playbook definitions are **catalogue data, not user data**. They are
supplied by an installed provider plugin exactly as Skill catalogue entries already are, cached in
memory, and re-resolved on a TTL. Nothing about a definition is user-specific, so nothing about it
needs a row. What **is** user-specific is the adoption, below.

_Disambiguation._ A Knowledge Base folder named `Playbooks` (a common convention, used as an
example in [AW-06](../AW-06-knowledge-library/spec.md)) is documents. A **Playbook** here is a
catalogue entry. The two never appear in the same surface.

States: a catalogue entry has no lifecycle of its own. It is `available` or `unavailable` for a
given workspace, derived from readiness, and `superseded` when a higher version replaces it.

#### Playbook adoption (**new table**)

A record that this workspace set up this playbook: which playbook, which version, who did it, what
instance name, what it created, and whether it is running.

_Why it has to exist._ Without it there is no way to show `Already set up`, no way to stop a second
click creating a duplicate Agent, no way to pause the thing as a unit, no way to attribute a run's
cost to the job it belongs to, and no way to answer "what did this create?" when somebody wants to
undo it. It is the receipt, and this program's rule #9 says every new surface has to be able to
answer "what did it cost?".

States and transitions:

```
                   adopt
                     │
                     ▼
              ┌──────────────┐   provisioning succeeded   ┌──────────┐
              │ provisioning │ ─────────────────────────► │  active  │
              └──────────────┘                            └──────────┘
                  │      ▲                                  │      ▲
   failed / 15-min │      │ resume                     pause│      │ resume
       sweep       ▼      │                                 ▼      │
              ┌──────────────┐                          ┌──────────┐
              │    failed    │                          │  paused  │
              └──────────────┘                          └──────────┘
                     │                                       │
                     │              retire                   │
                     └───────────────┬───────────────────────┘
                                     ▼
                               ┌──────────┐   remove-artifacts (all)   ┌──────────┐
                               │ retired  │ ─────────────────────────► │ removed  │
                               └──────────┘                            └──────────┘
```

`removed` is terminal and only reachable from `retired`. `retired` keeps every artefact; `removed`
means the owner explicitly ticked every artefact and confirmed.

#### Playbook adoption artefact (**new table**)

One row per thing an adoption created: its type, its id in the owning table, the name it had at
creation, and its current state.

_Why not a JSON column on the adoption._ Two reads need it in the other direction — "which playbook
created this Agent?" on the Agent page (FR-50), and "which of these artefacts still exists and has
it changed?" for the removal flow (FR-45). Both are per-artefact lookups against a set that is
written once and read often.

States: `created` → `changed` (its name no longer matches what was recorded) → `missing` (the row
is gone) → `removed` (this flow removed it). `changed` and `missing` are detected on read, not
written by a sweep.

### 5.2 Existing entities this epic reads and writes

| Ever Works noun                      | How this epic uses it                                                                        | Written?                          |
| ------------------------------------ | -------------------------------------------------------------------------------------------- | --------------------------------- |
| **Agent**                            | Created from a built-in agent template at adoption; guardrails set on it                     | Created + guardrails written      |
| **Skill** + **Skill binding**        | Installed from the skills catalogue and bound to the created Agent                           | Created                           |
| **Task** template (multi-step)       | Created from the playbook's step list; surfaced as its own catalogue section                 | Created                           |
| **Schedule** / **Trigger**           | The playbook's cadence becomes an agent cadence or an inbound trigger                        | Created                           |
| **Approval** (agent action proposal) | An adopted playbook's escalation points become approvals under `require_approval` guardrails | Read for the 30-day rollup        |
| **Escalation**                       | A playbook that declares an escalation point raises one at run time                          | Read only                         |
| **Run**                              | The 30-day rollup counts runs and sums their cost                                            | Read only                         |
| **Knowledge Base** document          | The artefact most playbooks produce                                                          | Never written by this epic itself |
| **Plugin** / **Connection**          | Readiness asks whether a capability has an enabled provider                                  | Read only                         |
| **Workflow** + **Workflow run**      | Listed, run and traced by the Workflows section                                              | Run records created               |
| **Mission**                          | An artefact some playbooks produce                                                           | Never written by this epic itself |
| **Organization / Workspace scope**   | Every catalogue read and every adoption is scoped to the active workspace                    | —                                 |

**No existing entity is renamed, no existing column changes meaning, and no existing endpoint
changes its response shape.**

## 6. UX

### 6.1 The index — populated

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│  What you can do                                                    [ / Search…  ]   │
│  Ready-made jobs your agents can run, and every capability already in this workspace.│
│                                                                                      │
│  Playbooks   [All][Reporting][Content][Operations][Research][Inbox]                  │
│              [Ready now ✓][Needs a connection][Already set up]        See all (8) →  │
│  ┌────────────────────────┐┌────────────────────────┐┌────────────────────────┐      │
│  │ 📊 Weekly operations   ││ ☀️ Morning decision    ││ 🔗 Directory freshness │      │
│  │    report              ││    brief               ││    sweep               │      │
│  │ One document every     ││ Ten lines before you   ││ Dead links become      │      │
│  │ Monday: shipped,       ││ start: what needs you, ││ tasks, not surprises.  │      │
│  │ stuck, needs you.      ││ what runs today.       ││                        │      │
│  │                        ││                        ││                        │      │
│  │ Mondays 07:00          ││ Daily 07:00            ││ Weekly                 │      │
│  │ ● Ready   ~8–20k tok   ││ ● Ready   ~5–12k tok   ││ ● Ready   ~10–30k tok  │      │
│  └────────────────────────┘└────────────────────────┘└────────────────────────┘      │
│  ┌────────────────────────┐┌────────────────────────┐┌────────────────────────┐      │
│  │ 🔭 Market watch brief  ││ ✉️ Inbox triage with   ││ 🧩 Knowledge gap       │      │
│  │                        ││    drafts              ││    harvest             │      │
│  │ One living document    ││ Everything triaged,    ││ Questions your KB      │      │
│  │ per source, dated,     ││ replies drafted,       ││ could not answer become│      │
│  │ with links.            ││ nothing sent.          ││ proposed documents.    │      │
│  │ Twice weekly           ││ Weekdays 07:00         ││ Weekly                 │      │
│  │ ○ Needs 1 connection   ││ ○ Needs 1 connection   ││ ✓ Already set up       │      │
│  └────────────────────────┘└────────────────────────┘└────────────────────────┘      │
│                                                                                      │
│  Skills                                                              See all (34) →  │
│  ┌───────────────┐┌───────────────┐┌───────────────┐┌───────────────┐┌────────────┐  │
│  │ Weekly rollup ││ Source check  ││ Tone guide    ││ Draft reply   ││ Cite it    │  │
│  │ Installed     ││ Install       ││ Install       ││ Installed     ││ Install    │  │
│  └───────────────┘└───────────────┘└───────────────┘└───────────────┘└────────────┘  │
│                                                                                      │
│  Workflows                                                            See all (2) →  │
│  ┌──────────────────────────────────────────────────────────────────────────────┐    │
│  │ Item enrichment walk    Active   6 nodes   12 runs   last 2h ago    [ Run ]   │    │
│  │ Weekly digest graph     Draft    4 nodes    0 runs   never          [ Run ]   │    │
│  └──────────────────────────────────────────────────────────────────────────────┘    │
│                                                                                      │
│  Task templates                                                       See all (5) →  │
│  ┌──────────────────────────────────────────────────────────────────────────────┐    │
│  │ Release checklist       7 steps · 2 need approval                  [ Use it ] │    │
│  │ Bug triage              4 steps                                    [ Use it ] │    │
│  └──────────────────────────────────────────────────────────────────────────────┘    │
│                                                                                      │
│  Starting points                                                                     │
│  ┌──────────────────┐┌──────────────────┐┌──────────────────┐                        │
│  │ Work blueprints  ││ Website templates││ Mission templates│                        │
│  │ 9   Browse →     ││ 6   Browse →     ││ 4   Browse →     │                        │
│  └──────────────────┘└──────────────────┘└──────────────────┘                        │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

Copy, verbatim:

- Page heading: `What you can do`
- Page subtitle: `Ready-made jobs your agents can run, and every capability already in this workspace.`
- Section headings: `Playbooks` · `Skills` · `Workflows` · `Task templates` · `Starting points`
- Readiness labels: `Ready` · `Needs 1 connection` / `Needs 2 connections` · `Already set up` ·
  `Not available`
- Cost band labels: `~5–12k tokens` (low) · `~15–60k tokens` (medium) · `~60k+ tokens` (high),
  each with the tooltip `Estimated tokens for one run. Your actual cost shows once it has run.`

### 6.2 The index — first visit (nothing set up)

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│  What you can do                                                    [ / Search…  ]   │
│                                                                                      │
│  ┌──────────────────────────────────────────────────────────────────────────────┐    │
│  │ ✨  Nothing set up yet. Start with one that needs no connections.             │    │
│  └──────────────────────────────────────────────────────────────────────────────┘    │
│  Playbooks — 5 of 8 work with what you already have.                                 │
│  … zero-connection cards sorted first …                                              │
│                                                                                      │
│  Skills            You have not installed any yet.        Browse the catalogue →     │
│  Workflows         No saved workflows.  A workflow is a graph you save and re-run.   │
│  Task templates    No task templates yet.                 Make one →                 │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

Empty-state copy, verbatim:

- Skills: `You have not installed any skills yet.` / action `Browse the catalogue`
- Workflows: `No saved workflows. A workflow is a graph of steps you save once and re-run.` /
  action `Read how workflows work`
- Task templates: `No task templates yet. A template turns one click into a task and its
sub-tasks.` / action `Make one`
- Playbooks (only possible if every source fails): `The playbook catalogue is unavailable right
now. Everything else on this page still works.`

### 6.3 The index — loading

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│  What you can do                                                    [ / Search…  ]   │
│  Playbooks                                                                           │
│  ┌────────────────────────┐┌────────────────────────┐┌────────────────────────┐      │
│  │ ▒▒▒▒▒▒▒▒▒▒▒▒▒▒         ││ ▒▒▒▒▒▒▒▒▒▒▒▒▒          ││ ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒        │      │
│  │ ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒    ││ ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒      ││ ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒     │      │
│  │ ▒▒▒▒▒▒▒▒     ▒▒▒▒▒▒    ││ ▒▒▒▒▒▒▒▒     ▒▒▒▒▒▒    ││ ▒▒▒▒▒▒▒▒     ▒▒▒▒▒▒    │      │
│  └────────────────────────┘└────────────────────────┘└────────────────────────┘      │
│  (aria-busy="true", 6 skeleton cards, no spinner, no layout shift on resolve)        │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

Readiness resolves **after** the cards paint: each card's readiness chip renders as
`Checking…` for at most 2 s, then becomes its final label. Cards never move when it resolves.

### 6.4 The index — a section failed

```
│  Skills                                                                              │
│  ┌──────────────────────────────────────────────────────────────────────────────┐    │
│  │ ⚠  The skills catalogue did not answer. [ Try again ]                         │    │
│  │    Everything else on this page still works.                                  │    │
│  └──────────────────────────────────────────────────────────────────────────────┘    │
```

### 6.5 The index — stale catalogue

```
│  Playbooks                                                                           │
│  ⓘ Showing the built-in catalogue — the hosted list could not be reached             │
│    (last updated 3 hours ago).                                        [ Retry ]      │
```

### 6.6 Playbook detail

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│  ← Catalog                                                                           │
│                                                                                      │
│  🔭  Market watch brief                                        Research · v1.2.0     │
│  One living document per source you name — dated entries, links, and a note on what  │
│  each change might mean. You stop finding out three weeks late.                      │
│                                                                                      │
│  ┌── Readiness ─────────────────────────────────────────────────────────────────┐    │
│  │ ○ Not ready — 1 required connection missing                                  │    │
│  │   • Search — nothing enabled provides it.  Needed to find what changed.       │    │
│  │                                                    [ Connect a search tool → ]│    │
│  │   Optional: Page-text extraction. Without it, entries link out instead of     │    │
│  │   quoting.                                         [ Connect → ]              │    │
│  └──────────────────────────────────────────────────────────────────────────────┘    │
│                                                                                      │
│  WHEN IT RUNS              Twice a week, Tuesdays and Fridays at 08:00               │
│  WHAT IT COSTS             ~15–60k tokens per run · about 8 runs a month             │
│                                                                                      │
│  THE STEPS                                                                           │
│   1  Read each source        Pricing pages, changelogs, blogs, hiring pages, posts   │
│   2  Update the document     One per source. Dated. Every claim carries its link.    │
│   3  Note what it may mean   A short "what this might mean for us" paragraph.        │
│   4  Raise the big ones      ⚑ asks you    A change worth a response opens a         │
│                                            decision with a recommendation attached.   │
│                                                                                      │
│  WHAT IT PRODUCES          Knowledge Base document, one per source, in Research      │
│                            A feed entry per meaningful change                        │
│                                                                                      │
│  WHEN IT STOPS AND ASKS                                                              │
│   • A change it thinks deserves a response → a decision in My Decisions, with a      │
│     recommendation. It never acts on one by itself.                                  │
│   • Anything it could not source → written into the document as unconfirmed, never   │
│     asserted.                                                                         │
│                                                                                      │
│  ITS OWN LIMITS            ≤ 8 sources · ≤ 1 decision raised per run                 │
│  WHAT IT MAY DO ALONE      Nothing, for the first 14 days. Asks before: send a       │
│                            message, spawn an agent, change a budget.                 │
│                                                                                      │
│                          [ Connect a search tool first ]   ← primary, disabled       │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

Section labels, verbatim: `Readiness` · `WHEN IT RUNS` · `WHAT IT COSTS` · `THE STEPS` ·
`WHAT IT PRODUCES` · `WHEN IT STOPS AND ASKS` · `ITS OWN LIMITS` · `WHAT IT MAY DO ALONE`.
Primary button: `Set it up` when ready; `Connect a search tool first` when blocked on a
connection; `You have 25 playbooks running` when at the ceiling; `Already set up — open it` when
adopted.

### 6.7 The setup sheet

```
        ┌────────────────────────────────────────────────────────────────┐
        │  Set up "Weekly operations report"                        [✕]  │
        │                                                                │
        │  Name it          [ Weekly operations report              ]    │
        │  Run it           [ Mondays ▾ ] at [ 07:00 ] Europe/Vilnius    │
        │  For              [ All Works ▾ ]                              │
        │                                                                │
        │  ── This will create ──────────────────────────────────────    │
        │   • 1 Agent          "Ops reporter"                            │
        │   • 2 Skills         Weekly rollup, Cite it — bound to it      │
        │   • 1 Task template  4 steps, 1 needs approval                 │
        │   • 1 Schedule       Mondays 07:00                             │
        │   • Guardrails       Asks before: send a message, spawn an     │
        │                      agent, change a budget                    │
        │                                                                │
        │  It will not send anything, spend anything above your caps, or │
        │  change agents you already have.                               │
        │                                                                │
        │                              [ Cancel ]      [ Create it ]     │
        └────────────────────────────────────────────────────────────────┘
```

Copy, verbatim:

- Heading: `Set up "<title>"`
- Field labels: `Name it` · `Run it` · `For`
- List heading: `This will create`
- Reassurance line: `It will not send anything, spend anything above your caps, or change agents
you already have.`
- Buttons: `Cancel` · `Create it`
- Duplicate warning (FR-3.6): `You already run this once. A second copy runs on its own cadence
and costs the same again.`
- Collision note (FR-27): `You already have an agent called "Ops reporter" — this one will be
"Ops reporter 2".`

### 6.8 Adoption in progress, and adopted

```
┌────────────────────────┐   ┌──────────────────────────────────────────────────────┐
│ 📊 Weekly operations   │   │ 📊 Weekly operations report                          │
│    report              │   │    Active · next run Monday 07:00                    │
│ ⟳ Setting up…          │   │    4 runs in the last 30 days · $0.16                │
│   Creating the agent   │   │                                                      │
│   ▮▮▮▮▮▮▯▯▯▯  3 of 5   │   │ Agent  Ops reporter →    Skills  2 →                 │
└────────────────────────┘   │ Task template  4 steps → Schedule  Mondays 07:00 →   │
                             │                                                      │
                             │ Last run  Mon 07:00 · succeeded · 1 document →       │
                             │                        [ Pause ] [ Retire ] [ ⋯ ]    │
                             └──────────────────────────────────────────────────────┘
```

Progress step labels, verbatim, in order: `Creating the agent` · `Installing skills` ·
`Building the task template` · `Setting the guardrails` · `Scheduling it`.

### 6.9 Adoption failed

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ ⚠  Setup incomplete                                                                  │
│    Could not install the skill "weekly-rollup" — the skills catalogue did not answer. │
│                                                                                      │
│    Created so far                                                                    │
│      ✓ Agent            Ops reporter →                                               │
│      ✓ Skill            Cite it → (bound)                                            │
│      ✗ Skill            weekly-rollup — not installed                                │
│      – Task template    not created                                                   │
│      – Schedule         not created                                                   │
│                                                                                      │
│    [ Try again ]   [ Remove what was created ]   [ Leave it as is ]                  │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

### 6.10 Remove what was created

```
        ┌────────────────────────────────────────────────────────────────┐
        │  Remove what "Weekly operations report" created           [✕]  │
        │                                                                │
        │  Nothing is removed unless you tick it.                        │
        │                                                                │
        │  ☐ Agent           Ops reporter                                │
        │                    ⚠ Renamed since setup — review before       │
        │                      removing. It may be doing other work.     │
        │  ☐ Skill binding   Weekly rollup → Ops reporter                │
        │  ☐ Skill binding   Cite it → Ops reporter                      │
        │  ☐ Task template   Weekly ops report (4 steps)                 │
        │  ☐ Schedule        Mondays 07:00                               │
        │                                                                │
        │  The 4 documents this playbook produced are kept. Output is    │
        │  never removed here.                                           │
        │                                                                │
        │                     [ Cancel ]      [ Remove 0 items ]         │
        └────────────────────────────────────────────────────────────────┘
```

The primary button's label counts live: `Remove 0 items` (disabled) → `Remove 3 items`.

### 6.11 Over-limit states

```
│  [ You have 25 playbooks running ]   ← primary, disabled                             │
│  Retire one to add another.                                    See what's running →  │

│  [ Limit reached ]                   ← primary, disabled                             │
│  3 copies of one playbook per workspace. Retire one first.                           │
```

### 6.12 Workflows sub-page and a run

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│  ← Catalog        Workflows                                                          │
│  A workflow is a graph of steps you save once and re-run.                            │
│  ┌──────────────────────────────────────────────────────────────────────────────┐    │
│  │ Item enrichment walk    Active   6 nodes  12 runs  last 2h ago     [ Run ]    │    │
│  │ Weekly digest graph     Draft    4 nodes   0 runs  never           [ Run ]    │    │
│  │ Old import walk         Archived 9 nodes   3 runs  4 Aug        Reactivate →  │    │
│  └──────────────────────────────────────────────────────────────────────────────┘    │
│                                                                                      │
│  ── one run ──────────────────────────────────────────────────────────────────────   │
│  Run 4f2c · succeeded · 1m 42s · 6 of 6 steps                                        │
│    1  fetch          noop            ok      0.2s                                    │
│    2  ask            ai.ask          ok      31s      → chose "enrich"               │
│    3  search-kb      kb.search       ok      1.1s     → 4 documents                  │
│    4  delegate       agent.delegate  ok      68s      → run 91ab →                   │
│    5  decide         ai.ask          ok      9s       → chose "publish"              │
│    6  done           noop            ok      0.1s                                    │
│  Output  (truncated at 8 KB)                                                         │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

### 6.13 Keyboard affordances

| Key                | Where                  | Does                                           |
| ------------------ | ---------------------- | ---------------------------------------------- |
| `/`                | index                  | Focus search                                   |
| `Esc`              | search focused         | Clear the search and blur                      |
| `←` `→` `↑` `↓`    | a card focused         | Move focus within the section grid             |
| `Tab`              | index                  | Move to the next section's first card          |
| `Enter`            | a card focused         | Open its detail                                |
| `Enter`            | a workflow row focused | Open its run history                           |
| `Esc`              | any sheet              | Close and return focus to the opener           |
| `⏎` on `Create it` | setup sheet            | Confirm — the only key that starts an adoption |

Nothing in this epic binds a global single-key shortcut. `/` is scoped to the catalogue page and
released when a text field has focus.

## 7. Out of scope

1. **A playbook editor.** v1 has no way to author or fork a playbook in-product. Playbooks are
   catalogue data supplied by a provider. Authoring is a follow-up.
2. **A visual workflow builder.** The Workflows section **lists, runs and traces** saved graphs.
   It does not let anybody draw one. Authoring graphs stays where it is.
3. **Rewriting the five existing template surfaces.** They keep their routes and behaviour. This
   epic links to them. Their missing internationalisation and the unreachable `company` template
   kind are known gaps and are not fixed here.
4. **Cross-workspace or public sharing of adoptions.** An adoption is scoped to one workspace.
5. **Editing a playbook's steps at adoption time.** The setup sheet edits three fields (FR-30).
   Everything else is the playbook's own definition. Once adopted, the created Task template and
   Agent instructions are ordinary rows the owner edits normally.
6. **Automatic graduation of guardrails.** The suggestion is offered (FR-49) and never applied.
7. **Removing produced output.** Documents, Missions, Tasks and drafts a playbook produced are
   never offered for bulk removal.
8. **Billing enforcement.** Cost is displayed. Caps and credits are [AW-17](../README.md#3-epics).
9. **Prebuilt company packages.** The org-template catalogue is a separate surface and stays one.
10. **A recommendation engine.** Section order and card order are fixed (FR-5); "playbooks people
    like you adopted" is not in v1.

## 8. Acceptance criteria

A reviewer can run this list top to bottom against a running build.

**Browsing**

- [ ] `Catalog` appears in the sidebar and opens a page headed `What you can do`.
- [ ] Exactly five sections render, in the order Playbooks, Skills, Workflows, Task templates,
      Starting points.
- [ ] Each section shows at most 6 cards and a `See all (N)` control whose `N` matches the true
      total.
- [ ] Killing the skills catalogue source degrades only the Skills section; the other four render.
- [ ] `/` focuses search; typing `week` narrows all five sections and shows per-section counts;
      a no-match search shows the empty-search copy and a `Clear` control.
- [ ] Category chips and readiness chips both filter, and combine.

**Playbook content**

- [ ] 8 playbooks ship built in; at least 5 show `Ready` on a workspace with default plugins only.
- [ ] Every detail page renders all eight labelled sections (`WHEN IT RUNS` … `WHAT IT MAY DO
ALONE`) with non-empty content.
- [ ] Every step that stops for a human is marked with the `asks you` flag in the step list.
- [ ] A catalogue entry with an over-long title is truncated at 120 characters, and an entry with
      an invalid slug does not render at all.

**Readiness and preflight**

- [ ] With no search plugin enabled, `Market watch brief` reads `Not ready — 1 required connection
missing`, names `Search`, and its primary button is disabled with an actionable label.
- [ ] Enabling a search plugin and returning within 60 s shows `Ready`.
- [ ] Preflight creates nothing: run it 20 times and the agent, skill, task-template and schedule
      counts are unchanged.
- [ ] Preflight against a workspace that already has an agent with the target name returns a
      de-duplicated name, and the sheet shows the collision note.

**Adoption**

- [ ] `Set it up` → sheet → `Create it` returns in under 1 s with a `provisioning` adoption.
- [ ] Within 60 s the adoption is `active` and links to exactly the rows the sheet itemised —
      no more, no fewer.
- [ ] The created Agent's guardrails are `require_approval`, whatever the playbook's graduated
      posture says.
- [ ] Two simultaneous `Create it` requests for the same slug produce one adoption and one Agent;
      the loser gets a conflict with a link.
- [ ] Killing the skills source mid-provision leaves a `failed` adoption listing what was created;
      `Try again` completes it without creating a second Agent.
- [ ] An adoption artificially stuck in `provisioning` is moved to `failed` within 15 minutes.
- [ ] At 25 active adoptions, every un-adopted playbook's button is disabled with the ceiling copy.
- [ ] At 3 copies of one slug, that playbook's button is disabled with the copy-limit copy.
- [ ] Adoption writes one activity-log entry naming the playbook and the row count.

**Living with it**

- [ ] `Pause` stops the schedule; the Agent's own status is unchanged.
- [ ] `Retire` shows the "everything is kept" confirmation and moves the adoption to the collapsed
      `Retired` group.
- [ ] `Remove what was created` opens with every checkbox unchecked and the primary button reading
      `Remove 0 items` and disabled.
- [ ] A renamed artefact carries the `Changed since setup` note; a deleted one is reported
      `already gone` and does not fail the batch.
- [ ] Produced Knowledge Base documents never appear in the removal list.
- [ ] An adoption with runs shows a 30-day run count and a cost to 2 decimals; with none it shows
      `No runs yet`.
- [ ] Three consecutive failed runs produce a persistent warning with the last failure reason.
- [ ] After 14 days with 0 rejections, one graduation suggestion appears; dismissing it hides it
      for 30 days; nothing changes without a confirm.
- [ ] Opening the created Agent shows which playbook and adoption created it.

**Workflows, task templates, starting points**

- [ ] Saved workflows list with name, status, node count, run count and last run.
- [ ] `Run` on an active workflow returns in under 1 s with a queued run; the trace shows per-node
      outcome, edges traversed and decision points.
- [ ] `Run` on an archived workflow is refused with the reactivate message.
- [ ] `Use it` on a task template creates the parent Task plus one sub-task per step with the
      dependency edges intact.
- [ ] `Starting points` links to the existing template pages and duplicates none of their controls.

**Access, i18n, accessibility**

- [ ] A read-only member sees no `Set it up`, `Pause`, `Retire`, `Run` or `Use it` control.
- [ ] Every visible string resolves from a translation key; switching locale to one with no
      translation falls back to English without a missing-key warning in the console.
- [ ] Full keyboard walk of the index, a detail page, the setup sheet and the removal sheet with
      no mouse; focus returns to the opener on every `Esc`.
- [ ] Readiness is legible with colour disabled; every chip carries text.
- [ ] An automated accessibility pass over the index and detail page reports no serious or
      critical violations.

## 9. Open questions

- **[NEEDS CLARIFICATION: where the hosted playbook catalogue lives]** The built-in catalogue
  ships with the build. The remote source (which repository, public or private, and its refresh
  and pinning policy) mirrors the pattern the skills catalogue already uses, but the exact
  coordinates and whether v1 ships a remote source at all is a launch decision, not a design one.
- **[NEEDS CLARIFICATION: whether adoption is per-user or per-organization]** This spec scopes an
  adoption to the workspace and caps at 25 per workspace. If two members of one organization each
  want their own copy of the same playbook, today they consume two of the three per-slug copies.
  Whether that is the right model, or whether adoptions should be personal with an organization
  rollup, needs a decision before P2.
- **[NEEDS CLARIFICATION: the cost estimate's provenance]** `costBand` is declared by the playbook
  author. Nothing verifies it against reality. Should the catalogue eventually replace the
  declared band with the observed median across all adoptions of that playbook, and if so, is that
  aggregate acceptable to compute across organizations?
- **[NEEDS CLARIFICATION: what a playbook may declare as a required connection]** v1 accepts
  capability names only (FR-15). Some jobs genuinely need a specific provider (a particular
  storage backend, a particular git host). Do we allow a playbook to require a named provider, and
  if so how do we stop the catalogue becoming a list of hardcoded plugin ids?
- **[NEEDS CLARIFICATION: the Work scope of a playbook]** FR-30 lets the sheet pick a Work. Some
  playbooks are workspace-wide, some are per-Work, and one playbook could reasonably be either.
  Should the definition declare which, or should the sheet always ask?
- **[NEEDS CLARIFICATION: whether a playbook may be adopted by an agent rather than a person]**
  The platform advertises machine-readable self-description and an agent-to-agent registration
  path. Exposing adoption over that surface is plausible and deliberately not designed here.
- **[NEEDS CLARIFICATION: graduation evidence threshold]** FR-49 uses 14 days and 0 rejections.
  Both numbers are judgement calls made without data. They should be revisited once real adoption
  telemetry exists.
