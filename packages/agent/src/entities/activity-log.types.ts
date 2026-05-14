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
