# Review notes — Agents/Skills/Tasks spec set

**Status**: `Review pass 3 — self-critique` · 2026-05-25
**Audience**: Operator + future me reading after sleep. Captures gaps, inconsistencies, and "wait, did we actually answer this?" findings from a critical re-read of rounds 1 & 2.

Findings are graded:

- **🔴 Blocker** — needs a decision before implementation can start.
- **🟡 Tighten** — design is OK but spec wording lets a reader come away wrong.
- **🟢 Polish** — nice-to-have for the spec; not load-bearing.

Where a finding leads to a new question, it's linked into [`QUESTIONS-agents-skills-tasks.md`](./QUESTIONS-agents-skills-tasks.md).

---

## 1. Gaps in the existing specs

### 1.1 🔴 Tools API surface is referenced everywhere but never specified

The runtime invokes tools by name: `createTask`, `commentOnTask`, `transitionTask`, `editAgentFile`, `commitToRepo`, `openPullRequest`, `createSubAgent`, `getActivity`, `getMissionState`, `getKbDocument`, `getSkillBody`. None of these have a documented:

- argument schema (zod or JSON schema)
- response shape
- error envelope
- permission-gate mapping
- side effects (which DB rows / activity events fire)

Patch: new doc [`architecture/agent-tools-catalog.md`](./architecture/agent-tools-catalog.md) (added in round 3). Without it, every contributor implementing a tool has to re-derive the contract.

### 1.2 🔴 No security threat model

The agents/skills/tasks design surfaces four real attack surfaces that aren't named anywhere:

1. **Prompt injection from KB** — Agent reads a KB doc into context; the doc contains "ignore previous instructions and …". Without filtering or framing, the Agent obeys.
2. **Path traversal in `editAgentFile`** — argument `name` is supposed to be one of 5 filenames; what if the Agent passes `../../other-agent/SOUL.md`? Validation must be on the path, not just the name.
3. **Secret echo via task chat** — a user pastes their API key into a task description; an Agent's run picks it up and the assembled prompt sends it to the AI provider. Existing secret-scan covers files; chat/description need it too.
4. **DDoS via chat-triggered runs** — every `@agent` mention dispatches a Trigger.dev run. A user/script could spam 1000 mentions.

