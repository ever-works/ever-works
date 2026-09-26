export enum ActivityActionType {
    // Generation
    GENERATION = 'generation',
    COMPARISON_GENERATION = 'comparison_generation',

    // Deployment
    DEPLOYMENT = 'deployment',

    // Work lifecycle
    WORK_CREATED = 'work_created',
    WORK_UPDATED = 'work_updated',
    WORK_DELETED = 'work_deleted',

    // Items
    ITEM_ADDED = 'item_added',
    ITEM_UPDATED = 'item_updated',
    ITEM_REMOVED = 'item_removed',

    // Plugins
    PLUGIN_ENABLED = 'plugin_enabled',
    PLUGIN_DISABLED = 'plugin_disabled',
    PLUGIN_CONFIGURED = 'plugin_configured',
    // EW-693 — dynamic plugin distribution install lifecycle.
    PLUGIN_INSTALLED = 'plugin_installed',
    PLUGIN_INSTALL_FAILED = 'plugin_install_failed',
    PLUGIN_UNINSTALLED = 'plugin_uninstalled',

    // Templates
    TEMPLATE_ADDED = 'template_added',
    TEMPLATE_UPDATED = 'template_updated',
    TEMPLATE_ARCHIVED = 'template_archived',
    TEMPLATE_FORKED = 'template_forked',
    TEMPLATE_DEFAULT_SET = 'template_default_set',

    // Members
    MEMBER_INVITED = 'member_invited',
    MEMBER_ROLE_CHANGED = 'member_role_changed',
    MEMBER_REMOVED = 'member_removed',

    // Schedule
    SCHEDULE_CREATED = 'schedule_created',
    SCHEDULE_UPDATED = 'schedule_updated',
    SCHEDULE_DELETED = 'schedule_deleted',
    SCHEDULE_EXECUTED = 'schedule_executed',

    // Import / Export
    IMPORT = 'import',
    EXPORT = 'export',

    // Settings
    SETTINGS_UPDATED = 'settings_updated',
    WEBSITE_SETTINGS_UPDATED = 'website_settings_updated',
    PROMPTS_UPDATED = 'prompts_updated',
    WORKS_CONFIG_SYNC = 'works_config_sync',

    // Auth / Account
    USER_LOGIN = 'user_login',
    USER_SIGNUP = 'user_signup',
    PROVIDER_CONNECTED = 'provider_connected',
    PASSWORD_CHANGED = 'password_changed',

    // Chat / AI
    CHAT_CONVERSATION = 'chat_conversation',

    // Community
    COMMUNITY_PR_MERGED = 'community_pr_merged',

    // Website-sourced events ingested from the deployed directory site
    // via POST /api/activity-log/ingest (EW-120). The work owner sees
    // these in the per-Work Activity Feed tab.
    WEBSITE_USER_REGISTERED = 'website_user_registered',
    WEBSITE_ITEM_SUBMITTED = 'website_item_submitted',
    WEBSITE_REPORT_FILED = 'website_report_filed',
    WEBSITE_REPORT_RESOLVED = 'website_report_resolved',

    // EW-628 data-repo instant-sync — terminal outcomes of `runDataSync()`
    // emitted by `DataSyncService`. The `details` JSON payload carries the
    // discriminated `SyncEvent` union the activity feed renders via
    // `SyncEventRow` (source / reason / errorClass / errorTail / SHAs /
    // filesChanged).
    DATA_SYNC_SUCCESS = 'data_sync_success',
    DATA_SYNC_SKIPPED = 'data_sync_skipped',
    DATA_SYNC_FAILED = 'data_sync_failed',

    // EW-641 — Knowledge Base lifecycle. See
    // `docs/specs/features/knowledge-base/spec.md` §19.1 for the full
    // list of kinds; this PR adds the upload + document subset needed by
    // the Phase 1B/b ingest pipeline. Lock/restore/index/tag kinds will
    // land when those flows are wired.
    KB_UPLOAD_CREATED = 'kb_upload_created',
    KB_UPLOAD_DEDUPED = 'kb_upload_deduped',
    KB_UPLOAD_EXTRACTED = 'kb_upload_extracted',
    KB_UPLOAD_EXTRACTION_FAILED = 'kb_upload_extraction_failed',
    KB_UPLOAD_EXTRACTION_SKIPPED = 'kb_upload_extraction_skipped',
    KB_DOCUMENT_CREATED = 'kb_document_created',
    KB_DOCUMENT_UPDATED = 'kb_document_updated',
    KB_DOCUMENT_DELETED = 'kb_document_deleted',
    // EW-643 Phase 3 — lock semantics + reconciliation. Spec §19.1 + §9.6.
    // LOCKED/UNLOCKED fire on POST /lock and /unlock; RESTORED fires on
    // restore-from-history; LOCK_VIOLATION fires from the daily Git ↔ DB
    // reconcile job when a locked document was mutated by a direct Git
    // push (workbench surfaces this as a banner with accept/revert).
    KB_DOCUMENT_LOCKED = 'kb_document_locked',
    KB_DOCUMENT_UNLOCKED = 'kb_document_unlocked',
    KB_DOCUMENT_RESTORED = 'kb_document_restored',
    KB_DOCUMENT_LOCK_VIOLATION = 'kb_document_lock_violation',
    // Reconciliation sweep terminal outcomes. `details` carries `{ scanned,
    // driftCount, violationCount, orphanCount }`. Orphan tombstoning +
    // 7-day grace land alongside (KB_UPLOAD_TOMBSTONED on first detection,
    // KB_UPLOAD_REVIVED when re-uploaded within the grace window).
    KB_RECONCILE_COMPLETED = 'kb_reconcile_completed',
    KB_UPLOAD_TOMBSTONED = 'kb_upload_tombstoned',
    KB_UPLOAD_REVIVED = 'kb_upload_revived',
    // Context-budget truncation in KbPromptFormatter. Emitted with
    // `{ requestedTokens, budgetTokens, droppedClasses }` for budget tuning.
    KB_CONTEXT_TRUNCATED = 'kb_context_truncated',
    // Transcription pipeline (EW-643 — Whisper / Anthropic). Mirrors the
    // upload-extraction event shape; transcription is "extraction for media".
    KB_UPLOAD_TRANSCRIBED = 'kb_upload_transcribed',
    KB_UPLOAD_TRANSCRIPTION_FAILED = 'kb_upload_transcription_failed',
    // Memory Files (/memory Files area) — the user-visible folder-tree
    // state changes. `details` carries `{ folderId, path }` plus
    // `{ ownerAgentId }` on create, `{ deletedFolders, unlinkedFiles }`
    // on delete (files are only UNFILED — bytes are never destroyed),
    // and `{ committed, skipped, failed, commitSha }` on a manual sync.
    MEMORY_FOLDER_CREATED = 'memory_folder_created',
    MEMORY_FOLDER_DELETED = 'memory_folder_deleted',
    MEMORY_FOLDER_SYNCED = 'memory_folder_synced',
    // Knowledge library — curation of the shared shelf. Read / unread and
    // pins are personal and high-frequency, so they are never logged.
    //   ARCHIVED   `{ documentId, workId, organizationId, folderId }`
    //   UNARCHIVED `{ documentId, workId, organizationId, folderId, restoredToUnfiled }`
    //   FILED      `{ documentId, workId, organizationId, fromFolderId, toFolderId }`
    //   EXPORTED   `{ documentIds, format, documentCount, missingCount }`
    //   MEMORY_FOLDER_RENAMED `{ folderId, oldPath, newPath, scope }`
    KB_DOCUMENT_ARCHIVED = 'kb_document_archived',
    KB_DOCUMENT_UNARCHIVED = 'kb_document_unarchived',
    KB_DOCUMENT_FILED = 'kb_document_filed',
    KB_DOCUMENT_EXPORTED = 'kb_document_exported',
    MEMORY_FOLDER_RENAMED = 'memory_folder_renamed',
    // EW-643 Phase 3 slice 4b — wikilink rename rewriter. Fires when a
    // KB document is renamed and the rewriter sweeps the rest of the
    // Work's docs replacing `[[oldPath]]` with `[[newPath]]`. Details
    // carry `{ oldPath, newPath, documentsTouched }` so the activity
    // feed can render a single-line summary without re-querying.
    KB_WIKILINK_REWRITTEN = 'kb_wikilink_rewritten',
    // EW-642 D7 — `kb-reembed-work` Trigger.dev task lifecycle. Emitted
    // by `KnowledgeBaseReembedService` when an operator changes the
    // embedding model (or dims) and the platform must re-embed every
    // `(workId, documentId)` coordinate still pinned on the old model.
    // `details` carries `{ count, fromModel, toModel }` at start and
    // `{ durationMs, chunksReembedded, documentsReembedded }` at the
    // happy-path end; the failed variant adds `{ error }` with the
    // wrapped error message so the workbench banner can surface it.
    KB_REEMBED_STARTED = 'kb_reembed_started',
    KB_REEMBED_COMPLETED = 'kb_reembed_completed',
    KB_REEMBED_FAILED = 'kb_reembed_failed',

    // Agents / Skills / Tasks (PR #1017 specs — architecture §10).
    // Lifecycle + heartbeat + file edits + budget + skills + tasks.
    // Storage stays `varchar` (no Postgres ENUM); the API layer is the
    // single source of allowed strings.
    // PR-3 (domain-model evolution) — Mission lifecycle (closes audit gap G3)
    MISSION_CREATED = 'mission_created',
    MISSION_PAUSED = 'mission_paused',
    MISSION_RESUMED = 'mission_resumed',
    MISSION_COMPLETED = 'mission_completed',
    MISSION_FAILED = 'mission_failed',
    MISSION_DELETED = 'mission_deleted',
    MISSION_TICK_CAPPED = 'mission_tick_capped',
    // Autonomy layer — Goal execution loop. Additive members only
    // (activity_log.actionType is a plain varchar, so no migration):
    //   - GOAL_LOOP_STARTED / _PAUSED / _RESUMED / _CANCELLED are the
    //     operator control actions on the iteration loop.
    //   - GOAL_ITERATION_DISPATCHED fires once per routed iteration and
    //     carries `{ iteration, agentId, taskId, reasonCode }` so "who
    //     decided this run should happen?" is answerable.
    //   - GOAL_LIMIT_TRIPPED records a budget / wall-clock / stuck ceiling
    //     stopping the loop; `details` carries the reason code.
    //   - GOAL_DOD_UPDATED covers every Definition-of-Done write,
    //     including waivers (which carry the operator's note).
    //   - GOAL_ARCHIVED / _UNARCHIVED are the catalog-visibility actions.
    GOAL_LOOP_STARTED = 'goal_loop_started',
    GOAL_LOOP_PAUSED = 'goal_loop_paused',
    GOAL_LOOP_RESUMED = 'goal_loop_resumed',
    GOAL_LOOP_CANCELLED = 'goal_loop_cancelled',
    GOAL_LOOP_COMPLETED = 'goal_loop_completed',
    GOAL_ITERATION_DISPATCHED = 'goal_iteration_dispatched',
    GOAL_ITERATION_NUDGED = 'goal_iteration_nudged',
    GOAL_LIMIT_TRIPPED = 'goal_limit_tripped',
    GOAL_DOD_UPDATED = 'goal_dod_updated',
    GOAL_ARCHIVED = 'goal_archived',
    GOAL_UNARCHIVED = 'goal_unarchived',

    // PR-3 — Idea (WorkProposal) lifecycle
    IDEA_GENERATED = 'idea_generated',
    IDEA_DISMISSED = 'idea_dismissed',
    IDEA_QUEUED = 'idea_queued',
    IDEA_ACCEPTED = 'idea_accepted',
    IDEA_FAILED = 'idea_failed',
    IDEA_REBUILD_STARTED = 'idea_rebuild_started',
    IDEA_DELETED = 'idea_deleted',
    AGENT_CREATED = 'agent_created',
    AGENT_PAUSED = 'agent_paused',
    AGENT_RESUMED = 'agent_resumed',
    AGENT_ARCHIVED = 'agent_archived',
    AGENT_UNARCHIVED = 'agent_unarchived',
    AGENT_DELETED = 'agent_deleted',
    AGENT_HEARTBEAT_STARTED = 'agent_heartbeat_started',
    AGENT_HEARTBEAT_COMPLETED = 'agent_heartbeat_completed',
    AGENT_HEARTBEAT_FAILED = 'agent_heartbeat_failed',
    AGENT_RUN_CANCELLED = 'agent_run_cancelled',
    // FU-2 — manual run-now / assign-task affordances on the controller.
    AGENT_RUN_TRIGGERED = 'agent_run_triggered',
    AGENT_TASK_ASSIGNED = 'agent_task_assigned',
    AGENT_FILE_EDITED = 'agent_file_edited',
    AGENT_FILE_REVERTED = 'agent_file_reverted',
    AGENT_FILE_EDIT_FAILED = 'agent_file_edit_failed',
    AGENT_BUDGET_EXCEEDED = 'agent_budget_exceeded',
    AGENT_EXPORTED = 'agent_exported',
    AGENT_IMPORTED = 'agent_imported',
    // Agent Collaborators — edits to the per-agent sub-agent delegation
    // allow-list. These are security-relevant: enabling a collaborator
    // widens which agents this one may spawn, so the trail records the
    // pair (details.collaboratorAgentId) alongside the parent agent.
    // Additive members only — `activity_log.actionType` is a plain
    // varchar, so no migration.
    // AW-23 — the agent brake and the stated halt reason. Additive
    // members only; `activity_log.actionType` is a plain varchar, so no
    // migration.
    //
    // 🛑 `AGENT_BLOCKED_ON_CREDENTIAL` carries a display name and a
    // coarse kind and NEVER any part of a credential.
    AGENT_BLOCKED_ON_CREDENTIAL = 'agent_blocked_on_credential',
    /** The brake parked a run because the agent is paused. Nothing failed. */
    AGENT_RUN_HELD = 'agent_run_held',
    /** A Resume released held work. */
    AGENT_RUNS_RELEASED = 'agent_runs_released',
    AGENT_COLLABORATOR_ENABLED = 'agent_collaborator_enabled',
    AGENT_COLLABORATOR_DISABLED = 'agent_collaborator_disabled',
    AGENT_COLLABORATOR_REMOVED = 'agent_collaborator_removed',
    // Agent computers — a person took control of the machine an Agent works
    // on and gave it back (or it was released automatically). Written once
    // per stretch of control, when it ends, with how long it lasted and why
    // it ended; `details.resourceId` is the Agent so it lands in that
    // Agent's feed. Additive — `activity_log.actionType` is a plain varchar.
    AGENT_COMPUTER_CONTROLLED = 'agent_computer_controlled',
    // Environments (Settings → Environments) — named, reusable runtime
    // recipes assigned per-Agent. Emitted by the api-side controller.
    ENVIRONMENT_CREATED = 'environment_created',
    ENVIRONMENT_UPDATED = 'environment_updated',
    ENVIRONMENT_PUBLISHED = 'environment_published',
    ENVIRONMENT_DELETED = 'environment_deleted',
    SKILL_INSTALLED = 'skill_installed',
    SKILL_ATTACHED_TO_AGENT = 'skill_attached_to_agent',
    SKILL_INVOKED = 'skill_invoked',
    SKILL_FILE_EDITED = 'skill_file_edited',
    // Skills shelf — the workspace-level on/off switch. Appended only; the
    // column is a varchar, so no migration.
    SKILL_ENABLED = 'skill_enabled',
    SKILL_DISABLED = 'skill_disabled',
    // Repository registry (Feature G) — Settings → Repositories rows +
    // the Agent ↔ repo grant edge. Additive entries only (NN #20).
    REPO_CONNECTION_CREATED = 'repo_connection_created',
    REPO_CONNECTION_UPDATED = 'repo_connection_updated',
    REPO_CONNECTION_DELETED = 'repo_connection_deleted',
    REPO_CONNECTION_IMPORTED = 'repo_connection_imported',
    REPO_ATTACHED_TO_AGENT = 'repo_attached_to_agent',
    REPO_DETACHED_FROM_AGENT = 'repo_detached_from_agent',
    TASK_CREATED = 'task_created',
    TASK_UPDATED = 'task_updated',
    TASK_DELETED = 'task_deleted',
    TASK_ASSIGNED = 'task_assigned',
    TASK_ASSIGNEE_ADDED = 'task_assignee_added',
    TASK_ASSIGNEE_REMOVED = 'task_assignee_removed',
    TASK_BLOCKER_ADDED = 'task_blocker_added',
    TASK_BLOCKER_REMOVED = 'task_blocker_removed',
    TASK_TRANSITIONED = 'task_transitioned',
    TASK_COMMENTED = 'task_commented',
    TASK_COMPLETED = 'task_completed',
    TASK_RECURRENCE_FIRED = 'task_recurrence_fired',
    // Merge-policy matrix (Wave 3, D4) — the agent-merge path in
    // `TaskWorkspaceService.finalizeRun`. Both are additive members
    // (activity_log.actionType is a plain varchar, so no migration):
    //   - TASK_MERGED       the agent landed the Task's pull request; the
    //                       `details` block carries prNumber / mergeMethod /
    //                       policySource so "who allowed this?" is answerable.
    //   - TASK_MERGE_REFUSED the effective policy refused; `details` carries
    //                       the stable `refusalCode` + human `reason`. A
    //                       refusal is RECORDED, never swallowed.
    TASK_MERGED = 'task_merged',
    TASK_MERGE_REFUSED = 'task_merge_refused',

    // Missions / Ideas (Schedules P2 — automated tick + idea-generation
    // activity coverage). Both are additive members so no storage / API
    // migration is needed (activity_log.actionType is a plain varchar).
    //   - MISSION_TICK fires from `MissionTickService.tickDue` each time a
    //     scheduled Mission's cron matches and the tick actually runs
    //     (cron-no-match minutes are intentionally NOT logged).
    //   - IDEA_GENERATED (defined above in the PR-3 Idea cluster) fires from
    //     `WorkProposalService.generate` for MISSION-sourced runs — the
    //     domain-model train added the same literal, so it is not redefined here.
    MISSION_TICK = 'mission_tick',

    // Event-ingest spine (Wave 6) — one row per external event drained
    // from `ingested_events` by `EventIngestService.processBatch()`.
    // `metadata` carries the provenance block (source, kind,
    // sourceEventId, sourceUrl, actor/subject) so the feed and the AI
    // chat can link back to the original message / PR / page. Additive
    // member — storage is a plain varchar.
    EXTERNAL_EVENT_INGESTED = 'external_event_ingested',

    // Git activity ingestion (audit item j). Commits, pushes and merges
    // arrive on the consolidated GitHub receiver, are normalized into
    // `github.push` / `github.commit` / `github.merge` envelopes and
    // drained by the SAME spine that writes EXTERNAL_EVENT_INGESTED —
    // these three kinds simply resolve to their own action type
    // (`INGEST_ACTIVITY_ACTION_BY_KIND`) so the feed can tell "someone
    // pushed" apart from "some connector event landed". `details`
    // carries the routing block (repoFullName / ref / sha / prNumber /
    // taskId) the row was built from. Additive members — storage is a
    // plain varchar, so no migration is needed.
    GIT_PUSHED = 'git_pushed',
    GIT_COMMITTED = 'git_committed',
    GIT_MERGED = 'git_merged',

    // Agent Plugins MCP slice — manual MCP connection lifecycle + per-agent
    // binding changes. Additive members — storage is a plain varchar, so no
    // migration is needed. `details` carries `{ connectionId, name }` (and
    // `{ agentId, enabled }` for binding updates / `{ toolCount }` for tests);
    // header VALUES are never included.
    MCP_CONNECTION_CREATED = 'mcp_connection_created',
    MCP_CONNECTION_UPDATED = 'mcp_connection_updated',
    MCP_CONNECTION_DELETED = 'mcp_connection_deleted',
    MCP_CONNECTION_TESTED = 'mcp_connection_tested',
    MCP_BINDING_UPDATED = 'mcp_binding_updated',
    // Inbox (operator message center) — one row when a message lands in
    // the human's inbox and one when they answer it, so "what did the
    // agent ask, and what did I decide?" shows in the Activity feed
    // next to the run that asked. Additive members — storage is a plain
    // varchar, so no migration is needed.
    INBOX_ITEM_CREATED = 'inbox_item_created',
    INBOX_ITEM_ANSWERED = 'inbox_item_answered',
    // Memory facts + context files (AW-07). One row per create / edit /
    // forget / restore / accept / discard of a fact, one when every fact is
    // forgotten at once, one per context-file save / restore / load-mode
    // change, and one when a run's instructions exceed a segment budget.
    // `details` carries ids, counts and hashes — NEVER a fact or file body,
    // which can hold business-sensitive prose. Additive members — storage is
    // a plain varchar(50), so no migration is needed.
    MEMORY_FACT_CREATED = 'memory_fact_created',
    MEMORY_FACT_UPDATED = 'memory_fact_updated',
    MEMORY_FACT_FORGOTTEN = 'memory_fact_forgotten',
    MEMORY_FACT_RESTORED = 'memory_fact_restored',
    MEMORY_FACT_ACCEPTED = 'memory_fact_accepted',
    MEMORY_FACT_DISCARDED = 'memory_fact_discarded',
    MEMORY_FACTS_CLEARED = 'memory_facts_cleared',
    CONTEXT_FILE_UPDATED = 'context_file_updated',
    CONTEXT_FILE_RESTORED = 'context_file_restored',
    CONTEXT_FILE_MODE_CHANGED = 'context_file_mode_changed',
    CONTEXT_BUDGET_EXCEEDED = 'context_budget_exceeded',
    // Model accounts (AW-16) — one row per change to a workspace's provider
    // accounts or model defaults. `details` names the account and the field
    // that changed ({ accountId, label, providerPluginId, field } or
    // { fromPosition, toPosition }); a credential VALUE is never included.
    // Additive members — storage is a plain varchar, so no migration is needed.
    MODEL_ACCOUNT_ADDED = 'model_account_added',
    MODEL_ACCOUNT_UPDATED = 'model_account_updated',
    MODEL_ACCOUNT_REORDERED = 'model_account_reordered',
    MODEL_ACCOUNT_PAUSED = 'model_account_paused',
    MODEL_ACCOUNT_RESUMED = 'model_account_resumed',
    MODEL_ACCOUNT_RECONNECTED = 'model_account_reconnected',
    MODEL_ACCOUNT_REMOVED = 'model_account_removed',
    MODEL_POLICY_UPDATED = 'model_policy_updated',
    // Schedules workspace — one row each time an owner pauses or resumes a
    // cadence from any source (recurring Task, heartbeat, Mission tick,
    // inbound Trigger). `details` carries `{ scheduleId, sourceType,
    // control, before, after }`. Additive members — storage is a plain
    // varchar, so no migration is needed.
    SCHEDULE_PAUSED = 'schedule_paused',
    SCHEDULE_RESUMED = 'schedule_resumed',
    // Live Feed — a run starting and a run reaching a terminal state, for
    // every trigger kind other than `heartbeat` (heartbeat runs keep the
    // three `agent_heartbeat_*` members above, unchanged). Declared here so
    // the feed's kind map and narration cover them; the run lifecycle
    // emits them. Additive members — `activity_log.actionType` is a plain
    // varchar, so no migration is needed.
    AGENT_RUN_STARTED = 'agent_run_started',
    AGENT_RUN_COMPLETED = 'agent_run_completed',
    AGENT_RUN_FAILED = 'agent_run_failed',
    // Shared view (AW-18) — the Workspace owner turning sharing on or off,
    // regenerating the link, and changing what it publishes or whether
    // crawlers may index it. One row per changed facet. `details` never
    // carries the share token. Additive members — `activity_log.actionType`
    // is a plain varchar, so no migration is needed.
    SHARED_VIEW_ENABLED = 'shared_view_enabled',
    SHARED_VIEW_DISABLED = 'shared_view_disabled',
    SHARED_VIEW_REGENERATED = 'shared_view_regenerated',
    SHARED_VIEW_SECTIONS_CHANGED = 'shared_view_sections_changed',
    SHARED_VIEW_INDEXING_CHANGED = 'shared_view_indexing_changed',
    // AW-22 Workspace backup — the whole-workspace archive leaves a trace of
    // its own, so "when did I last back this up, and did anyone take a copy
    // off the platform?" is answerable from the workspace's own record
    // rather than from our logs (spec FR-32). Additive members —
    // `activity_log.actionType` is a plain varchar, so no migration is
    // needed. `details` carries `{ backupId, sizeBytes?, domainsCompleted? }`
    // and never a storage key.
    WORKSPACE_BACKUP_CREATED = 'workspace_backup_created',
    WORKSPACE_BACKUP_DOWNLOADED = 'workspace_backup_downloaded',
    WORKSPACE_BACKUP_DELETED = 'workspace_backup_deleted',
    // APW-11 (App Launcher) — the Work-level **Show in App Launcher**
    // setting changed. The dotted `action` carries the direction
    // (`app.launcher.exposed` / `app.launcher.hidden`, Resolution R-2) and
    // `metadata` carries `{ explicit, previousEffective }`; no field ever
    // names the Work or its address (spec FR-21, FR-61). Additive member —
    // `activity_log.actionType` is a plain varchar, so no migration is
    // needed. Program contract R-34 (Activity completeness) is satisfied by
    // this member plus its `FEED_KIND_RULES` entry in
    // `packages/agent/src/activity-log/feed-kind.ts`; the Shared-view
    // classification needs no edit because `NEVER_PUBLISH_ACTIVITY_ACTIONS`
    // is the derived complement of the publishable allow-list, so this
    // member is unpublished by construction.
    APP_LAUNCHER = 'app_launcher',
    // APW-02 (Fork lifecycle) — Resolution R-2: three families for the App
    // Work's fork readiness, its Actions hygiene and its upstream sync. The
    // dotted CONTRACTS §6 event goes in `action` (`app.fork.ready`,
    // `app.fork.timeout`, `app.fork.missing`, `app.actions.disabled`,
    // `app.upstream.synced`, `app.upstream.behind`, `app.upstream.conflict`,
    // `app.upstream.unavailable`) and `details` carry counts, shas, pull
    // request numbers and reason codes. Workflow paths appear ONLY in
    // `app.actions.disabled`: they are repository file names, never secrets.
    // Additive members — `activity_log.actionType` is a plain varchar, so no
    // migration is needed. Program contract R-34 (Activity completeness) is
    // satisfied by the three `FEED_KIND_RULES` entries in
    // `packages/agent/src/activity-log/feed-kind.ts`; the Shared-view
    // classification needs no edit because `NEVER_PUBLISH_ACTIVITY_ACTIONS`
    // is the derived complement of the publishable allow-list, so these three
    // are unpublished by construction.
    APP_FORK = 'app_fork',
    APP_ACTIONS = 'app_actions',
    APP_UPSTREAM = 'app_upstream',
    // APW-03 (App spec, Apps catalog and license gate) — Resolution R-2's
    // first family: the App spec read true. The dotted CONTRACTS §6 event goes
    // in `action` (`app.spec.validated`, `app.spec.invalid`, `app.spec.applied`
    // — plan §6.2:666-669) and `details` carry `{ commitSha, errorCount,
    // warningCount, codes: first 10 codes }` or the applied transition's
    // `{ commitSha, previousCommitSha, specHash, addedDependencies,
    // changedEnvNames, changedBlocks }`. Codes, counts and shas only: no
    // secret value and no `env` value ever reaches a row (R8, FR-6).
    //
    // Additive member — `activity_log.actionType` is a plain varchar, so no
    // migration is needed. Program contract R-34 (Activity completeness) is
    // satisfied by this member plus its `FEED_KIND_RULES` entry in
    // `packages/agent/src/activity-log/feed-kind.ts` (`feed-kind.spec.ts:14-19`
    // fails on a member without one); the Shared-view classification needs no
    // edit because `NEVER_PUBLISH_ACTIVITY_ACTIONS` is the derived complement of
    // the publishable allow-list, so this member is unpublished by construction.
    //
    // 🛑 APW-03 T2 owns APP_BLUEPRINT = 'app_blueprint' and
    // APP_LICENSE = 'app_license' and has NOT landed. T12 needs this one member
    // (its Activity rows are written with `actionType: APP_SPEC`) and appends it
    // here rather than declaring a second name for the same family. When T2
    // lands it appends its two and must NOT append this one again (a duplicate
    // enum member is a TypeScript error) — its ledger comment should count this
    // member as already present.
    APP_SPEC = 'app_spec',
    // APW-05 (Builds) — Resolution R-2's next family: one Activity row per
    // `app.build.*` transition, written by the ONE writer
    // `AppBuildsService.publish` (plan §7.8, `APW05-G05`). The dotted
    // CONTRACTS §6 event goes in `action` — `app.build.queued`,
    // `app.build.started`, `app.build.succeeded`, `app.build.failed`,
    // `app.build.cancelled` — and `metadata` carries `{ buildId, number,
    // commitSha, trigger, failureClass }`: names, ids and shas only, never a
    // value and never a log line (FR-40). A `blocked` Build publishes nothing,
    // because `blocked` is not one of the five CONTRACTS §6 names
    // (`plan.md:1560`).
    //
    // Additive member — `activity_log.actionType` is a plain varchar, so no
    // migration is needed. Program contract R-34 (Activity completeness) is
    // satisfied by this member plus its `FEED_KIND_RULES` entry in
    // `packages/agent/src/activity-log/feed-kind.ts` (`feed-kind.spec.ts:14-19`
    // fails on a member without one); the Shared-view classification needs no
    // edit because `NEVER_PUBLISH_ACTIVITY_ACTIONS` is the derived complement of
    // the publishable allow-list, so this member is unpublished by construction.
    APP_BUILD = 'app_build',
}

