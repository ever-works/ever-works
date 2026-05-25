# Open Questions — Agents, Skills, Tasks specs

**Status**: `Open` — for operator (Ruslan) review
**Last updated**: 2026-05-25
**Use**: pick an answer per question (or write your own); I'll fold the answers into the specs and update the PR.

> **How this file is organised.** Questions are grouped by topic, not by spec file. Each question has:
> - **What I'm asking** — one sentence.
> - **Why it matters** — why the answer changes the design.
> - **Options** — concrete choices with the trade-off.
> - **My recommendation** — what I'd pick if forced. Marked `★`.
> - **Where it shows up in code/specs** — file references.
>
> Skim the `★` recommendations first; only dig into a question if you disagree with the recommendation.

---

## A. Storage & files

### A1 — Tenant control repo: ship in v1 or defer to v2?

**What I'm asking.** Tenant-scoped Agents have no natural "owning repo". Should v1 ship a per-user `<user>-control` GitHub repo (created on first Agent creation), OR keep tenant Agents DB-only and offer a "promote to repo" migration later?

**Why it matters.** Affects scope of v1 — control-repo support means ≥1 new feature (signup hook, repo scaffolding, migration UI). Also affects Constitution III (source-of-truth in Git) — DB-only is a deviation.

**Options.**
- ★ **A1-a — Defer.** v1 stores tenant Agent MD files inline in DB TEXT columns (5 columns per agent). Offer a one-click "export to control repo" migration in v2 when control repo lands.
- A1-b — Ship in v1. Adds 1-2 weeks of work but no deviation from Constitution III.
- A1-c — Force users to choose a scope (Mission or Work) for every Agent; no tenant scope in v1.

**Where it shows up.**
- `features/agents/spec.md §3.6` FR-23, §8 Q1
- `architecture/agents-skills-tasks.md §4.5`
- ADR-008 (drafted in this round, defaults to A1-a).

---

### A2 — Skill catalog: in-monorepo or separate repo?

**What I'm asking.** Where does the platform-shipped Skill catalog (~1000+ entries expected long-term) live?

**Why it matters.** Affects how new skills get reviewed/merged, build-time impact, atomic versioning with code.

**Options.**
- ★ **A2-a — In-monorepo** under `apps/api/src/skills/catalog/<slug>/<slug>.md`. Fastest to ship; atomic version with code; same model as Mission Templates catalog already on develop (`packages/agent/src/missions/mission-template.config.ts`).
- A2-b — Separate `ever-works/skills-catalog` repo, mounted at boot. Lower friction for community PRs; need a sync mechanism + version pinning.
- A2-c — DB-seeded from a one-off seeder. Easy to mutate at runtime; loses Git review.

**Where it shows up.** `features/skills/spec.md §1, §3.2, §9 Q1`. ADR-007 (drafted, defaults to A2-a).

---

### A3 — `.works/` subfolder names: confirm naming.

**What I'm asking.** The new per-Agent folder structure I propose:
```
.works/agents/<agent-slug>/
    agent.yml
    SOUL.md
    AGENTS.md
    HEARTBEAT.md
    TOOLS.md
    skills/
        <skill-slug>.md
```
Confirm the four MD filenames AND that we want `agent.yml` (not `metadata.yml`, not `agent.json`).

**Options.**
- ★ **A3-a — Keep as proposed.** `agent.yml` lowercased to match `mission.yml` and `works.yml` precedent.
- A3-b — Rename `AGENTS.md` to something less collision-prone (e.g. `ROLE.md`) since "AGENTS.md" already exists in the repo as a meta-doc for AI agents. Could confuse new contributors.
- A3-c — Drop one of the four MD files (e.g. merge `TOOLS.md` into `agent.yml`).

**Where it shows up.** `architecture/agents-skills-tasks.md §4.3`, `features/agents/spec.md §3.6`.

> Note: AGENTS.md is genuinely ambiguous — there's already a project-level `AGENTS.md` for AI assistants. If a user creates an Agent named "Coordinator" the file becomes `.works/agents/coordinator/AGENTS.md` — the per-agent role description. Not the same thing, but possibly confusing. Worth a rename?

---

## B. Scope, hierarchy, and permissions

### B1 — Should an Agent be able to delete other Agents it created?

**What I'm asking.** `permissions.canCreateAgents` lets an Agent spawn child Agents. Should there be a parallel `canDeleteAgents`?

**Options.**
- ★ **B1-a — No.** Only humans can delete Agents. Lower blast radius; an Agent can be promoted/paused/archived but not destroyed by another Agent.
- B1-b — Yes, but only for child Agents it created (via parent FK).
- B1-c — Yes, full delete capability gated by a separate permission.

