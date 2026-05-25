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

    // Agents / Skills / Tasks (PR #1017 specs — architecture §10).
    // Lifecycle + heartbeat + file edits + budget + skills + tasks.
    // Storage stays `varchar` (no Postgres ENUM); the API layer is the
    // single source of allowed strings.
    AGENT_CREATED = 'agent_created',
    AGENT_PAUSED = 'agent_paused',
    AGENT_RESUMED = 'agent_resumed',
    AGENT_ARCHIVED = 'agent_archived',
    AGENT_DELETED = 'agent_deleted',
    AGENT_HEARTBEAT_STARTED = 'agent_heartbeat_started',
    AGENT_HEARTBEAT_COMPLETED = 'agent_heartbeat_completed',
    AGENT_HEARTBEAT_FAILED = 'agent_heartbeat_failed',
    AGENT_RUN_CANCELLED = 'agent_run_cancelled',
    AGENT_FILE_EDITED = 'agent_file_edited',
    AGENT_FILE_REVERTED = 'agent_file_reverted',
    AGENT_FILE_EDIT_FAILED = 'agent_file_edit_failed',
    AGENT_BUDGET_EXCEEDED = 'agent_budget_exceeded',
    AGENT_EXPORTED = 'agent_exported',
    AGENT_IMPORTED = 'agent_imported',
    SKILL_INSTALLED = 'skill_installed',
    SKILL_ATTACHED_TO_AGENT = 'skill_attached_to_agent',
    SKILL_INVOKED = 'skill_invoked',
    SKILL_FILE_EDITED = 'skill_file_edited',
    TASK_CREATED = 'task_created',
    TASK_UPDATED = 'task_updated',
    TASK_ASSIGNED = 'task_assigned',
    TASK_COMMENTED = 'task_commented',
    TASK_COMPLETED = 'task_completed',
    TASK_RECURRENCE_FIRED = 'task_recurrence_fired',
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