/**
 * Who performed an activity. `NULL` on rows written before the actor
 * columns existed; the Live Feed resolves those at read time.
 */
export type ActivityActorKind = 'agent' | 'user' | 'external' | 'system';

export enum ActivityStatus {
    PENDING = 'pending',
    IN_PROGRESS = 'in_progress',
    COMPLETED = 'completed',
    FAILED = 'failed',
    CANCELLED = 'cancelled',
}

export interface CreateActivityLogDto {
    userId: string;
    workId?: string;
    actionType: ActivityActionType;
    action: string;
    status: ActivityStatus;
    summary: string;
    details?: Record<string, any>;
    metadata?: Record<string, any>;
    ipAddress?: string;
    userAgent?: string;
    ingestEventId?: string;
    /**
     * Live Feed actor. All three are optional: a caller that knows the
     * acting agent passes them; `ActivityLogService.log()` derives
     * `actorKind`/`actorAgentId` from `details` when a caller does not.
     */
    actorKind?: ActivityActorKind | null;
    actorAgentId?: string | null;
    /** The actor's display name at the moment the record is written. */
    actorLabel?: string | null;
    /**
     * Explicit ownership stamp. Optional: when omitted the scope-stamping
     * subscriber fills both from the request scope, as it always has. A
     * writer acting on a Workspace named in the route (rather than the
     * request's active scope) passes it so the row lands in that Workspace.
     */
    tenantId?: string | null;
    organizationId?: string | null;
}