**Where it shows up.** `features/agents/spec.md §5, §8 Q2`.

---

### B2 — When tenant-scoped Agent has membership in 3 Missions, can it freely read Mission B's KB while doing work for Mission A?

**What I'm asking.** Cross-scope data visibility for an Agent that's a member of multiple targets.

**Options.**
- ★ **B2-a — Yes, by default.** A tenant Agent is "trusted across its memberships" — it can read KB / activity / spend across all its targets in the same run.
- B2-b — No, per-run scoping. When a tenant Agent runs in the context of Mission A, it only sees Mission A's KB during that run. Crisp blast-radius; needs explicit context-handoff mechanism.
- B2-c — Per-skill permission (e.g. Skill X says "cross-mission read OK"; Skill Y says "single-mission only").

**Where it shows up.** `architecture/agents-skills-tasks.md §3, §5`. **Not yet documented** — need to add.

---

### B3 — Agent-to-Agent communication: forced through Tasks, or allow DMs?

**What I'm asking.** Should Agents be able to chat with each other directly, or always via a Task they share?

**Options.**
- ★ **B3-a — Force through Tasks.** v1 has no Agent ↔ Agent DM channel. If CEO wants to ping VP-Engineering, CEO creates a Task assigning VP-Engineering. Auditable, scoped, gated by `canAssignTasks`.
- B3-b — Allow DMs via a new `agent_messages` table.
- B3-c — Allow DMs but only within scope (Tenant Agents can DM other Tenant Agents; Mission Agents can DM siblings).

**Where it shows up.** `features/agents/spec.md §6 Out of Scope`. Defer to v2 unless you want it now.

---

### B4 — Can a human Work member with role VIEWER see Agents on that Work?

**What I'm asking.** `WorkMember` roles today: OWNER, MANAGER, EDITOR, VIEWER. Does VIEWER see the Agents tab on Work detail?

**Options.**
- ★ **B4-a — Yes, read-only.** VIEWERs see Agents and their runs but can't create, pause, or assign tasks.
- B4-b — No. Agents are only visible to OWNER/MANAGER/EDITOR.

**Where it shows up.** `features/agents/spec.md §3.9`. **Not yet documented** — should be.

---

## C. Runtime & lifecycle

### C1 — Heartbeat tick semantics: what does an Agent do when nothing is assigned?

**What I'm asking.** When the cron fires and the Agent has no pending tasks/chats, what should the run do?

**Options.**
- ★ **C1-a — Read AGENTS.md + HEARTBEAT.md + recent activity + scope state, ask the AI for next action.** Action menu includes: create a task (for itself or another Agent), comment in a chat, edit own file, do nothing. Maps to the "what's the next thing I should do given my role?" question.
- C1-b — No-op unless an explicit task is pending. Heartbeat just polls and exits cheaply.
- C1-c — Configurable per-Agent via an `idleBehavior` enum (`noop | propose | self-improve`).

**Where it shows up.** `features/agents/spec.md §2 S3, §3.3`. Currently underspecified.

---

### C2 — Cancellation: in-flight heartbeat run — does cancel stop the AI call mid-stream?

**What I'm asking.** When user clicks "Cancel run", what gets cancelled?

**Options.**
- ★ **C2-a — Best-effort cancel.** Call `runs.cancel(triggerRunId)` (same as Work generation cancel); AbortSignal propagates; mid-stream call is destroyed; partial usage still recorded.
- C2-b — Wait for AI call to finish, then mark `cancelled` after the response arrives. Safer (no partial state) but slow.
- C2-c — Hard kill the Trigger.dev run; in-flight call may still complete server-side.

**Where it shows up.** `features/agents/spec.md §3.8 FR-37 (Cancel run button)`, `plan.md §10 Phase 3`. **Need to document the specific mechanism.**

---

### C3 — Run-row retention: keep all `agent_runs` forever, or truncate?

**What I'm asking.** Hot-running Agents (1-minute heartbeat) generate ~525k rows/year. Retention policy?

**Options.**
- ★ **C3-a — Keep all by default; ship a daily-rollup table later if it bites.** Same posture as `WorkGenerationHistory` today (kept indefinitely, no rollup). Defer the rollup until we see real load.
- C3-b — Hard cap last N=10000 per Agent; older rows pruned by a nightly job.
- C3-c — Configurable per-Agent.

**Where it shows up.** `features/agents/plan.md §3, §11 Risks`. **Need to add.**

---

### C4 — On `error` status auto-pause: notify user how?

**What I'm asking.** When an Agent crosses `pauseAfterFailures` and goes to `error` status, how is the user told?

