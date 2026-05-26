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
- [ ] FU-9 · Kanban drag-and-drop transitions
- [ ] FU-10 · GitHub-sync v2 toggles UI
- [ ] FU-11 · Templates browser content swap to ADR-010 catalog

## Tier 3 (operator decisions — deferred)

- [ ] FU-12 · Transition lattice `done → in_progress` divergence
- [ ] FU-13 · Operator-binding for `AGENT_GIT_FACADE`
- [ ] FU-14 · Phase 4 Git-mode AgentFileService writes

## Log

(timestamps in UTC)