Patch: new doc [`architecture/security-agents-skills-tasks.md`](./architecture/security-agents-skills-tasks.md) (added in round 3). New questions in [QUESTIONS §L](./QUESTIONS-agents-skills-tasks.md#l-security--threats).

### 1.3 🔴 Cascade-on-delete behavior was glossed

What I wrote: "all new entities ship with `@ManyToOne(...{ onDelete: 'CASCADE' })`." That's not specific enough. Concrete decisions needed:

- **Delete an Agent** → its `agent_runs`, `agent_run_logs`, `agent_budget`, `agent_memberships`, `skill_bindings(targetType='agent')` all cascade. ✓ already documented.
- **Delete an Agent that was an assignee on tasks** → `task_assignees` row drops; the Task itself is unaffected. **Need to spec what the Task UI shows for the orphaned assignee slot.** Probably: render "Deleted Agent" with a tooltip.
- **Delete an Agent that authored chat messages** → `task_chat_messages.authorId` becomes a dangling UUID. **Need `SET NULL` with a `tombstoned: boolean` flag on the message row?** Or keep the FK and display "(deleted)". Currently undocumented.
- **Delete a Mission** → cascade to its Agents/Skills/Tasks scoped to it, but **the Mission's `missionRepo` on GitHub stays untouched**; the user has to delete or archive it manually. **Spec doesn't say this; user might be surprised.**
- **Delete a Work** → same as Mission; cascade DB-side but leave the data repo.
- **Delete a User** → no `DELETE /me` endpoint exists today (research confirmed). All cascades work transitively, but **the user's tenant Agent files stored inline in DB go away — including the Git-mirrored ones? No.** Mission/Work-scoped Agent files are in repos the user owns; the DB row goes away but the file in Git stays.

Patch: a dedicated `§6 Cascade behavior` subsection in each feature spec (agents/spec.md, task-tracking/spec.md, skills/spec.md). New questions in [QUESTIONS §L1](./QUESTIONS-agents-skills-tasks.md#l-security--threats).

### 1.4 🟡 Idempotency is inconsistent — and I didn't pick one

The platform's existing posture: no consistent rule. Onboarding uses `Idempotency-Key` header; activity-log uses `ingestEventId` in body. For new POST endpoints:

- `POST /agents` — should it accept Idempotency-Key? If a UI double-submit creates two Agents named "CEO", we get an `UNIQUE(userId, scope, slug)` 409, which is acceptable. **Probably don't need idempotency.**
- `POST /tasks` — same; UNIQUE on slug protects. **Don't need idempotency.**
- `POST /tasks/:id/chat` — duplicate chat posts are worse (Agent dispatches twice). **Should support an `Idempotency-Key` header.**
- `POST /agents/:id/run-now` — already rate-limited; double-click probability is low; rate-limit is enough.
- `POST /skills/install` — already idempotent (returns existing row on collision per FR).

Patch: lock in per endpoint above.

### 1.5 🟡 Pagination shape was unstated

The existing platform uses offset-based with `{data: T[], meta: {total, limit, offset}}`. My specs say "paginated" without naming the shape. Several endpoints (`GET /agents`, `GET /tasks`, `GET /agents/:id/runs`, `GET /tasks/:id/chat`) need this nailed.

Special case: **chat pagination should be reverse-chronological cursor** (newest first, scroll-up loads older) — but the platform doesn't have cursor pagination anywhere yet, so we either:

- (a) Add cursor pagination as a one-off for chat (precedent-setting; should be a separate ADR).
- (b) Use offset pagination with `order DESC` and accept the "insertion happens at limit boundary" bug (acceptable for chat where insertions are infrequent).

Patch: pick one in [QUESTIONS M3](./QUESTIONS-agents-skills-tasks.md#m-api-surface).

### 1.6 🟡 Authentication scope wasn't stated for new endpoints

JWT session is the default; the platform also has API keys (an existing `api-keys` feature). For new endpoints:

- All `/agents/*`, `/skills/*`, `/tasks/*` accept session auth.
- Should they also accept API keys? Use case: a user wants to script "create a task from a CI build". Today, no MCP/automation surface exposes Task creation.
- **Recommendation**: session-only for v1; add API-key support when MCP exposes these endpoints. Add to QUESTIONS.

### 1.7 🟡 Rate limits not pinned per endpoint

Platform uses `@nestjs/throttler` with 3-tier global + per-route overrides. Quick-create work gets `10/min`. My specs don't say what `POST /tasks`, `POST /agents`, `POST /tasks/:id/chat`, `POST /agents/:id/run-now` should cap at.

Recommended caps:

- `POST /agents` — 30/min/user.
- `POST /tasks` — 60/min/user.
- `POST /tasks/:id/chat` — 30/min/user per task.
- `POST /agents/:id/run-now` — 5/min/user (matches existing posture).
- `POST /skills` — 30/min/user.
- `POST /skills/install` — 60/min/user.

Patch: add to each feature `plan.md`.

### 1.8 🟡 Dispatcher CAS-claim pattern was specified at "use CAS" level but not pinned to the actual codebase pattern

Research confirmed: existing dispatcher uses `markRunDispatched(scheduleId)` — atomic SQL UPDATE WHERE status = pending. I said "CAS-update via `repo.casUpdateStatus(agentId, ACTIVE, RUNNING)`" — close, but the exact verb and shape should mirror `markRunDispatched`. Tiny inconsistency that will trip implementers.

Patch: agents/plan.md task T29-T30 should reference `WorkScheduleDispatcherService.markRunDispatched` as the precedent + name the new method `AgentDispatcherService.claimRun(agentId)`.

### 1.9 🟡 Real-time chat updates: confirmed poll, but interval not specified

Activity Feed polls every 5s. Task chat should be the same — **but**:

- 5s is OK for a feed of 100s of events.
- A two-person chat with one Agent typing wants smoother updates.

Three options:

- (a) Stick to 5s polling for v1.
- (b) Tighten polling on the chat tab to 2s (cheap; same transport).
- (c) Move chat to SSE (reuses the AI compat streaming infra). Bigger surface but matches user expectation.

Patch: question added.

### 1.10 🟢 The "Use account default" provider option needs UX wording locked

In multiple places (Agent create dialog, Task quick-actions) I said "Use account default" is the first option in the provider picker. But the platform's actual selector wording differs ("Default", "Account default", "Use account-wide setting"). I haven't checked which one is canonical.

Patch: minor — defer to design review during implementation.

---

## 2. Internal inconsistencies between docs

### 2.1 🟡 Architecture §12.1 sidebar order vs spec.md §3.8 FR-30

- Architecture says: `Dashboard / Missions / Ideas / Works / Tasks / Agents / Templates / Plugins / Skills / Activity / Settings`.
- Agents spec FR-30 says: "Agents item between Works and Templates (above Templates, below Works/Tasks)" — implies Tasks then Agents.
- Skills spec FR-19 says: "Skills item directly below Plugins" — matches architecture.

Same intent; one wording could trip a reader into thinking Tasks goes elsewhere. Tighten in agents/spec.md.

### 2.2 🟡 `AgentBudget.intervalUnit` includes 'hour' but cost-attribution flow only handles month

The `BudgetGuardService` aggregates spend over the **calendar month**. My AgentBudget entity lists `intervalUnit: 'hour' | 'day' | 'week' | 'month' | 'unlimited'`. Mismatch — does the service know how to aggregate hour/day/week? **Almost certainly not without refactor.**

Three responses:

- (a) Drop hour/day/week from `intervalUnit` in v1; only month + unlimited.
- (b) Spec the new aggregation method `getCurrentSpendCents(ownerType, ownerId, sinceTimestamp)` and implement for sub-month intervals.
- (c) Keep the schema but implement only month/unlimited; emit a clear error if a user picks hour/day/week.

★ Recommendation: (a) — drop unsupported intervals. Add back when there's demonstrated need.

Patch: agents/plan.md §3 AgentBudget, agents/spec.md FR-14/§3.4. QUESTIONS update.

### 2.3 🟡 The "Mission tick cap-hit observability gap" was flagged but never assigned

[QUESTIONS G1](./QUESTIONS-agents-skills-tasks.md#g-activity-log--observability) asks whether to persist Mission tick cap-hit events. This isn't part of the Agents/Skills/Tasks feature — it's a fix to develop's current state. Either:

- (a) Land it in this PR set (small additive).
- (b) Split into a separate PR.

★ Recommendation: (b) — out of scope here. Cross-link from the QUESTIONS file but don't conflate.

Patch: clarify in QUESTIONS G1.

### 2.4 🟡 user-journeys.md J5 assumes B2 = "yes by default"

J5's narrative depends on Tenant CEO seeing across Mission boundaries. QUESTIONS B2 has this as ★-default yes, but if the operator picks "no", J5 breaks. The journey doc should call out the dependency more explicitly.

Patch: minor edit to J5.

---

## 3. Missing concerns

### 3.1 🔴 No spec for **streaming Agent chat responses into the Task chat**

The agent-prompt-assembly doc §9 says "for chat replies: streaming, debounced 250ms". But the implementation surface — how the partial message updates flow from the worker to the API to the polling client — isn't specified.

Three implementations possible:

- (a) Worker writes full message at end of run; client polls; no streaming UX.
- (b) Worker streams chunks via remote-proxy `appendToChatMessage(messageId, chunkText)`; client polls 1s and sees growing text.
- (c) SSE end-to-end (worker → API → browser).

★ Recommendation: (b) for v1 — same polling transport, no new infra.

Patch: question added.

### 3.2 🟡 No "Agent dry-run" mode

For testing prompt changes without spending money, users want a "dry-run heartbeat" that builds the prompt + estimates cost + returns the would-have-been-sent payload but does NOT call the AI provider. Useful during onboarding.

★ Recommendation: ship in v1 as `POST /agents/:id/dry-run` — returns the assembled prompt + estimated tokens + estimated cost. No `agent_runs` row written. Doesn't count against budget.

Patch: add to agents/spec.md as FR-41+ and to tasks.md.

### 3.3 🟡 No "Agent export" / "Agent import"

Once a user invests in tuning an Agent's MD files, they'll want to:

- Export to JSON to share / version externally.
- Import into another tenant / another platform.
- Fork another user's Agent (if a marketplace exists).

★ Recommendation: ship export as JSON via `GET /agents/:id/export` in v1 (read-only, small). Import deferred to v2.

Patch: agents/spec.md.

### 3.4 🟡 Skills `examples` injection not in token budget

I added `examples:` frontmatter to Skills in round 2, but didn't say where they go in the prompt assembly. The current 11-segment doc has Skills at #6 — examples should be inside that segment. The 4000-token budget for #6 must cover description + body excerpt **+ examples** if present.

Patch: clarify in agent-prompt-assembly.md §2.

### 3.5 🟡 Task chat with attachments — what file types?

Spec says "attach via existing KB upload endpoint" but the KB upload has a curated MIME list (PDF, MD, images, …). Tasks may want broader (code files, CSVs, ZIPs). **Either inherit KB's list (smaller scope) or define a Task-specific list.**

★ Recommendation: inherit KB's list for v1. Broaden if users complain.

Patch: task-tracking/spec.md FR-6, minor note.

### 3.6 🟡 No "@here" / "@all" semantics in task chat

If a user types `@all`, do all assignees get a notification? Currently undocumented. If yes, the dispatch storm question (3.1 above) gets worse.

★ Recommendation: v1 — only specific `@<slug>` mentions trigger dispatches. `@all` and `@here` are accepted in body but don't dispatch.

Patch: task-tracking/spec.md §3.3, §5.5.

### 3.7 🟡 No telemetry on Skill effectiveness

Per-Skill stats would be valuable: "this skill was injected 1200 times, the model called `getSkillBody` 84 times." Helps users prune skills that are bound but never used.

★ Recommendation: defer to v2. Add a hook now — log `SKILL_INVOKED` (already in spec) and emit `SKILL_INJECTED` (new) on each prompt-assembly. v2 dashboard reads.

Patch: skills/spec.md FR-14, agent-prompt-assembly.md.

### 3.8 🟢 No "search Agents / Tasks" endpoint

`GET /agents?search=ceo` — useful when a user has 50 agents. Currently the spec has filters by status/scope but no text search.

Patch: add `?search` query param to list endpoints (matches existing Works pattern).

### 3.9 🟢 Mission Template scaffolder error path

If the scaffolder fails partway (some skills copied, some not), spec doesn't say what state the new Mission ends up in. Probably: best-effort, with an `ActivityLog` warning for each failure, but the Mission is created either way.

Patch: spec.md S9 should note "best-effort, with per-file failure logged."

### 3.10 🟢 No clear "what does the Agent see in its prompt when there are zero tasks assigned"

The prompt-assembly doc lists memory segments but doesn't say what the user-message content is on an idle heartbeat. agents/spec.md §5.2 (round 2) covers it (`"What's the next action you should take?"`), but prompt-assembly.md §3 contradicts — it says "for heartbeat, omitted." Inconsistency.

Patch: align prompt-assembly.md §3.1 to match agents/spec.md §5.2.

---

## 4. Naming / clarity

### 4.1 🟡 "Active" overloaded

- `Agent.status = 'active'` (lifecycle)
- `skill_bindings` carries `injectIntoAgent` boolean, but the UI says "active" for bindings ([skills/spec.md §3.4](./features/skills/spec.md))
- `agents.targets` JSON has `scope='*'` meaning "active for all", which I call "available to all"

Three different "active". Tighten the wording to: Agent lifecycle = `status`, Skill binding = `enabled`, Tenant Agent membership = `scope`.

### 4.2 🟡 "agent.yml" vs "AGENTS.md"

The proposed file naming `agent.yml` (lowercase) but `AGENTS.md` (uppercase) feels arbitrary. Mission has `mission.yml` (lowercase) so `agent.yml` is consistent. The MD files are uppercase because they're "manifests"/"voices" — Anthropic Skills use lowercase like `SKILL.md`. Worth a consistency check.

★ Recommendation: keep proposed convention; document it once in the agents/spec.md.

### 4.3 🟢 "Heartbeat" might confuse with "health check"

Software "heartbeat" usually means "I'm alive." Here it means "the Agent's idle tick where it decides what to do next." Some product users will misread.

★ Alternative names tested: "Tick", "Pulse", "Routine", "Cycle". None obviously better.

Recommendation: keep "Heartbeat" but make the empty-state copy clarify ("Heartbeat = the schedule your Agent wakes up to think about what to do next.").

---

## 5. What I'm proud of that needs preserving

- **Source-of-truth-in-Git for Agent/Skill MD files** is right. Tenant DB-inline fallback (ADR-008) is the right trade-off.
- **Reuse of polymorphic budget owner pattern** — Once `BudgetOwnerType` enum gets `AGENT` + `TASK` values, everything else is free.
- **Tasks-as-only-channel for Agent↔Agent** — gives audit, cost attribution, scope enforcement in one move.
- **ADR-009 (Tasks vs Items vs KB)** — pre-empts a real category collision.
- **User journeys** — caught real design holes (J5 cross-Mission visibility; J4 skill dedup).

These shouldn't be touched in any future round.

---

## 6. Next actions

1. ✅ Land the patches identified above in round 3 commits.
2. Append new questions to `QUESTIONS-agents-skills-tasks.md` (sections L/M/N).
3. New file: `architecture/agent-tools-catalog.md`.
4. New file: `architecture/security-agents-skills-tasks.md`.
5. (Optional) New file: `features/agents/dry-run-and-export.md` — if the dry-run/export feature gets the green light in §3.2 / §3.3.

---

## 7. References

- [QUESTIONS-agents-skills-tasks.md](./QUESTIONS-agents-skills-tasks.md)
- [architecture/agents-skills-tasks.md](./architecture/agents-skills-tasks.md)
- [architecture/agent-prompt-assembly.md](./architecture/agent-prompt-assembly.md)
- [features/agents/spec.md](./features/agents/spec.md)
- [features/skills/spec.md](./features/skills/spec.md)
- [features/task-tracking/spec.md](./features/task-tracking/spec.md)
- ADRs 006-009.