**Options.**
- ★ **C4-a — In-app `Notification` row + optional email** (gated by existing `User.emailBudgetAlerts`-style flag, new flag `emailAgentAlerts`). Use the `Notification` entity already on develop with `category: SYSTEM` (or new `category: AGENT`).
- C4-b — In-app only.
- C4-c — Slack/Discord/webhook in addition (defer to v2).

**Where it shows up.** `features/agents/spec.md §2.2 E4, §3.3 FR-13`. **Need to wire to Notification entity.**

---

## D. Cost & budgets

### D1 — Delegated tasks: who pays?

**What I'm asking.** CEO Agent assigns a Task to VP-Engineering Agent. VP-Engineering's heartbeat runs the Task and makes paid AI calls. Whose `agent_budgets` row is debited?

**Options.**
- ★ **D1-a — The executing Agent's budget** (VP-Engineering in the example). Same as today: cost attributes to the entity making the call.
- D1-b — Split: half to CEO, half to VP-Engineering. Confusing accounting; reject.
- D1-c — Configurable per-Task via `paidBy: agentId` field; defaults to executing Agent.

**Where it shows up.** `features/agents/spec.md §3.4`, `features/task-tracking/plan.md §3 / §4 Phase 4`. **Need to document.**

---

### D2 — Budget interval boundary: calendar month (UTC) or rolling 30-day?

**What I'm asking.** When does an Agent's budget reset?

**Context.** Existing `WorkBudget` resets on the **first day of each calendar month at 00:00 UTC** (research confirmed in `BudgetService.getCurrentPeriodStart`).

**Options.**
- ★ **D2-a — Match existing: calendar month UTC.** Consistent across Work / Mission / Idea / Agent budgets; one mental model.
- D2-b — Rolling 30-day per Agent. More complex; small UX benefit.
- D2-c — Configurable per Agent (calendar or rolling).

**Where it shows up.** `features/agents/spec.md §3.4 FR-14-17`, `plan.md §3.1 (AgentBudget)`. ★ Matches existing.

> Note: my AgentBudget entity already lists `intervalUnit: 'hour' | 'day' | 'week' | 'month' | 'unlimited'`. For non-`month` intervals (hour/day/week) we need to decide on anchor — UTC-midnight, Agent-creation-time, or arbitrary user pick.

---

### D3 — Pre-flight cost estimation: how strict?

**What I'm asking.** Before an AI call, we estimate cost (rough token count × model price). If the estimate is above the remaining budget, do we block?

**Options.**
- ★ **D3-a — Block when `(estimated + currentSpend) > cap` and `allowOverage = false`.** Same as `BudgetGuardService` does for Works today.
- D3-b — Always allow the call; settle after with overage warning. Friendlier UX, but risks blowing past cap.
- D3-c — Stricter: block when `currentSpend > 0.95 * cap`, regardless of estimate.

**Where it shows up.** `features/agents/spec.md §2 S6, §3.4 FR-15`. ★ Matches existing.

---

## E. Skills

### E1 — Auto-attach: should new tenant-installed skills auto-attach to ALL the user's Agents?

**Options.**
- ★ **E1-a — No.** Explicit attachment per Agent. Otherwise prompt budget gets noisy fast.
- E1-b — Yes by default; user can opt out per Agent.
- E1-c — Per-skill flag `defaultAttachOnInstall: boolean`.

**Where it shows up.** `features/skills/spec.md §9 Q3`.

---

### E2 — Skill catalog updates: auto-pull new version, or always manual?

**Options.**
- ★ **E2-a — Always manual.** Catalog version bumps surface an "Update available" badge; user clicks to update each instance.
- E2-b — Auto-update minor versions; manual for major.
- E2-c — Per-skill setting `autoUpdate: 'never' | 'minor' | 'all'`.

**Where it shows up.** `features/skills/spec.md §3.2 FR-7`. ★ Matches existing posture.

---

### E3 — `allowed-tools` frontmatter: enforce as ACL or descriptive only?

**Options.**
- ★ **E3-a — Descriptive only in v1.** Real ACL stays in Agent's `TOOLS.md` + `permissions.canCallExternalTools`. Skills HINT, don't enforce.
- E3-b — Enforce: when the model invokes a tool not in the skill's allowed-tools, the tool-loop rejects it.
- E3-c — Configurable per Agent.

**Where it shows up.** `features/skills/spec.md §9 Q2`.

---

### E4 — Skill composition: can a skill reference another skill?

**Options.**
- ★ **E4-a — Not in v1.** Skills are flat; no `extends:` / `includes:` field. Keeps the resolver simple.
- E4-b — Allow `extends: <slug>` (single-level only) in frontmatter; resolver injects parent first.
- E4-c — Full DAG-style `includes: [<slugs>]` with cycle detection.

