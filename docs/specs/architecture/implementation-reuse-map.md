# Implementation Reuse Map — Agents / Skills / Tasks

**Status**: `Draft` · 2026-05-25
**Audience**: Lead engineer + reviewers. Every new piece of Agents/Skills/Tasks scope is mapped to the existing platform asset it reuses. The goal: prove that the "minimal new code" claim holds, and surface exactly what's genuinely new.

> **Why this doc.** Round 1-3 specs say "reuse the X facade" / "extend Y pattern" repeatedly. This doc makes it concrete: name the file, name the verb, name the test fixture. So an implementer can scan one table and find their handhold.

---

## 1. Entities — map to reuse pattern

| New entity                | Reuse pattern                                                                                                               | Genuinely new                                                  |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `Agent`                   | Same TypeORM shape as `Mission` ([`mission.entity.ts`](../../packages/agent/src/entities/mission.entity.ts)); polymorphic owner cols + `@Index('uq_..._userId_slug')` unique. | Five inline TEXT cols for DB-only tenant file storage.        |
| `AgentRun`                | Same as `WorkGenerationHistory` ([`work-generation-history.entity.ts`](../../packages/agent/src/entities/work-generation-history.entity.ts)) — status enum, started/finished timestamps, error, summary, optional `triggerRunId`. | The `triggerKind` discriminator (`heartbeat | task | chat`).   |
| `AgentRunLog`             | **Verbatim copy** of `WorkAgentRunLog` ([`work-agent-run-log.entity.ts`](../../packages/agent/src/entities/work-agent-run-log.entity.ts)) — only FK renamed (`runId → agent_runs.id`). | Nothing.                                                       |
| `AgentBudget`             | Polymorphic owner already lives on `WorkBudget` ([`work-budget.entity.ts`](../../packages/agent/src/entities/work-budget.entity.ts)) — extend `BudgetOwnerType` enum in [`_types.ts`](../../packages/agent/src/entities/_types.ts) with `AGENT` + `TASK`. | Nothing schema-side; values only.                              |
| `AgentMembership`         | Same shape as the polymorphic `(ownerType, ownerId)` columns already used by `WorkBudget`.                                  | The unique index on `(agentId, targetType, targetId)`.         |
| `Skill`                   | Closest analog is `Template` ([`template.entity.ts`](../../packages/agent/src/entities/template.entity.ts)) — has `ownerUserId`, `sourceType` (catalog/forked/custom), `version`. | Frontmatter jsonb + content hash.                              |
| `SkillBinding`            | New shape — no exact precedent. Closest is `WorkAdvancedPrompts` (one-per-Work). Multiplicity differs (many-to-many).        | The `targetType` polymorphic + `injectIntoAgent` / `injectIntoGenerator` booleans. |
| `Task`                    | Closest analog is `WorkProposal` ([`work-proposal.entity.ts`](../../packages/agent/src/entities/work-proposal.entity.ts)) — also has status enum, priority-like field, slug. | The state machine + `parentTaskId` recursion + `requireAllApprovers`. |
| `TaskAssignee`            | Polymorphic shape mirrors `WorkBudget`'s owner cols. `(assigneeType, assigneeId)`.                                          | Nothing.                                                       |
| `TaskBlocks`              | Self-referential join — same shape as `task_relations`. Cycle detection helper is the only new helper.                       | The cycle detector (runs recursive CTE).                      |
| `TaskRelations`           | Same as the existing template-customization back-pointer pattern.                                                            | The `kind` enum field.                                         |
| `TaskChatMessage`         | Closest analog is `ConversationMessage` ([`conversation-message.entity.ts`](../../packages/agent/src/entities/conversation-message.entity.ts)) — `role`, `content`, FK to parent. | The `authorType` polymorphic + `mentions` jsonb + `attachments` jsonb. |
| `TaskAttachment`          | Reuses `work_knowledge_upload.id` FK — no new upload pipeline.                                                               | Nothing.                                                       |
| `TaskWatcher`             | Same as the existing join-table pattern (e.g. `work_member`).                                                                | Nothing.                                                       |
| `TaskKbMention`           | Same.                                                                                                                       | Nothing.                                                       |
| `UserTaskCounter`         | Single-row-per-user atomic counter; no direct analog but trivial.                                                            | The atomic increment SQL.                                      |

