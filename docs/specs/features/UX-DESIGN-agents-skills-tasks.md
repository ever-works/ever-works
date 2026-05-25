# UX Design — Agents, Skills, Tasks

**Status**: `Draft` · 2026-05-25
**Audience**: Product, design, frontend engineering. PM-lens companion to the four feature specs. Covers what the new pages look like, what they say, when users hit them, and how the cost / safety story is communicated.

> **Why this doc.** The feature specs say "Cards / Table / Kanban toggle" but never show the cards. The plans say "/agents/[id]/dashboard" but never show what's on it. Empty states, microcopy, onboarding, error/loading/success states — none of those are spec'd. This doc fills that.
>
> Wireframes here are ASCII / Mermaid — not Figma. Treat them as anchoring sketches; design will iterate.

---

## 1. The "wow moment" for a first-time user

The user's first contact with Agents must end with **a tangible result in under 5 minutes**, not just a configured row in a DB. We define the wow moment as:

> The user has created an Agent named after themselves or a role they care about (CEO / Editor / Researcher), seen its first heartbeat run complete, and observed it produce visible output (a Task created, a chat message, a file edited) — all without leaving the Agents tab.

This anchors three design decisions:

1. **First-create dialog ships starter prompts**, not blank fields. A user picking "CEO" should get a default `SOUL.md` populated; they can edit before save.
2. **The first heartbeat runs immediately on save** — don't make the user wait for a cron tick. The save button is "Create + Run first heartbeat now."
3. **The Agent's dashboard shows live-run state and the run's output prominently**, so the wow moment is visible.