**Where it shows up.** `features/skills/spec.md §6 Out of Scope` — currently OOS.

---

### E5 — Skill localization: how is description shown in user's language?

**Options.**
- ★ **E5-a — English only in v1.** Catalog skills ship English-only; tenant skills are whatever the user writes.
- E5-b — Per-locale frontmatter fields (`description.en`, `description.fr`, …).
- E5-c — Separate sibling files (`pr-review.md`, `pr-review.fr.md`).

**Where it shows up.** Currently undocumented.

---

## F. Tasks

### F1 — Mission/Idea detail pages don't have tab strips today

**What I'm asking.** Confirm finding: research shows Mission detail is a single-column layout with sections (no tabs), and Idea has no dedicated detail page at all. My specs assumed both had tab strips.

**Options.**
- ★ **F1-a — Add the tab strip when adding the new tabs.** Promote Mission detail to a tabbed layout (Overview as default tab + new Agents/Skills/Tasks tabs). Create an Idea detail page from scratch with tabs.
- F1-b — Add new sections to existing single-column layout (no tabs). Page gets long but no UX change.
- F1-c — Mixed: add tabs to Mission detail; defer Idea detail to v2 (no Agents/Tasks tabs on Ideas in v1).

**Where it shows up.** `features/agents/plan.md §6.1`, `features/task-tracking/plan.md §6`, `architecture/agents-skills-tasks.md §12.2`. **Must answer to write correct file paths in tasks.md.**

---

### F2 — Slug scheme: per-user counter, or platform-wide?

**What I'm asking.** Task slugs like `T-12345`. Per-user (each user starts at T-1), or platform-wide (globally unique)?

**Options.**
- ★ **F2-a — Per-user counter.** Cleaner numbers per user; aligns with single-user-tenant posture today; no cross-user leakage.
- F2-b — Platform-wide. Globally unique slugs; easier debug; bad UX (T-485923 from day 1).
- F2-c — Per-scope counters (per Work / per Mission), e.g. `WK-1234/T-12`.

**Where it shows up.** `features/task-tracking/plan.md §3.1 Task.slug`. **Need to lock in.**

---

### F3 — Task → Idea promotion?

**What I'm asking.** A Task grows in scope and looks more like an Idea. Promote it?

**Options.**
- ★ **F3-a — Not in v1.** Defer. v1 just has "linked from" relations.
- F3-b — Allow promotion: a `promoteToIdea(taskId)` endpoint creates a `WorkProposal` row with the Task's content; the Task is marked done with a `promotedToIdeaId` back-pointer.

**Where it shows up.** `features/task-tracking/spec.md §6 Out of Scope` — currently OOS.

---

### F4 — Idea → Work transition: forward Idea-scoped tasks?

**What I'm asking.** Idea X has 3 tasks scoped to it. User accepts the Idea → Work Y is created. Do the tasks follow?

**Options.**
- ★ **F4-a — Yes, automatically.** When `WorkProposal.acceptedWorkId` is set, the platform reassigns `tasks` where `ideaId = X` to `workId = Y` AND keeps `ideaId = X` for trace. The tasks now appear on both the Idea tab and the Work tab.
- F4-b — No — tasks stay on the Idea. Cleaner audit, worse UX (tasks orphan once Idea is done).
- F4-c — Prompt the user at acceptance time.

**Where it shows up.** `features/task-tracking/spec.md §2.1 / §3` — currently undocumented.

---

### F5 — Recurring tasks: out of scope, but reserve schema?

**What I'm asking.** v1 is OOS for recurring tasks. Do we reserve schema columns now to keep the v2 migration small?

**Options.**
- ★ **F5-a — Reserve.** Add `recurrenceRule: string | null` (RFC 5545 RRULE format) + `parentRecurringTaskId: uuid | null` columns on `tasks` from day one. Always null in v1.
- F5-b — Don't reserve. Migrate when we add recurring.

**Where it shows up.** Currently OOS in spec.

---

### F6 — Watchers / subscriptions

**What I'm asking.** Should users be able to "watch" a task they're not assigned to (to get notifications on status changes / chat)?

**Options.**
- ★ **F6-a — Yes, ship in v1.** Adds a `task_watchers` join table. Cheap; users will want this immediately.
- F6-b — No, defer.

**Where it shows up.** Currently undocumented.

---

### F7 — Task description edit history

**What I'm asking.** When a user edits the description of a Task, should we keep the history (like KB documents do)?

**Options.**
- ★ **F7-a — No.** v1: description is mutable, no audit. Activity log captures the user + timestamp of the edit; the content is overwritten.
- F7-b — Yes. New `task_description_revisions` table. Same shape as `kb_history`.
- F7-c — Last N revisions only (e.g. last 10).

