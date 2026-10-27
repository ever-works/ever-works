/**
 * Workspace CONTENT a departing account created, which must stay with the
 * workspace when the account is deleted but the workspace is not.
 *
 * Each of these rows points at its creator through a `users` foreign key with
 * `ON DELETE CASCADE`, so deleting the account would silently delete the
 * Organization's Works, Agents, Missions, Tasks… with it. Before the account
 * row goes, `AccountDeletionService.handOver` re-attributes the rows below —
 * only those inside the workspace (`scope` column = that Tenant) — to the
 * workspace's (new) owner.
 *
 * Deliberately NOT here — personal, so they go with the account: sessions,
 * refresh tokens, API keys, external identities, notification preferences /
 * mutes / subscriptions, the user's own notifications, activity log, uploads,
 * MCP / Composio connections (they hold the user's credentials), app launcher
 * preferences, the account's subscription rows and its billing profile.
 *
 * A table or column the running schema does not have is skipped, so this list
 * can lead or trail a migration safely. Keep it in step with
 * `docs/specs/features/account-deletion/data-inventory.md`.
 */
export interface ContentOwnerColumn {
    table: string;
    /** The column naming the creator (`users.id`). */
    column: string;
    /** The column that places the row in a workspace. */
    scope: 'tenantId' | 'organizationId';
}

export const TENANT_CONTENT_OWNER_COLUMNS: ContentOwnerColumn[] = [
    { table: 'works', column: 'userId', scope: 'tenantId' },
    { table: 'work_proposals', column: 'userId', scope: 'tenantId' },
    { table: 'work_schedules', column: 'userId', scope: 'tenantId' },
    { table: 'idea_works', column: 'userId', scope: 'tenantId' },
    { table: 'upstream_pull_requests', column: 'userId', scope: 'tenantId' },
    { table: 'agents', column: 'userId', scope: 'tenantId' },
    { table: 'agent_mcp_server_bindings', column: 'userId', scope: 'tenantId' },
    { table: 'missions', column: 'userId', scope: 'tenantId' },
    { table: 'mission_works', column: 'userId', scope: 'tenantId' },
    { table: 'mission_goals', column: 'userId', scope: 'tenantId' },
    { table: 'goals', column: 'userId', scope: 'tenantId' },
    { table: 'tasks', column: 'userId', scope: 'tenantId' },
    { table: 'task_templates', column: 'userId', scope: 'tenantId' },
    { table: 'teams', column: 'userId', scope: 'tenantId' },
    { table: 'skills', column: 'userId', scope: 'tenantId' },
    { table: 'skill_files', column: 'userId', scope: 'tenantId' },
    { table: 'skill_tags', column: 'userId', scope: 'tenantId' },
    { table: 'skill_bindings', column: 'userId', scope: 'tenantId' },
    { table: 'template_customizations', column: 'userId', scope: 'tenantId' },
    { table: 'tenant_email_addresses', column: 'userId', scope: 'tenantId' },
    { table: 'memory_folders', column: 'userId', scope: 'organizationId' },
    { table: 'usage_ledger_entries', column: 'userId', scope: 'tenantId' },
    { table: 'plugin_usage_events', column: 'userId', scope: 'tenantId' },
];