Tracked: see [QUESTIONS P1](../QUESTIONS-agents-skills-tasks.md#p1--starter-prompts-vs-blank-on-agent-create) for whether to ship starter prompts.

---

## 2. Sidebar and discovery

### 2.1 Sidebar after this feature

```
┌────────────────────────────┐
│  Ever Works                │
├────────────────────────────┤
│  ▢ Dashboard               │
│  ◇ Missions       (3)      │  ← existing
│  ✱ Ideas          (12)     │  ← existing
│  ▤ Works          (4)      │  ← existing
│  ✓ Tasks          (28)  NEW│
│  ☺ Agents         (5)   NEW│
│  ⬚ Templates              │
│  ⚉ Plugins                │
│  ◈ Skills              NEW │
│  ⟳ Activity               │
│  ✦ Settings               │
└────────────────────────────┘
```

Each item shows a count when > 0.

### 2.2 Discovery from Dashboard

On the main dashboard, three new affordances introduce the features to existing users:

- **Tile row gains "Agents enabled" and "Tasks in progress" tiles** (additive to the existing [Missions][Ideas][Works][Items][Sites][Spend] row).
- **Empty Agents tile copy** (when count = 0): "Try Agents — name an AI worker, give it a job. [Get started →]"
- **"Recent Tasks" block** below "Recent Works", same visual treatment.

---

## 3. The `/agents` list page

### 3.1 Empty state (zero agents)

```
╭─────────────────────────────────────────────────────────────╮
│                                                             │
│           🤖                                                │
│                                                             │
│           No Agents yet                                     │
│                                                             │
│           Agents are AI workers you name and put to work    │
│           on your Missions, Ideas, or Works.                │
│                                                             │
│           A "CEO" Agent might check your Missions weekly    │
│           and suggest next moves. A "PR Reviewer" Agent     │
│           might review every pull request you open.         │
│                                                             │
│           [ + New Agent ]  [ Start by creating CEO Agent ] │
│                                                             │
╰─────────────────────────────────────────────────────────────╯
```

The **"Start by creating CEO Agent"** button takes the first-time user straight to the wow moment without any decisions. It creates an Agent named `CEO` at **tenant scope** using the CEO template from the [`ever-works/agents`](https://github.com/ever-works/agents) template repo (default account AI provider, weekly heartbeat, sensible default permissions). After create, the user lands on `/agents/ceo` and the first heartbeat is dispatched immediately.

This deliberately bypasses the multi-step create dialog: zero choices, one click, real Agent.

### 3.2 Populated list

```
┌────────────────────────────────────────────────────────────────────────┐
│  Agents          [ Cards | Table | Kanban ]      All ▾   [+ New Agent]  │
│  Filter: All · Active · Paused · Error      Scope: All ▾                │
│                                                                          │
│  ┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐            │
│  │ CE  CEO          │ │ VP  VP Engineer  │ │ ED  Editor       │            │
│  │     Tenant       │ │     Mission      │ │     Tenant       │            │
│  │     ● active     │ │     ● active     │ │     ⏸ paused    │            │
│  │                  │ │                  │ │                  │            │
│  │ Daily 9am UTC    │ │ Mon 10am UTC     │ │ —                │            │
│  │ $3.20/$20 month  │ │ $12.40/$30 month │ │ $0.00/$10 month  │            │
│  │ 12 runs · 0 fail │ │ 4 runs · 0 fail  │ │ 2 runs · 1 fail  │            │
│  └─────────────────┘ └─────────────────┘ └─────────────────┘            │
│                                                                          │
│  ... (rest below the fold)                                              │
└────────────────────────────────────────────────────────────────────────┘
```

The colored avatar circle uses initials of the Agent name by default; color hashed from the slug. The user can switch to **icon picker** (lucide-react curated set) or **image upload** (when tenant storage enabled) from the Agent's Settings tab — see [features/agents/spec.md §5.10a](agents/spec.md) for the three avatar modes shipped in v1.

### 3.3 Kanban view

Six columns: `Draft`, `Active`, `Running`, `Paused`, `Error`, `Archived` — derived from the lifecycle states. Drag-drop changes status (with toast confirmations for state-machine-allowed moves).

---

## 4. The Agent create dialog

### 4.1 Default starter ("CEO" template — example)

A 2-step modal. Step 1 picks a starter or "blank"; step 2 lets the user edit before save.

```
╭─────────────────────────────────────────────────╮
│  New Agent                              ╳        │
│                                                  │
│  Pick a starting point:                          │
│                                                  │
│  ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐    │
│  │ CEO    │ │ VP-Eng │ │Researcher│ │PR-Rev│    │
│  │ Strategic │ Decides│ │ Investigates│Reviews│    │
│  └────────┘ └────────┘ └────────┘ └────────┘    │
│                                                  │
│  ┌────────┐ ┌────────┐ ┌────────┐                │
│  │Editor  │ │ Designer│ │ Blank │                │
│  │ Polishes│Conceives│ │       │                │
│  └────────┘ └────────┘ └────────┘                │
│                                                  │
│                              [Cancel] [Next →]   │
╰─────────────────────────────────────────────────╯
```

**Starters are external — they live in a separate community-friendly repo: [`ever-works/agents`](https://github.com/ever-works/agents).** Each template is a folder containing `agent.yml` + `SOUL.md` + `AGENTS.md` + `HEARTBEAT.md` + `TOOLS.md`, optionally a `skills/` subfolder with bundled skill MD files. The 6 starters above are the curated set Ever Works ships; the community can PR additional templates (Sales Lead, Compliance Officer, Game Designer, etc.) without touching the platform repo.

When the user picks a template, the platform `git clone --depth 1` the agents repo (cached for 1h), reads the chosen folder, and **copies** the MD files into the scope's repo at `.works/agents/<chosen-slug>/`. For tenant scope without a control repo, files are written inline to DB columns (per [ADR-008](../decisions/008-tenant-control-repo-deferred-to-v2.md)). Modifications to the user's local copy never propagate back to the source repo.

This deliberately diverges from Skills (in-monorepo, [ADR-007](../decisions/007-skill-catalog-in-monorepo.md)) — see [ADR-011](../decisions/011-agent-templates-in-separate-repo.md) for the rationale (community contribution velocity, larger volume).

### 4.2 Step 2 — fill the details

```
╭─────────────────────────────────────────────────────────╮
│  New Agent — CEO                              ╳          │
│                                                          │
│  Name              [CEO____________________]             │
│  Title (optional)  [Chief Executive Officer__]           │
│                                                          │
│  Capabilities                                            │
│  ┌──────────────────────────────────────────────┐        │
│  │ You're the CEO. Each Monday check the        │        │
│  │ business, find the most important thing,     │        │
│  │ delegate one task to the right Agent.        │        │
│  │ [edit later in Instructions tab]             │        │
│  └──────────────────────────────────────────────┘        │
│                                                          │
│  Scope                                                   │
│  ◉ Tenant — available to all                            │
│  ○ Mission [ cats-business-mission ▾ ]                  │
│  ○ Work    [ select... ▾ ]                              │
│                                                          │
│  AI Provider                                             │
│  [ Use account default (Anthropic claude-sonnet-4-6) ▾ ] │
│                                                          │
│  Heartbeat                                               │
│  ◉ Daily       at [9:00 UTC ▾]                          │
│  ○ Weekly                                                │
│  ○ Custom cron                                           │
│  ○ Manual only — I'll trigger it                         │
│                                                          │
│  Budget cap                                              │
│  $[20] per [month ▾]   ☐ Allow overage                  │
│                                                          │
│  Permissions                                             │
│  ☑ Can assign tasks to other Agents                      │
│  ☐ Can create sub-agents                                 │
│  ☐ Can edit own files                                    │
│  ☐ Can commit to repo                                    │
│  ☐ Can call external tools (search, screenshot, …)       │
│                                                          │
│  ☑ Run first heartbeat now after creating                │
│                                                          │
│  [ ← Back ]                          [ Create Agent ]    │
╰─────────────────────────────────────────────────────────╯
```

Notes:
- "Use account default" is **the first option**, always pre-selected.
- "Run first heartbeat now after creating" is **checked by default** to deliver the wow moment.
- The permissions list shows in plain English; defaults are conservative (all off except the most useful for the starter).

### 4.3 Microcopy decisions

- "Heartbeat" → never explained except via tooltip on the field: *"How often your Agent wakes up to think about what to do next. Pick `Manual only` to control it by hand."*
- "Capabilities" → never called "system prompt." That terminology bleeds into the SaaS too much.
- "Budget cap" → never called "rate limit" or "token cap." Cost is dollars.

---

## 5. The `/agents/[id]` detail page

### 5.1 Page layout (Dashboard tab)

```
┌─────────────────────────────────────────────────────────────────────┐
│  ← Agents      ☺ CEO  ● active                                       │
│                Chief Executive · Tenant scope                        │
│                                                                       │
│  [ Run heartbeat now ] [ Pause ] [ Assign Task ] [ ··· more ]        │
│                                                                       │
│  Dashboard  |  Activity  |  Instructions  |  Skills  |  Budgets  |   │
│  Settings                                                             │
│                                                                       │
│  ┌─────────────────────────┬───────────────────────────────────────┐ │
│  │ Live status              │ This month                            │ │
│  │ ─────────────            │ ─────────────                         │ │
│  │ ● Idle. Next run:        │ $3.20 of $20.00 budget                │ │
│  │ Monday 9:00 UTC          │ ████░░░░░░░░░░  16%                   │ │
│  │ (in 2 days, 14 hours)    │                                       │ │
│  │                          │ 12 runs · 0 failed                    │ │
│  │ Last run: Yesterday      │ Avg cost / run: $0.27                 │ │
│  │ at 9:00 UTC — completed  │                                       │ │
│  │ "Reviewed weekly Mission │ [ View breakdown → ]                  │ │
│  │ progress; assigned 1     │                                       │ │
│  │ task to VP-Engineering"  │                                       │ │
│  └─────────────────────────┴───────────────────────────────────────┘ │
│                                                                       │
│  Run activity — last 30 days                                          │
│  ──────────                                                           │
│  [bar chart, one bar per day]                                         │
│                                                                       │
│  Recent tasks the CEO is on                                           │
│  ──────────                                                           │
│  ⬜ T-42  Pick screenshot plugin — assigned to VP-Eng — in progress    │
│  ✅ T-39  Q3 roadmap one-pager — done                                 │
│  ⬜ T-37  Investigate Stripe integration — blocked                     │
└─────────────────────────────────────────────────────────────────────┘
```

### 5.2 Live-running state

When a run is in flight:

```
┌─────────────────────────────┐
│ Live status                  │
│ ─────────────                │
│ ● Running for 12s            │
│ Step: assembling prompt      │
│                              │
│ [ Cancel run ]               │
│                              │
│ ─ Log ─                      │
│ 12s ▸ loaded 4 skills        │
│ 11s ▸ assembled prompt 4 KB  │
│ 10s ▸ called provider...     │
└─────────────────────────────┘
```

The log tail polls every 1s during in-flight runs (slightly tighter than the 5s activity feed). When the run terminates, polling drops back to 5s.

### 5.3 The Instructions tab (5-file editor)

```
┌──────────────────────────────────────────────────────────────────┐
│  Instructions                                                     │
│                                                                   │
│  [ SOUL.md ] [ AGENTS.md ] [ HEARTBEAT.md ] [ TOOLS.md ] [agent.yml]│
│                                                                   │
│  ─ SOUL.md ─                              Last saved 2 minutes ago│
│  ┌───────────────────────────────────────────────────────────┐    │
│  │ # Who I am                                                 │    │
│  │                                                            │    │
│  │ I am the CEO of {{tenant.name}}. My job is to find the     │    │
│  │ most important thing to do this week and make sure it gets │    │
│  │ done.                                                       │    │
│  │                                                            │    │
│  │ I write in short sentences. I prefer specifics to vague    │    │
│  │ goals. I am skeptical of long plans.                       │    │
│  └───────────────────────────────────────────────────────────┘    │
│                                                                   │
│  ⓘ This file lives in your Mission repo at                        │
│    .works/agents/ceo/SOUL.md                                      │
│                                                                   │
│                                       [ Discard ] [ Save changes ]│
└──────────────────────────────────────────────────────────────────┘
```

- The 5 tabs are pills, not nested tabs. The body is a single Tiptap editor showing one file at a time.
- Footnote shows the storage path (Git for Mission/Work-scope, "(stored in your account)" for Tenant-scope).
- Autosave at 800ms debounce; the save button is only visible when there are unsaved changes (after autosave kicks in, button hides).
- A small "View history" link (top-right of file content) opens a side panel with last 10 saves (read from activity log).

### 5.4 The Budgets tab

```
┌──────────────────────────────────────────────────────────────────┐
│  Budgets                                                          │
│                                                                   │
│  Cap                                                              │
│  $[20] per [month ▾]   ☐ Allow overage with warning              │
│                                                                   │
│  This period — May 2026                                          │
│  ──────                                                          │
│  Used:    $3.20                                                  │
│  Remaining: $16.80                                               │
│  Progress: ████░░░░░░░░░░░░  16%                                 │
│                                                                   │
│  Next reset: Sat Jun 1, 00:00 UTC                                │
│                                                                   │
│  Spending by day — last 30 days                                  │
│  ──────                                                          │
│  [bar chart with daily $ amounts]                                │
│                                                                   │
│  ⚠ When you hit the cap, the Agent stops calling the AI until    │
│     the next reset.                                              │
│                                                                   │
│                                                  [ Save changes ]│
└──────────────────────────────────────────────────────────────────┘
```

Two yellow warning lines at top + bottom are the cost-transparency lever. **No surprise spending** is a hard product promise.

---

## 6. The `/tasks` page

### 6.1 Kanban view (default for many users)

```
┌─────────────────────────────────────────────────────────────────────┐
│  Tasks       [ Cards | Table | Kanban ]   All ▾  [+ New Task]        │
│  Filter: Open · Blocked · Done · Cancelled    Scope: All ▾           │
│                                                                       │
│ Backlog (3)  │ Todo (5)    │ In Progress (4)  │ In Review (2) │Blocked│
│              │             │                  │               │       │
│ ┌─────────┐  │ ┌─────────┐ │ ┌─────────────┐  │ ┌──────────┐  │       │
│ │T-42 p1  │  │ │T-40 p2  │ │ │T-37 p0      │  │ │T-32 p2   │  │       │
│ │Pick     │  │ │Schedule │ │ │Stripe       │  │ │Migrate   │  │       │
│ │screen-  │  │ │Q3 plan  │ │ │integration  │  │ │schema    │  │       │
│ │shot     │  │ │meeting  │ │ │             │  │ │          │  │       │
│ │@VP-Eng  │  │ │@self    │ │ │ ☺ @CEO + 2  │  │ │ ☺ @VP-Eng│  │       │
│ │● ●●     │  │ │● ●      │ │ │● ●● ●●      │  │ │● ●●      │  │       │
│ └─────────┘  │ └─────────┘ │ └─────────────┘  │ └──────────┘  │       │
│ ...          │ ...         │ ...              │ ...           │       │
└─────────────────────────────────────────────────────────────────────┘
```

- Priority dots: `p0` red, `p1` orange, `p2` yellow, `p3` gray, `p4` light gray.
- Assignee avatars in card footer; `☺` icon prefix marks Agents.
- Drag-drop transitions; blocker checks happen before commit, surface a toast on rejection.

### 6.2 Task detail (single scrollable page)

```
┌──────────────────────────────────────────────────────────────────┐
│  ← Tasks    T-42  Pick screenshot plugin              p1 in-progress│
│                                                                   │
│  Edit title ↑                                                     │
│                                                                   │
│  Sidebar (right column)              Body (left column)           │
│  ─────────────                       ─────────────                │
│  Status   [In Progress ▾]            Description                  │
│  Priority [p1 ▾]                     ┌──────────────────────────┐ │
│  Labels   [plugins, screenshots ✕]   │ Currently using local    │ │
│  Mission  cats-business              │ extractor. Investigate   │ │
│  Work     cats-directory             │ ScreenshotOne vs Urlbox  │ │
│                                       │ ...                      │ │
│  Assignees                            └──────────────────────────┘ │
│   ☺ VP-Engineering                    [Save autosaved 5s ago]      │
│   👤 you                                                            │
│                                       Sub-tasks (2/3)              │
│  Reviewers                            ✅ T-43  Pricing compare      │
│   👤 Maya                              ⬜ T-44  Spike Urlbox API    │
│                                       ⬜ T-45  Migration plan      │
│  Approvers                                                         │
│   👤 you                              Attachments                  │
│                                       📎 pricing-comparison.pdf    │
│  Blockers                                                          │
│   T-37 ✓                              Activity                     │
│                                       [chronological feed of       │
│                                        events on this task]        │
│  Watchers (3)                                                      │
│   [ Watch ]                                                        │
│                                       Related                      │
│                                       T-26 (similar topic)         │
│                                                                    │
│                                       Chat                         │
│                                       ┌────────────────────────┐   │
│                                       │ ☺ VP-Engineering · 1h   │   │
│                                       │  Checked both pricing   │   │
│                                       │  pages. Recommend       │   │
│                                       │  ScreenshotOne...       │   │
│                                       │                          │   │
│                                       │ 👤 you · 50min            │   │
│                                       │  @vp-engineering yes,    │   │
│                                       │  switch it                │   │
│                                       │                          │   │
│                                       │ ☺ VP-Engineering · 48min  │   │
│                                       │  PR #43 opened...         │   │
│                                       └────────────────────────┘   │
│                                       [ Reply... type @ to mention]│
└──────────────────────────────────────────────────────────────────┘
```

### 6.3 Empty states

`/tasks` with zero tasks: same shape as `/agents` empty. Copy emphasizes "Tasks track work — for you, your team, and your Agents."

Per-scope tabs (Work/Mission/Idea Tasks): empty copy is shorter, no-CTA-button (the parent's "+ New" suffices).

---

## 7. The `/skills` page

### 7.1 Three-section layout

Mirrors the Plugins page UX.

```
┌─────────────────────────────────────────────────────────────────────┐
│  Skills              Search: [____________]   ☐ Installed only       │
│                                                                       │
│  Installed (3)                                                        │
│  ─────────                                                            │
│  ┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐          │
│  │ pr-review        │ │ release-notes    │ │ house-style      │          │
│  │ Catalog v1.0     │ │ Catalog v1.1 ⬆   │ │ Custom           │          │
│  │ Update available │ │                  │ │                  │          │
│  │ Bound to 2       │ │ Bound to 3       │ │ Bound to 4       │          │
│  └─────────────────┘ └─────────────────┘ └─────────────────┘          │
│                                                                       │
│  Available — Platform catalog (10)                                    │
│  ─────────                                                            │
│  ┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐          │
│  │ seo-meta         │ │ kb-summarize     │ │ image-alt-text   │          │
│  │ Catalog v1.0     │ │ Catalog v1.0     │ │ Catalog v1.0     │          │
│  │                  │ │                  │ │                  │          │
│  │ [ Install ]      │ │ [ Install ]      │ │ [ Install ]      │          │
│  └─────────────────┘ └─────────────────┘ └─────────────────┘          │
│                                                                       │
│  ...                                                                  │
│                                                                       │
│  Custom (1)                            [ + New custom skill ]         │
│  ─────────                                                            │
│  ┌─────────────────┐                                                  │
│  │ house-style      │                                                  │
│  │ Custom v1.0      │                                                  │
│  │ Bound to 4       │                                                  │
│  └─────────────────┘                                                  │
└─────────────────────────────────────────────────────────────────────┘
```

### 7.2 Skill detail page (Body + Bindings tabs)

Body tab opens Tiptap. Bindings tab shows a small table:

```
Bound to:
  ☺ CEO Agent           (tenant)        [ Unbind ]
  ▤ Work: cats-directory (Generator)    [ Unbind ]
  ▤ Work: cats-blog      (Generator)    [ Unbind ]
  ◇ Mission: cats-biz    (shared)       [ Unbind ]
```

`+ Attach to ...` opens a picker.

---

## 8. Cost transparency UX

Every new spending surface follows three rules:

1. **Show the cap and current spend BEFORE the action.** The `Run heartbeat now` button has an inline label: `(est. $0.03)`. The Agent dashboard always shows month progress bar.
2. **Yellow warning at 80% of cap; red at 95%; blocked at 100%.** Banner copy: *"Your CEO Agent is at 95% of its $20 budget for May. New runs may be blocked on Sat Jun 1 — adjust below or wait for reset."*
3. **No silent failures.** A blocked run still appears in the activity feed with a clear `Budget exceeded` row + a "Top up" button (deep links to Budget tab).

This addresses the #1 user fear with autonomous AI: surprise bills.

---

## 9. Error / loading / empty states matrix

| Surface                       | Empty                                          | Loading                       | Error                                                    |
| ----------------------------- | ---------------------------------------------- | ----------------------------- | -------------------------------------------------------- |
| `/agents` list                | Card with sample + "+ New Agent" CTA            | Skeleton cards × 6            | "Couldn't load Agents. [Try again]"                       |
| `/agents/[id]/dashboard`      | (Never empty after create)                     | Skeleton blocks               | Per-block error banners + retry                          |
| `/agents/[id]/instructions`   | (Files always exist post-create)               | Skeleton editor               | "Your Mission repo is unreachable. We have a cached copy."|
| `/agents/[id]/activity`       | "No runs yet. The next tick runs Mon 9am UTC." | Skeleton feed rows            | Same as activity feed today.                              |
| `/agents/[id]/budgets`        | (Always populated)                             | Skeleton sparkline            | "Budget data unavailable. [Refresh]"                      |
| `/agents/[id]/skills`         | "No skills attached. Browse the catalog →"     | Skeleton cards                | Standard.                                                |
| `/tasks` list                 | "No tasks yet. Try `+ New Task`."              | Skeleton cards                | Standard.                                                |
| `/tasks/[id]`                 | (404 if doesn't exist)                         | Skeleton split-pane           | Standard.                                                |
| `/skills` list                | (Always shows catalog; never empty)            | Skeleton sections             | Standard.                                                |

Loading: skeleton elements, not spinners. Loading should feel like "almost there," not "still nothing."

Error: copy is actionable (always offer a retry / refresh / contact-support route). Never `Error: undefined`.

---

## 10. Notifications UX

Where do users see "Agent paused" / "Task assigned" notifications?

- **In-app bell** in the top nav (existing) — gets new categories (`AGENT`, `TASK`) per the `Notification` entity extension.
- **Email** — gated by user-settings flags (default ON for high-signal events: Agent paused, Task assigned to you; default OFF for low-signal: Task labels changed).
- **No push notifications in v1** (no mobile app).

Notification copy templates:

| Event                                  | Title                                       | Body                                                                  |
| -------------------------------------- | ------------------------------------------- | --------------------------------------------------------------------- |
| `AGENT_PAUSED` (after threshold)       | "Your Agent paused itself"                  | *Your "CEO" Agent paused after 3 consecutive failed runs. [Review →]* |
| `AGENT_BUDGET_EXCEEDED`                | "Agent budget exceeded"                     | *Your "CEO" Agent hit its $20 monthly cap. Budget resets Jun 1. [Adjust →]*|
| `TASK_ASSIGNED`                        | "You were assigned to a task"               | *Maya assigned you to T-42 "Pick screenshot plugin" — p1. [Open →]*    |
| `TASK_AGENT_REPLIED`                   | "Agent replied in T-42"                     | *VP-Engineering posted: "PR #43 opened. Will switch on merge." [Open →]*|
| `SKILL_UPDATE_AVAILABLE`               | "Catalog skill updated"                     | *"seo-meta" has a new version (v1.1). Review changes? [Compare →]*    |

---

## 11. Onboarding flow

The existing onboarding wizard (Mission / Work creation) gains **two new optional steps** appended toward the end. Both are skippable and explicitly framed as such.

### 11.1 New step: "Add Agents (optional)"

After the user has created their Mission/Work in the existing onboarding flow, the wizard surfaces:

```
╭─────────────────────────────────────────────────────────────╮
│  Step 4 of 5 — Add Agents (optional)                          │
│                                                              │
│  Agents are named AI workers — a CEO, a CTO, a PR Reviewer.  │
│  They run on a schedule, handle tasks, and write to your     │
│  repos. Start with one or two; you can always add more.      │
│                                                              │
│  Templates from ever-works/agents:                │
│                                                              │
│  ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐                │
│  │ ☑ CEO  │ │ ☑ CTO  │ │ Editor │ │ Designer│               │
│  │Strategic│Technical│ │Polishes│Conceives │                │
│  └────────┘ └────────┘ └────────┘ └────────┘                │
│  ┌────────┐ ┌────────┐                                       │
│  │ PR-Rev │ │Researcher                                       │
│  │Reviews │ │Investig.│                                       │
│  └────────┘ └────────┘                                       │
│                                                              │
│  ☑ Run first heartbeat now after creating                    │
│                                                              │
│  [ Skip — I'll add later ]            [ Create selected (2) ]│
╰─────────────────────────────────────────────────────────────╯
```

- Default selection: **all unchecked** (user opts in deliberately; no surprise creation).
- "Skip" is given equal visual weight to "Create" — many users will skip and that's fine.
- If the user selects any templates, those Agents are created at tenant scope (the most flexible default; user can re-scope later from the detail page).
- Each selected Agent's MD files are copied from `ever-works/agents/<template>/` into the tenant's storage (DB-inline today per [ADR-008](../decisions/008-tenant-control-repo-deferred-to-v2.md)).
- If "Run first heartbeat now" stays checked, each created Agent gets one immediate run so the user sees activity on their dashboard.

### 11.2 New step: "Add Skills (optional)"

Step 5 — last step before finishing onboarding:

```
╭─────────────────────────────────────────────────────────────╮
│  Step 5 of 5 — Add Skills (optional)                          │
│                                                              │
│  Skills are reusable instructions you can attach to Agents   │
│  or inject into your Work generators. Skip if not sure.       │
│                                                              │
│  Popular from the catalog:                                   │
│                                                              │
│  ☑ pr-review          Review pull requests, post comments    │
│  ☑ seo-meta           Optimize SEO meta tags                  │
│  ☐ release-notes      Draft release notes from PR history    │
│  ☐ image-alt-text     Generate alt text for images            │
│  ☐ kb-summarize       Summarize a KB document                 │
│  ☐ ...                                                        │
│                                                              │
│  [ Browse all 10 → ]                                          │
│                                                              │
│  ─ Auto-attach selected skills to: ─                          │
│  ☑ Agents I created in step 4                                 │
│  ☐ My Works' generators                                        │
│                                                              │
│  [ Skip ]                                       [ Install (2) ]│
╰─────────────────────────────────────────────────────────────╯
```

- Same opt-in posture: default unchecked. Skip is fine.
- Surfaces the most-popular catalog skills (curated subset of ~6) with a "Browse all" link to the full `/skills` page.
- When a user selects skills AND has created Agents in step 4, "Auto-attach" defaults checked — saves a follow-up navigation.

### 11.3 No post-onboarding announcement modal

There is **no separate one-time announcement modal** for existing tenants. The features are discoverable via:

- New sidebar items (Agents, Tasks, Skills) visible immediately after release.
- Dashboard empty tiles ("Agents enabled — 0 · [Get started →]").
- A short blog post / changelog entry on the docs site.
- The Mission/Work create flow re-runs the new wizard steps for tenants who go through it again — they see the Agents and Skills steps as new.

Existing tenants who never re-trigger the wizard can still discover via sidebar + dashboard prompts; we do not interrupt their normal session with a modal.

---

## 12. Multi-user collaboration UX

A Work / Mission can have multiple human members today (OWNER / MANAGER / EDITOR / VIEWER). Adding Agents to a shared Work raises questions:

| Question                                           | Behavior in v1                                                                                    |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Who can create an Agent on a Work?                 | OWNER and MANAGER. EDITOR can attach existing tenant Agents.                                       |
| Who pays for Agent runs?                            | The Agent's `userId` (creator) pays. Cost is visible to all members on the Work's Spend tab.     |
| Who can pause/start an Agent on a shared Work?     | OWNER, MANAGER, and the Agent's creator (`userId`).                                                |
| Who can edit Agent files?                           | OWNER, MANAGER, and the Agent's `userId`. EDITORS see read-only.                                   |
| Who can see the Agent's runs/activity?              | All Work members.                                                                                 |
| Can a non-creator delete/archive the Agent?         | OWNER and MANAGER only.                                                                            |

This puts cost & control with the creator while letting collaborators benefit from the output. See [QUESTIONS B4](../QUESTIONS-agents-skills-tasks.md#b4--can-a-human-work-member-with-role-viewer-see-agents-on-that-work).

---

## 13. Mobile responsiveness

- **Sidebar collapses to a hamburger menu** below 768 px (existing behavior).
- **List pages**: Cards view default on mobile; Kanban view becomes horizontally scrollable on tablet; hidden on phone.
- **Detail pages**: split-pane (sidebar+body) becomes stacked; sidebar metadata moves above body content.
- **Tiptap editors** work on mobile but autosave feedback is more important (slow networks).
- **Chat input** uses native `<textarea>` on mobile (no Tiptap overhead).

v1 mobile is "functional, not delightful." A "mobile companion" pass is post-MVP.

---

## 14. Accessibility

- All clickable elements get aria-labels; all icons get visually-hidden text labels.
- Color encodes status BUT also a textual badge ("Active" / "Paused") for screen-reader users.
- Modal create dialog uses native focus-trap.
- Drag-drop on Kanban falls back to a keyboard-actionable "Move to ▾" button per card.
- Per existing platform accessibility skill: WCAG 2.2 AA target.

---

## 15. Telemetry — what we measure post-launch

| Metric                                              | Why                                                            |
| --------------------------------------------------- | -------------------------------------------------------------- |
| % tenants who create their first Agent within 7d    | Discoverability of the feature.                                |
| % first-Agents using the "Try sample" path           | If high, double down on samples; if low, kill them.           |
| Time-from-create to first-completed-heartbeat        | If > 30s, optimize the wow moment.                            |
| Median budget cap users set                          | Tune defaults.                                                 |
| % runs that fail with `budget_exceeded`              | Default budgets too low?                                       |
| Most-installed catalog skill                         | Curate more like the winners.                                  |
| % tenants using @-mentions in task chat              | Validate the Tasks-as-comms channel assumption.                |
| % cross-scope task assignments                       | Validate the hierarchy story.                                  |
| Agent-run failure rate, p50, p90                    | Quality of starters.                                           |
| Median tokens per Agent run                          | Cost benchmark for default model selection.                    |

PostHog events (in addition to ActivityLog already covering most): `agent_created_via_starter` (with starter slug), `agent_first_heartbeat_completed`, `task_kanban_drag`, `skill_attached_via_search`, `notification_clicked`.

---

## 16. References

- All feature specs: [agents/spec.md](agents/spec.md), [skills/spec.md](skills/spec.md), [task-tracking/spec.md](task-tracking/spec.md)
- [Architecture: agents-skills-tasks.md](../architecture/agents-skills-tasks.md)
- [Architecture: implementation-reuse-map.md](../architecture/implementation-reuse-map.md) — engineering companion
- [user-journeys-agents-skills-tasks.md](./user-journeys-agents-skills-tasks.md) — concrete user stories
- [QUESTIONS-agents-skills-tasks.md](../QUESTIONS-agents-skills-tasks.md) — open product/UX decisions