**Where it shows up.** Currently undocumented.

---

### F8 — Email / push notifications: which events?

**What I'm asking.** Pick the v1 set.

**Options.** (multi-pick is fine)
- ★ Default ON: Task assigned to you (human assignee), Agent replied to a chat you @-mentioned, Approver: you're an approver on a Task that just transitioned to in_review.
- ★ Default OFF: Task status changes you don't own, Task labels changed, Sub-task added.
- ★ Configurable in user settings: master switch + per-event toggles.

**Where it shows up.** `features/task-tracking/spec.md §2 / §3`. **Need to add.**

---

## G. Activity log + observability

### G1 — Mission tick cap-hit events are NOT persisted today

**What I'm asking.** Research confirmed the "outstanding ≥ cap, skipping" outcome is returned from the Trigger.dev task but **not persisted to DB**. Should we persist it?

**Options.**
- ★ **G1-a — Persist as an activity log row** of new type `MISSION_TICK_SKIPPED_CAP`. Surfaces in the Mission's Activity feed. Fixes the gap.
- G1-b — Leave it Trigger.dev-only. Operators check Trigger.dev dashboard.

**Where it shows up.** This is a fix to develop's current state, not a new feature — flag it for the user to decide whether to land it in the same PR set or separately.

---

### G2 — Per-Task spend: aggregate query or rollup table?

**What I'm asking.** v1 ships `GET /tasks/:id/spend` as an on-demand `SUM(costCents) WHERE taskId = ...` query. For hot tasks that's fine. For dashboards summing across hundreds of tasks, we may want a rollup table.

**Options.**
- ★ **G2-a — On-demand only in v1.** Add rollup only if dashboard latency bites.
- G2-b — Nightly rollup table from day one.

**Where it shows up.** `features/task-tracking/plan.md §4 Phase 4 T39-T40`.

---

## H. UX & sidebar

### H1 — Sidebar order confirmation

Current proposal (after `Works`): `Tasks`, `Agents`, `Templates`, `Plugins`, `Skills`, `Activity`, `Settings`.

Your spec said: "Agents above Templates, below Works", "Skills below Plugins", "Tasks below Works". Confirm:

**Options.**
- ★ **H1-a — `Tasks`, `Agents` between Works and Templates** (current draft).
- H1-b — `Agents`, `Tasks` (swap — Agents above Tasks).
- H1-c — Group: `Works`, `Tasks`, then collapsible `Workshop` group containing `Agents` + `Skills`. More buckets, fewer flat items.

---

### H2 — Cards / Table / Kanban order on `/tasks`

**Options.**
- ★ **H2-a — Default Cards, toggle order Cards → Table → Kanban.** Same default as `/works`.
- H2-b — Default Kanban (most users will want it).
- H2-c — Remember last-used per session via localStorage (already planned).

---

### H3 — Agent card visual: avatar / emoji / initials?

**What I'm asking.** Each Agent gets a small visual. Options:

- ★ **H3-a — Initials in a colored circle** (auto-derived from name, color from a fixed palette by hashing the slug). Zero UX work.
- H3-b — Lucide icon picker (let the user pick `Bot`, `Hammer`, `Briefcase`, etc.).
- H3-c — Allow uploading an image. Storage overhead.

---

## I. Out-of-scope confirmation

Confirm these are out of scope for v1 (we can still add them post-merge of these specs):

- [ ] **I1** — Agent-to-Agent direct messaging (force through Tasks instead).
- [ ] **I2** — External `task-tracker` plugin actually shipped (interface reserved only).
- [ ] **I3** — Skill catalog as a separate repo (in-monorepo for v1).
- [ ] **I4** — Public Agent profile page / marketplace.
- [ ] **I5** — Per-tool ACLs in TOOLS.md (single `canCallExternalTools` flag in v1).
- [ ] **I6** — "Run on event" Agent trigger (heartbeat + task + chat only in v1).
- [ ] **I7** — Time tracking on Tasks.
- [ ] **I8** — Recurring tasks (data hook reserved if F5 = yes).
- [ ] **I9** — Skill composition (E4 = no).
- [ ] **I10** — Custom task status enums per Mission/Work.

---

## J. Naming sanity check

### J1 — "Agent" overload

The project already has:
- `packages/agent/` — the core logic package (named `@ever-works/agent`).
- `apps/api/src/work-agent/` — the autonomous "Work Agent" engine that turns Goals into Ideas.
- The Discord `ever_works_ai` bot session is called an "agent" internally.

Now we're adding **user-defined Agents** as a first-class entity. Risk: "agent" used in 4+ meanings inside one codebase.