/**
 * Live Feed page query. Deliberately separate from
 * {@link ActivityLogQueryOptions}: the feed pages by a keyset cursor and
 * filters by actor and by derived kind, none of which the offset-paged
 * Activity log query understands. Ownership scope is passed alongside, never
 * inside, so no caller can widen it through a filter object.
 */
export interface ActivityFeedQueryOptions {
    userId: string;
    /**
     * Agent ids to restrict to. Matched on `actorAgentId` and, for rows
     * written before that column existed, on the agent reference the writer
     * put in `details` (`resourceType: 'agent'` + `resourceId`, or `agentId`).
     */
    agentIds?: string[];
    /** Restrict to rows that classify into one of these kinds. */
    kindFilter?: ActivityFeedKindFilter;
    /** Keyset cursor: rows strictly older than this `(createdAt, id)` pair. */
    cursor?: { createdAt: string; id: string };
    /** Oldest row the feed may return. */
    since: Date;
    limit: number;
}

/** The feed buckets, as the repository sees them. */
export type ActivityFeedKind = 'work' | 'decision' | 'delivery' | 'problem' | 'system';

/**
 * The action-type sets a kind filter is evaluated against. Built once by the
 * feed kind map so SQL filtering and in-memory classification cannot drift.
 */
export interface ActivityFeedKindSets {
    /** Any row with one of these statuses is a `problem`. */
    problemStatuses: string[];
    /** Any row with one of these action types is a `problem`. */
    problemActionTypes: string[];
    decisionActionTypes: string[];
    systemActionTypes: string[];
    deliveryActionTypes: string[];
    /** `delivery` when the row completed, otherwise `work`. */
    deliveryWhenCompletedActionTypes: string[];
}

export interface ActivityFeedKindFilter {
    kinds: ActivityFeedKind[];
    sets: ActivityFeedKindSets;
}

export interface ActivityLogQueryOptions {
    userId: string;
    actionType?: ActivityActionType;
    workId?: string;
    status?: ActivityStatus;
    dateFrom?: Date;
    dateTo?: Date;
    search?: string;
    limit?: number;
    offset?: number;
}