**Genuinely new entity rows: 0**. Every new entity is a variation of an existing shape.

---

## 2. Services — map to reuse

| New service                          | Reuse                                                                                                              | Genuinely new logic                                                                                                |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `AgentService`                       | CRUD + scope validation — analogous to `MissionService`.                                                            | Scope-cascade validator (in `validateScopeOwnership()`).                                                            |
| `AgentRunService`                    | Run lifecycle + status transitions — analogous to `WorkGenerationService`.                                          | The 3-trigger dispatch (heartbeat / task / chat) + prompt assembly orchestration.                                  |
| `AgentFileService`                   | Branches between `GitFacadeService.commit()` and inline DB write.                                                  | The branching logic + secret-scan pre-write.                                                                       |
| `AgentToolService`                   | Tool registration shape from `agent-pipeline` / `claude-code` plugins.                                              | The tool catalog + per-tool permission gate.                                                                       |
| `AgentBudgetService`                 | Polymorphic delegation to existing `BudgetService.summarizeForOwner({ownerType: AGENT})` — zero new aggregation.    | Nothing.                                                                                                          |
| `AgentScheduleDispatcherService`     | Verbatim pattern of `WorkScheduleDispatcherService` — CAS-claim via `markRunDispatched`. ([research](#references)) | Different filter (Agents not Schedules); identical claim logic.                                                    |
| `PromptAssemblerService`             | Reads from existing `WorkAdvancedPrompts` repo + Skill resolver + activity-log queries.                             | The 11-segment assembly recipe (the one piece of code without a clear precedent).                                  |
| `SkillCatalogService`                | Same pattern as `TemplateCatalogService` ([`template-catalog.service.ts`](../../packages/agent/src/template-catalog/template-catalog.service.ts)) — boot-time seed from TS constants + in-memory cache. | Skill-specific frontmatter validation.                                                                             |
| `SkillBindingService`                | Standard CRUD; reuses repository pattern.                                                                            | The `resolveActive()` priority-sorted resolver.                                                                    |
| `SkillFileService`                   | Same branch as `AgentFileService` (Git for Mission/Work, DB-inline for Tenant).                                      | Nothing.                                                                                                           |
| `TaskService`                        | CRUD + slug counter — analogous to `WorkProposalService`.                                                            | Slug counter atomic increment.                                                                                     |
| `TaskTransitionService`              | State-machine guarded transitions — closest precedent is `WorkProposalService.acceptInternal()` with its `fromStatuses` check. | The full state machine.                                                                                            |
| `TaskChatService`                    | Polling endpoint + mention parsing — analogous to AI Conversation's `ConversationController`.                       | Mention parsing + dispatch hooks.                                                                                  |
| `TaskNotificationService`            | Thin wrapper that calls existing `NotificationsService.create()` ([`notification.entity.ts`](../../packages/agent/src/entities/notification.entity.ts) shape). | Recipient computation logic.                                                                                       |

**Genuinely new service files: ~14**. All thin (mostly orchestration over existing services); the heaviest is `PromptAssemblerService`.

---

## 3. Background jobs — map to reuse

| New Trigger.dev task              | Reuse                                                                                                                                                            |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent-heartbeat-dispatcher`      | Identical shape to `mission-tick` task ([`mission-tick.task.ts`](../../packages/tasks/src/tasks/trigger/mission-tick.task.ts)) — `schedules.task({cron: '* * * * *'})` + service call. |
| `agent-heartbeat`                 | Identical shape to `work-generation` task — `task()` with `maxDuration: 30 * 60`, bootstraps Nest, calls service via remote proxy.                                |
| `agent-task-execute`              | Same as above with `maxDuration: 60 * 60`.                                                                                                                       |
| `agent-chat-reply`                | Same with `maxDuration: 5 * 60`.                                                                                                                                  |

All four reuse the existing internal RPC channel ([ADR-002](../decisions/002-trigger-worker-callback-channel.md)): `x-trigger-secret` header + `createRemoteProxy()`. **Genuinely new transport: 0.**

---

## 4. Controllers / endpoints — map to reuse

Every new controller decorator pattern lives in existing code:

| Pattern                                            | Existing example                                                                              |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `@Controller('api/agents')` (unversioned)          | `@Controller('api/me/missions')` in [`missions.controller.ts`](../../apps/api/src/missions/missions.controller.ts) |
| Cross-user 404 (not 403) on read                   | AI Conversation controller                                                                     |
| `@CurrentUser()` decorator                         | Every authenticated controller                                                                 |
| `@Throttle({ default: { limit: N, ttl: M } })`     | `quickCreateWork` in [`works.controller.ts`](../../apps/api/src/works/works.controller.ts)     |
| Offset pagination DTO with `{data, meta}`          | Every list endpoint                                                                            |
| `ParseUUIDPipe` for path params                    | Every detail endpoint                                                                          |
| `class-validator` DTOs in `dto/` subfolder         | Every module                                                                                   |
| SSE (only for streaming chat) `text/event-stream`  | `openai-compat.controller.ts`                                                                  |
| Activity emission via event listener               | `WorkCreatedEvent → ActivityLogListener.onWorkCreated`                                          |

**Genuinely new controller shape: 0**. Even the SSE streaming for Agent chat reply (if we land [N10-c](../QUESTIONS-agents-skills-tasks.md#n10--streaming-chat-response-into-task-chat)) reuses the openai-compat pattern.

---

## 5. Web (frontend) — map to reuse

| New UI surface                          | Reuse                                                                                                  |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `/agents` list (Cards/Table/Kanban)     | View-mode switcher + localStorage persistence: `works-client.tsx`. Kanban shape: `WorksKanbanView.tsx`. |
| `/agents/[id]` tab strip                | `WorkTabs.tsx` shape; new component `AgentTabs.tsx` copies it.                                          |
| Agent detail Dashboard (live, charts)   | Stat cards: `apps/web/src/components/dashboard/*Tile.tsx`. Bar chart: same lib already in use.          |
| Activity tab per Agent                  | `ActivityFeedClient.tsx` extended with `agentId` filter.                                                 |
| Instructions tab (5-file editor)        | `KbEditor.tsx` (Tiptap) wrapped in a 5-pill switcher. Zero new editor stack.                            |
| Budgets tab                              | Shape identical to existing Work Budgets / Mission Budget cards (per `BudgetSummaryCard.tsx`).          |
| Create-Agent dialog (2-step)            | Form patterns from `WorkManualForm.tsx`: `useState` + `useTransition` + server actions.                |
| `/skills` list (3 sections)             | `PluginsList.tsx` shape: search + filter + cards.                                                       |
| `/skills/[id]` Body + Bindings tabs     | New mini-tabs; Tiptap editor for body.                                                                  |
| `/tasks` list                            | View-mode switcher from `/works`. New `TasksKanbanView.tsx` adapts `WorksKanbanView.tsx` columns.       |
| Task detail page                        | Stacked layout; right-rail metadata + main scroll. Chat: lightweight Tiptap.                            |
| Sidebar items                           | Insert into `DashboardSidebar.tsx` config array.                                                        |
| New dashboard tiles                     | New `AgentsCountTile.tsx`, `TasksInProgressTile.tsx` — clone existing tile shape.                        |

**Genuinely new components: ~12**, all thin. No new state lib, no new design system, no new routing.

---

## 6. Migration ordering

Run in this order (all forward-only, additive):

1. `CreateAgentsTables.ts` — creates `agents`, `agent_runs`, `agent_run_logs`, `agent_budgets`, `agent_memberships`.
2. `AddAgentIdToPluginUsageEvents.ts` — additive column.
3. `ExtendBudgetOwnerTypeEnum` (no DB change; enum string union in TS code).
4. `CreateSkillsTables.ts` — creates `skills`, `skill_bindings`.
5. `CreateTasksTables.ts` — creates `tasks`, `task_assignees`, `task_reviewers`, `task_approvers`, `task_blocks`, `task_relations`, `task_chat_messages`, `task_attachments`.
6. `AddTaskAuxTables.ts` — `user_task_counter`, `task_watchers`, `task_kb_mentions`.
7. `AddTaskIdToPluginUsageEvents.ts` — additive column.

Each migration:
- runs in a single transaction;
- ships with a `down()` that drops the new tables/columns (safe rollback within minutes of deploy);
- emits a startup log line `"Applied migration NNN"`.

**Rollback story**: revert the API to the previous tagged build; the migrations' `down()` drops the new tables. No data loss for non-feature flows.

---

## 7. N+1 risk catalog

The dispatcher and list endpoints are the hot paths. Each one's risk + mitigation:

| Risk                                                              | Mitigation                                                                                                   |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `GET /agents` with each card showing bound-skills-count            | Aggregate query with `LEFT JOIN skill_bindings GROUP BY agentId`. Single round trip.                          |
| `GET /agents` with each card showing `lastRunStatus`                | Stored denormalized on `agents.lastRunStatus` (already in entity).                                            |
| `GET /tasks` Kanban with 500 items × assignees × labels            | Load tasks; then one batch query per join (`assigneeIds IN (...)`). Three queries total.                     |
| Heartbeat dispatcher with 10k active Agents per tick               | Single SELECT with index `(status, nextHeartbeatAt)`; CAS-claim atomic SQL UPDATE per agent.                |
| `AgentRunService.execute()` loading files + skills + activity      | All loads in `Promise.all()` (see [`agent-prompt-assembly.md` §8](./agent-prompt-assembly.md)).                |
| `GET /tasks/:id/chat` with mentions referencing other tables        | Mentions stored as embedded JSON; UI dereferences via batched lookups on a separate `?expand=mentions` query.|
| `Skill.resolveActive()` for Agent with bindings at 5 scope tiers   | One JOIN query covering all scope tiers; results de-duped in app by slug.                                    |

**Lazy loading** (TypeORM `lazy: true`) is avoided for hot paths — explicit JOINs only.

---

## 8. Caching strategy

| Cache                              | Backed by                                          | Invalidation                                  |
| ---------------------------------- | -------------------------------------------------- | --------------------------------------------- |
| Skill catalog (in-memory)          | `SkillCatalogService` boot-time load + Map         | API restart; no runtime invalidation needed   |
| Agent file content (5 min LRU)     | Existing `cache_entries` table (TypeORM-backed)    | Explicit `cache.delete(agentId)` on PUT      |
| Resolved active skills per Agent   | `cache_entries` 60s TTL                            | Explicit delete on `skill_binding` mutation   |
| Activity feed                      | Client polling, no server cache                    | n/a                                           |
| Agent run dashboard charts         | Server-side aggregation, 30s response cache        | TTL only                                      |
| Mission/Idea/Work tab counts       | Same as existing tab-count caching                  | n/a                                           |

We use the existing `cache_entries` distributed-cache table ([`cache.entity.ts`](../../packages/agent/src/entities/cache.entity.ts)) so multi-pod deployments share state. No Redis added.

---

## 9. Test infrastructure reuse

| Test type            | Existing pattern                                                                                          | Reuse                                                                                              |
| -------------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Entity unit          | `packages/agent/src/entities/__tests__/work.entity.spec.ts`                                                | Same Jest setup; same factory pattern.                                                              |
| Repository unit      | `packages/agent/src/database/repositories/__tests__/*.spec.ts`                                             | Mock DataSource pattern (existing).                                                                  |
| Service unit         | `packages/agent/src/services/__tests__/*.spec.ts`                                                          | NestJS `@nestjs/testing` module setup.                                                                |
| API e2e (NestJS)     | `apps/api/test/*.e2e-spec.ts`                                                                              | Existing test app bootstrap with in-memory SQLite or test Postgres.                                  |
| Dispatcher CAS race  | Existing test for `WorkScheduleDispatcherService.markRunDispatched`                                       | Spin up 2 parallel calls; assert exactly one wins.                                                   |
| Trigger.dev mock     | Existing pattern in `packages/tasks/src/__tests__/`                                                       | Mock `runs.trigger()` returning a stub run-id.                                                       |
| AI provider mock     | Existing pattern: mock `AiFacadeService.createChatCompletion` to return canned responses                  | Same.                                                                                                 |
| Web Playwright e2e   | `apps/web/playwright.config.ts` + `apps/web/tests/`                                                       | Same.                                                                                                 |
| Plugin contract test | `packages/plugin/src/contracts/__tests__/`                                                                | Add a contract test for the reserved `IExternalTaskTrackerPlugin` interface.                          |

**E2E cost concern**: tests that call real AI providers cost real $. Existing posture: AI calls always mocked in CI via the test-provider mock. We inherit this. Local dev that wants to hit a real provider uses `.env.test.local` with their own API key.

---

## 10. Local dev experience

| Concern                                          | Solution                                                                                              |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| Bootstrap an Agent without GitHub repo            | Tenant-scope Agents work DB-only; no Git needed.                                                       |
| Force a heartbeat without waiting for cron        | `POST /agents/:id/run-now` available in UI.                                                            |
| Force a Trigger.dev cron in `pnpm dev:trigger`    | Existing dev server runs cron at higher frequency for testability.                                     |
| Mock AI provider for offline dev                  | `OPENAI_MOCK=true` env var (existing); responds with canned data.                                      |
| Inspect prompt assembly output                    | New `POST /agents/:id/dry-run` (see [QUESTIONS N4](../QUESTIONS-agents-skills-tasks.md#n4--per-agent-dry-run-mode)) — returns the assembled prompt without calling AI. |
| Reset Agent state                                 | `DELETE /agents/:id` cascades; or `pnpm db:reset --feature=agents` (script to add).                    |

---

## 11. What's GENUINELY new (the minimal addition set)

This is the **only code that has no clear precedent in the existing platform** and therefore needs the most design care:

1. **PromptAssemblerService** — the 11-segment system-message assembly. ~250-400 lines of code. Risk: prompt-engineering correctness; mitigated by progressive disclosure + token budgeting + extensive unit tests.
2. **AgentToolService.resolveAllowedTools** — the per-Agent tool catalog with permission gates. ~150 lines. Risk: privilege escalation; mitigated by [security model §7](./security-agents-skills-tasks.md).
3. **SkillBindingRepository.resolveActive** — priority-sorted resolver across 5 scope tiers. ~80 lines. Risk: incorrect resolution order; mitigated by exhaustive unit tests.
4. **TaskTransitionService** — state machine with blocker/approver guards. ~120 lines.
5. **Cycle detection** (parent + blockers) — recursive CTE or iterative walker. ~60 lines.
6. **Mention parser** — extracts `@<slug>` / `[[kb-slug]]` from rich-text body. ~80 lines.
7. **Two custom Trigger.dev tasks** (`agent-heartbeat`, `agent-task-execute`) — bodies are thin orchestrators.
8. **Web UI**: ~12 new React components per the table in §5. Each is a thin variant of an existing component.

**Conservative estimate**: ~3000 lines of new TS code total, of which ~600 is genuinely novel. Spread across `packages/agent/`, `apps/api/`, `apps/web/`, `packages/tasks/`. Add ~1500 lines of test code.

For a comparable feature size, this slot is ~⅓ the size of the AI Conversation feature when it landed.

---

## 12. Deployment / rollout impact

| Concern                                | Impact                                                                                                  |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Trigger.dev run volume                  | New dispatcher fires every minute. If 100 active Agents and dispatcher batches in 1 task → +~525k runs/month. Cost the Trigger.dev tier before launch. |
| DB row volume                           | `agent_runs` at 1-min heartbeat × 100 Agents = 144k rows/day. With 30-day rolling history, ~4M rows. Index on (agentId, startedAt) handles. |
| API memory                              | Skill catalog cache: ~10 MB (1000 entries × ~10 KB). Agent file cache: ~100 KB per active Agent × cap = bounded. |
| API CPU                                 | Heartbeat AI calls happen on the worker, not the API. API CPU impact: negligible.                                                                |
| Worker memory                           | Each `agent-heartbeat` run bootstraps Nest (~100 MB) + holds prompt context (~50 KB). Trigger.dev's per-run isolation handles this. |
| Plugin usage events table                | Already at heavy write volume; +1 column (`agentId`) + 1 column (`taskId`). Index `(agentId, occurredAt)` adds ~10% storage. |
| Network egress to AI providers           | Whatever the user authorizes; bounded by per-Agent budgets.                                                                                      |

No new infrastructure deployed (Redis, k8s, queue system, etc.).

---

## 13. Feature flagging

| Flag                       | Purpose                                                          | Default at launch |
| -------------------------- | ---------------------------------------------------------------- | ----------------- |
| `FEATURE_AGENTS`            | Hides Agents sidebar/tabs + disables endpoints                  | `off` (per-tenant opt-in initially) |
| `FEATURE_SKILLS`            | Hides Skills sidebar/tabs + disables endpoints                  | `off`             |
| `FEATURE_TASK_TRACKING`     | Hides Tasks sidebar/tabs + disables endpoints                   | `off`             |
| `FEATURE_AGENT_DRY_RUN`     | Enables the dry-run endpoint                                    | `on`              |
| `FEATURE_AGENT_EXPORT`      | Enables `GET /agents/:id/export`                                | `on`              |

Flags read from env / tenant-settings table. Wrap the new sidebar items + tab strips in `<FeatureFlag name="FEATURE_AGENTS">` per existing platform pattern.

After 2-4 weeks of internal beta, flip the three primary flags to `on` by default. Individual tenants can still opt out via tenant settings.

---

## 14. PR / shipping plan

Estimated ~12-18 PRs for full feature delivery:

| PR  | Scope                                                       | Risk      |
| --- | ----------------------------------------------------------- | --------- |
| 1   | `agents` table + migration + entity + repository unit tests  | Low       |
| 2   | `agent_runs` / `agent_run_logs` / `agent_budgets` + migration| Low       |
| 3   | `AgentService` + `AgentsController` (read-only)              | Low       |
| 4   | `AgentFileService` + `PUT/GET files` endpoints               | Medium    |
| 5   | `/agents` web list + Instructions tab + Create dialog        | Medium    |
| 6   | `agent-heartbeat-dispatcher` Trigger.dev task + CAS-claim     | Medium    |
| 7   | `agent-heartbeat` task + `AgentRunService.execute()` + `PromptAssemblerService` | High |
| 8   | Skill catalog + `skills` + `skill_bindings` + read-only API   | Low       |
| 9   | Skill mutations + `/skills` page + Bindings tab               | Low       |
| 10  | Skill injection into AI calls + `getSkillBody` tool           | Medium    |
| 11  | `tasks` family of tables + migrations + repositories          | Low       |
| 12  | `TaskService` + `TasksController` + `/tasks` list + Cards     | Medium    |
| 13  | Task detail page + chat backend                                | Medium    |
| 14  | Task Kanban + per-target tabs (incl. Mission tab strip)        | Medium    |
| 15  | `agent-task-execute` + `agent-chat-reply` Trigger.dev tasks    | Medium    |
| 16  | Tools surface (`createTask`, etc.) wired to Agent runs          | High      |
| 17  | Dashboard tiles + Recent Tasks block + notifications wiring    | Low       |
| 18  | Default-on rollout + docs site updates                          | Low       |

**Critical-path PRs**: 7 (AgentRunService + PromptAssembler) and 16 (tools wired to runs). Everything else can land in parallel after #3.

---

## 15. Hand-off checklist

Before any implementation PR opens:

- [ ] All open QUESTIONS answered (or punted with a documented `[NEEDS CLARIFICATION]` mark).
- [ ] Migrations reviewed for `synchronize: true` accidents.
- [ ] Constitution gates ticked in every feature spec.
- [ ] Test plan reviewed (unit + e2e + Playwright).
- [ ] Operator approved the default budget caps.
- [ ] Trigger.dev project tier confirmed (cost of +500k runs/month).
- [ ] Sentry tags added to telemetry config.

---

## 16. References

- [agents-skills-tasks.md](./agents-skills-tasks.md) — overall architecture
- [agent-prompt-assembly.md](./agent-prompt-assembly.md) — the one genuinely novel piece
- [agent-tools-catalog.md](./agent-tools-catalog.md) — tool API contract
- [security-agents-skills-tasks.md](./security-agents-skills-tasks.md) — threat model
- [../features/UX-DESIGN-agents-skills-tasks.md](../features/UX-DESIGN-agents-skills-tasks.md) — PM-lens companion
- [../QUESTIONS-agents-skills-tasks.md](../QUESTIONS-agents-skills-tasks.md) — open decisions
- ADRs 006-009 — design decisions already captured
- Mission tick precedent: `packages/tasks/src/tasks/trigger/mission-tick.task.ts`
- Work schedule dispatcher precedent: `packages/agent/src/database/repositories/work-schedule.repository.ts` + `markRunDispatched`
- AI Conversation precedent: `apps/api/src/ai-conversation/`