**Options.**
- ★ **J1-a — Keep "Agent" for the user-defined entity** (operator's original word). Disambiguate in code with prefixes: `Agent` (new entity), `WorkAgent*` (existing), `@ever-works/agent` (package). In docs, refer to the existing engine as the "Work Agent" verbatim.
- J1-b — Rename the new entity to something else (e.g. `Worker`, `Crewmate`, `Persona`). Painful but reduces overload.
- J1-c — Rename the old "Work Agent" engine to e.g. `WorkPlanner`. Bigger refactor but cleanest.

**Where it shows up.** Everywhere. Already addressed in `architecture/agents-skills-tasks.md §11`.

---

### J2 — Filenames in `.works/agents/<slug>/`

If `AGENTS.md` collides too much with the project-level meta-doc convention, possible renames:

| Current | Alternative                                              |
| ------- | -------------------------------------------------------- |
| AGENTS.md  | ROLE.md, RESPONSIBILITIES.md, ABOUT.md, CHARTER.md    |
| SOUL.md    | VOICE.md, IDENTITY.md, PERSONA.md                     |
| HEARTBEAT.md | LOOP.md, IDLE.md, ROUTINE.md, TICK.md               |
| TOOLS.md   | (probably keep)                                         |

★ Recommendation: **keep all four as-is**. They're memorable; users will quickly understand the convention.

---

## K. Things I'm uncertain enough about that I want your call

### K1 — Do you want me to also draft `features/agents/manifest-schema.md` documenting the `agent.yml` Zod schema in detail?

The Missions feature has `manifest-schema.md` for `.works/mission.yml`. Parallel would be useful — gives implementers a single source of truth for the YAML shape.

**My recommendation**: ★ yes, draft now (~150 lines). Otherwise the spec proposes `agent.yml` but never says what's in it.

---

### K2 — Should I draft `features/agents/UI-MOCKUPS.md` with ASCII / mermaid sketches of each page (list, detail, instructions tab, budgets tab)?

Useful for designers/PMs to react to without a Figma file.

**My recommendation**: ★ yes for the Agents detail page (most novel surface) + the Tasks Kanban (most novel surface).

---

### K3 — Should the spec include a section on **migration of existing users**?

Existing tenants with Works (no Missions/Agents/Skills/Tasks) need to land safely on the new platform after these features ship. Currently no migration plan.

**My recommendation**: ★ add `features/agents-skills-tasks-migration.md` (short, ~50 lines) — confirms default-off behavior, no data backfill, sidebar items hidden behind `FEATURE_AGENTS` flag until tenant opts in.

---

### K4 — Should I look at the existing `mcp-atlassian` MCP integration as a precedent for "Agent talks to external service via MCP"?

Long-shot: the platform has an MCP server (`apps/mcp/`) that already exposes Mission/Idea/Account-usage endpoints. Could an Agent use the same MCP transport to call out to external systems?

**My recommendation**: deferred for v1 — note it in `Out of Scope` and add to v2 roadmap.

---

## L. Security & threats

### L1 — Prompt-injection framing in KB document reads

When an Agent's tool fetches a KB doc, we wrap the body in `<kb-document trust="user-content">` tags with a reminder to ignore embedded instructions ([security-agents-skills-tasks.md §3](./architecture/security-agents-skills-tasks.md)). How aggressive should the framing be?

- ★ **L1-a — Light framing (current draft)**: wrap + single reminder line in system message.
- L1-b — Heavy framing: wrap + reminder + post-fetch sanitization (strip lines starting with "ignore", "system:", "you are", "now do") before injection.
- L1-c — Disable injection of any KB body for Agents that have `canCommitToRepo = true` (require explicit `getKbDocument` tool call instead of auto-injection).

L1-b is invasive (false positives on legitimate content); L1-c is safest but harms UX. v1 ships L1-a; L1-c could be a per-Agent opt-in.

### L2 — Trust tiers in chat messages

Should the prompt-assembly distinguish "chat message from owner of the Agent" vs "chat message from a Work collaborator"?

- ★ **L2-a — No automatic distinction.** All chat messages get the same `<chat-message author="...">` wrap. The Agent's SOUL/AGENTS.md can encode "weight my owner's messages higher."
- L2-b — Automatic trust tier: owner's messages render in `<owner-message>`; others in `<collaborator-message>`. Adds complexity; users may not need it.

### L3 — Secret-scan posture by surface

Two modes proposed in [security §6](./architecture/security-agents-skills-tasks.md):

- **Hard-reject** on agent files + skill bodies (deliberate authoring).
- **Redact** on task descriptions + chat messages (in-the-moment input).

Confirm split, or pick uniformly:

- ★ **L3-a — Split as above.**
- L3-b — Hard-reject everywhere; explain to user inline.
- L3-c — Redact everywhere; least friction.

### L4 — Cross-tenant Agent → MCP exposure

When the platform's MCP server (`apps/mcp/`) eventually exposes Agent/Task tools, should the auth model be:

- ★ **L4-a — Defer the question to v2** when MCP exposure ships.
- L4-b — Lock in now: MCP only sees user-scoped resources; never cross-tenant.

### L5 — Agent commit signing on GitHub

v1: Agents commit unsigned. Should we require signing?

- ★ **L5-a — Unsigned in v1.** Defer until user demand or compliance forces it.
- L5-b — Use the platform's bot GPG key (need to set one up).
- L5-c — Per-user GPG key (user uploads; we sign on their behalf).

---

## M. API surface

### M1 — Idempotency on `POST /tasks/:id/chat`

Should chat-post accept `Idempotency-Key` header? UI double-clicks on send are a known source of duplicate dispatches.

- ★ **M1-a — Yes**. Accept `Idempotency-Key` header; if duplicate, return the existing row.
- M1-b — No; rely on debounce in UI.

### M2 — Idempotency on other POSTs

Confirm:
- `POST /agents`, `POST /tasks`: UNIQUE constraint handles double-submit; no header needed. ★
- `POST /agents/:id/run-now`: rate-limit handles it; no header needed. ★
- `POST /skills/install`: already idempotent (returns existing). ★

If you'd rather have header support on all writes, say so.

### M3 — Chat pagination shape

Existing platform uses offset pagination with `{data, meta:{total,limit,offset}}`. For task chat (reverse-chronological, "scroll up loads older"):

- ★ **M3-a — Use offset for v1 with `order=desc`.** Accept the rare "insertion happens at boundary" duplicate.
- M3-b — Introduce cursor pagination just for chat. Precedent-setting; needs an ADR.

### M4 — API versioning of new endpoints

Existing platform uses `/api/...` (unversioned) except `/api/v1/chat/completions` for OpenAI-compat. Confirm we follow `/api/agents`, `/api/skills`, `/api/tasks` (unversioned) per spec.

- ★ **M4-a — Unversioned, matching platform.**
- M4-b — Version under `/api/v1/agents/...` from day one to keep room.

### M5 — API key access to Agent endpoints

The platform supports both JWT session + API keys. For new endpoints, accept both?

- ★ **M5-a — Session-only in v1.** Adds API-key support when MCP exposure / external automation requires it.
- M5-b — Both session + API key from day one.

### M6 — `Idempotency-Key` storage / retention

If we accept `Idempotency-Key`, where do we store the request→response cache?

- ★ **M6-a — Reuse existing `cache_entries` table** with TTL=24h. The activity-log's `ingestEventId` partial-unique-index pattern works too if we prefer not to add a cache layer.
- M6-b — Dedicated `idempotency_keys` table.

---

## N. Operational & lifecycle

### N1 — Cascade on Mission delete

Today, deleting a Mission cascades to its Ideas via the existing FK. The new Agents/Tasks on that Mission cascade too. **Open question**: the Mission's `missionRepo` on GitHub stays untouched (we don't auto-delete user-owned GitHub repos). Should the UI:

