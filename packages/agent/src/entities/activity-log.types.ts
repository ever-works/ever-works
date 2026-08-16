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
    AGENT_COLLABORATOR_ENABLED = 'agent_collaborator_enabled',
    AGENT_COLLABORATOR_DISABLED = 'agent_collaborator_disabled',
    AGENT_COLLABORATOR_REMOVED = 'agent_collaborator_removed',
    SKILL_INSTALLED = 'skill_installed',
    SKILL_ATTACHED_TO_AGENT = 'skill_attached_to_agent',
    SKILL_INVOKED = 'skill_invoked',
    SKILL_FILE_EDITED = 'skill_file_edited',
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
}

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
