# Agents/Skills/Tasks — Post-PR-1019 Follow-ups Progress

Branch: `feat/agents-skills-tasks-followups` (off `origin/develop` @ `a961f0e2`)

## Tier 1

- [x] FU-1 · LLM dispatch in `AgentRunService.execute` — token-based facade (`AGENT_AI_DISPATCH_FACADE`), tool loop capped at 10 iterations, virtual `transitionTask` capture tool on `task` runs, INFO/WARN/ERROR run-log rows for `ai-dispatch` + `tool-invocation`, finalize() routes chat-back + task-finish
- [x] FU-2 · 6 missing Agents API controller routes — `run-now`, `runs`, `runs/:runId/cancel`, `skills`, `budget`, `assign-task`. Throttled per plan §7.1, activity-logged, cross-user 404 via `agentsService.getOne`. New repo methods (`AgentRunRepository.countByAgent` / `cancel` / `findByIdAndUser`) + `AgentScheduleDispatcherService.dispatchOne` + 2 new ActivityActionType values
- [x] FU-3 · Mission/Work/Idea-scoped Agent creation entry points — `NewAgentDialog` now accepts a `pinned` prop that skips step 1 and forwards `missionId`/`workId`/`ideaId` to the API. New routes `/missions/[id]/agents/new`, `/works/[id]/agents/new`, `/ideas/[id]/agents/new`. Entry points: Agents tab on MissionTabs, "+New Agent" button in WorkHeader, Bot button on IdeaCard.
- [x] FU-4 · 3 placeholder Agent-detail tabs — `activity`/`skills`/`budgets` pages now server-fetch via FU-2 endpoints + client components (`AgentActivityClient`, `AgentSkillsClient`, `AgentBudgetsClient`). Activity supports cancel-on-row + pagination. Skills supports remove-binding via existing `DELETE /api/skill-bindings/:id`. Budgets renders a progress bar with cap-aware coloring.
- [x] FU-5 · Attachment UI on Task detail — `TaskAttachmentsSection.tsx` mounted between transitions and conversation. Drag-drop file picker uploads via new `/api/uploads` Next.js proxy → `POST /api/tasks/:id/attachments`. List shows filename, size, attached-at, with detach affordance. `attachUploadAction` / `detachAttachmentAction` server actions.

## Tier 2

- [x] FU-6 · i18n Tasks/Skills/Templates components — new `dashboard.tasksPage.{list,newDialog,detail,recurring,status}`, `.skillsPage.{list,detail}`, `.templatesPage.*` keys in `apps/web/messages/en.json`. Threaded `useTranslations` through TasksList (filter labels, status select, empty state) and TaskDetailClient (Move to, transition labels, conversation, draft placeholder, Post button). Non-en locales fall back to en via next-intl per existing convention.
- [x] FU-7 · Recurring picker friendly controls — added time-of-day (emits `BYHOUR`/`BYMINUTE`), weekday multi-select for Weekly (emits `BYDAY=MO,...`), day-of-month for Monthly (emits `BYMONTHDAY=`), timezone with browser-tz default + datalist suggestions. Client-side rule validation (FREQ check + non-empty BYDAY for Weekly); Save disabled when invalid.
- [x] FU-8 · Skills binding picker UI — replaced the raw UUID textbox with `SkillBindingTargetPicker`. Tenant auto-fills; agent/mission/idea/work load entries via `agentsAPI.list` / `missionsAPI.list` / `workProposalsAPI.list` / `workAPI.getAll` (up to 100 each), with a search filter + sized listbox. Added explanatory copy on the bindings panel. Falls back to a paste-uuid input when the list endpoint errors or returns nothing.
- [x] FU-9 · Kanban drag-and-drop transitions — HTML5 drag-drop on TasksKanbanView. Cards are `draggable`; columns highlight a primary ring when the dragged card has a legal transition to that status. Drop calls the existing `transitionTaskAction` with optimistic update + revert on rejection. Click-popover fallback preserved for keyboard users.
- [x] FU-10 · GitHub-sync v2 toggles UI — added Include Agents / Skills / Tasks / Task chat checkboxes to `GitHubSync.tsx`, mirroring the export form in `DataManagement.tsx`. Wired through to `pushToGitHub` action which already accepts the v2 toggle bag. Task-chat gated on includeTasks so toggling Tasks off cleanly resets the chat flag. (Persistence to UserSyncConfig is server-side; UI defaults to all-off matching the v1 payload until the user opts in.)
- [x] FU-11 · Templates browser content swap to ADR-010 catalog — added env-flag (`NEXT_PUBLIC_AGENT_TEMPLATES_CATALOG`) opt-in path in `listAstTemplates`. When the flag is on, lazy-imports `serverFetch` and hits `/api/agent-templates?entity=<entity>`; on error or flag-off, returns the existing fallback constants. Shape preserved across both branches so callers (route pages + dialog pre-fill) don't change. Updated spec covers all 3 cases (flag-on success, flag-on error → fallback, flag-off). ADR-010 catalog itself still pending operator-led work — flag stays off by default until it lands.

## Tier 3 (operator decisions — partially resolved 2026-05-26)

- [ ] FU-12 · Transition lattice `done → in_progress` divergence — still awaiting operator pick between (a) spec carve-out or (b) tightening `ALLOWED[DONE]`.
- [x] FU-13 · Operator-binding for `AGENT_GIT_FACADE` — added per-Agent `committerName`/`committerEmail` columns + migration; bound the token in api-side AgentsModule using User's OAuth token via existing `GitFacadeService.commit/.createPullRequest`; updated injection-tokens doc with the canonical adapter.
- [x] FU-14 · Phase 4 Git-mode AgentFileService writes — added `GitFacadeService.getRepoDir(scope, scopeId)` that resolves Work scopes via `WorkRepository.findById` + `cloneOrPull`, returns null for Mission/Idea (no repo in current data model); removed "Git-mode lands in Phase 6" throws so non-tenant Agents fall back to DB-inline cleanly.

## Future tracks (post-PR-1021)

- **Email Providers** — new spec at [`docs/specs/features/email-providers/spec.md`](docs/specs/features/email-providers/spec.md). Tenant-managed inbound + outbound email addresses, multi-provider plugin contract (Mailchimp, Mailgun, Postmark, Resend, Sendgrid), per-Agent assignment, integration with the agent-run path. Closes the loop on the FU-13 `Agent.committerEmail` synthesized-domain placeholder.

## Log

(timestamps in UTC)