- ★ **N1-a — Prompt the user**: "This will delete the Mission's record. The GitHub repo `<repo-url>` will NOT be deleted — visit GitHub to remove it manually."
- N1-b — Auto-archive the GitHub repo (requires write access; might fail).
- N1-c — Just delete the DB rows silently.

Same question applies to Work delete vs `dataRepo`/`websiteRepo`. (This is somewhat orthogonal to Agents but discovered in round 3.)

### N2 — Agent `pauseAfterFailures` notification channel

When the threshold trips, notify via:

- ★ **N2-a — In-app `Notification` row + email** (gated by `User.emailAgentAlerts` flag we'd add).
- N2-b — In-app only.
- N2-c — Slack / Discord webhook (defer to v2).

### N3 — Dispatcher health monitoring

The new `agent-heartbeat-dispatcher` runs every minute. If it stalls (e.g. Trigger.dev outage), how do we know?

- ★ **N3-a — Reuse existing Sentry breadcrumbs.** Dispatcher writes a "ran" breadcrumb per tick. Sentry alert on missing breadcrumbs (existing pattern).
- N3-b — Add a `/health/agents` endpoint that reports last tick time. Surface on admin page.
- N3-c — PagerDuty integration. Defer.

### N4 — Per-Agent dry-run mode

A `POST /agents/:id/dry-run` would build the prompt + estimate cost + return the would-have-been-sent payload but NOT call the AI provider. Useful during onboarding.

- ★ **N4-a — Ship in v1.** Cheap, valuable for prompt iteration.
- N4-b — Defer to v2.

### N5 — Agent export

`GET /agents/:id/export` returns JSON: meta + 5 MD files. Sharable; round-trippable.

- ★ **N5-a — Ship export in v1; import deferred to v2.**
- N5-b — Skip both for v1.

### N6 — `AgentBudget.intervalUnit` v1 set

The proposed enum was `hour | day | week | month | unlimited`. The existing `BudgetService` only aggregates calendar months. To not under-deliver, v1 supports only:

- ★ **N6-a — `month` and `unlimited` only.** Drop hour/day/week from the v1 schema. Reintroduce when there's demand + service support.
- N6-b — Keep all 5 values in schema; implement aggregator for all from day one.
- N6-c — Keep enum; show an error toast if user picks unsupported value.

### N7 — Concurrent file edit conflict UI

When `editAgentFile` (UI or Agent tool) hits `precondition_failed` due to hash mismatch:

- ★ **N7-a — Toast + "Reload to see the latest" link.** Don't try auto-merge.
- N7-b — Side-by-side merge UI. Overkill for v1.

### N8 — `agent_runs` retention

Hot Agent at 1-min heartbeat → ~525k rows/year/Agent. Keep all?

- ★ **N8-a — Keep all in v1.** Same posture as `WorkGenerationHistory`. Revisit if storage bites.
- N8-b — Hard cap last 10k per Agent + nightly prune. Configurable.

### N9 — `agent-chat-reply` dedup on burst mentions

When a user posts 5 mentions of the same agent in 30s:

- ★ **N9-a — Append-to-context**: if there's an in-flight `agent-chat-reply` run for `(taskId, agentId)`, queue the new mention as additional context to that run rather than dispatching a 2nd.
- N9-b — Dispatch each separately. Costs add up; spam-magnet.

### N10 — Streaming chat response into Task chat

When Agent replies to a chat mention:

- ★ **N10-a — Worker writes chunks via remote-proxy `appendToChatMessage(id, chunk)`.** Polling client (5s) sees growing text. Simple; reuses polling infra.
- N10-b — Full message at end of run. Simpler; worse UX (long pauses).
- N10-c — End-to-end SSE from worker to browser. Best UX; new infra.

### N11 — Mission tick "cap-hit" persistence (out-of-this-PR fix)

Per [G1](#g1--mission-tick-cap-hit-events-are-not-persisted-today): research found Mission tick cap-hit outcomes aren't persisted to DB today. This is a develop bug, not part of Agents/Skills/Tasks scope.

- ★ **N11-a — Split into a separate PR after Agents/Skills/Tasks specs are approved.** Don't conflate.
- N11-b — Fold into this PR set as a one-line additional activity event.

### N12 — Worker bootstrap cost for many Agents

The current `mission-tick` task bootstraps NestJS on each fire. With many active Agents firing per-minute, this multiplies. Are we OK with the existing pattern, or do we want a long-running worker that bootstraps once and processes many?

- ★ **N12-a — Match existing pattern.** Each agent-heartbeat-dispatcher tick is one bootstrap; per-Agent heartbeats are separate runs (each bootstraps). Identical cost profile to existing.
- N12-b — Long-running worker that handles many Agents in one process. Cheaper but new infra and harder to scale across machines.

---

## O. Naming / clarity (round 3 additions)

### O1 — "active" overload

Three different meanings of "active":
- `Agent.status = 'active'` (lifecycle)
- `skill_bindings.injectIntoAgent = true` (the UI says "active")
- `agent.targets = '*'` (UI says "available to all")

Pick one term per surface:
- ★ **O1-a — Lifecycle: `status` (active/paused/error/draft/archived). Skill bindings: `enabled`. Tenant Agent membership: `scope`.** Tightens copy in 3 places.

### O2 — "Heartbeat" — keep or rename?

`Heartbeat` means "Agent's idle tick to decide what to do next" — risks misreading as "health check."

- ★ **O2-a — Keep.** Clarify in empty-state copy.
- O2-b — Rename to `Tick` or `Routine`.

### O3 — `agent.yml` vs uppercase MD files

- ★ **O3-a — Keep proposed convention** (yml lowercase, MD uppercase). Document once in agents/spec.md naming section.

---

## How to answer

Reply with answers in this shape and I'll fold them in:

```
A1: a
A2: a
A3: a + rename AGENTS.md to ROLE.md
B1: a
B2: a — but allow per-skill override (E3-c style)
...
```

Or just leave the `★` defaults if you agree. **Most defaults are conservative — pick differently only if you actively want the alternative.**
