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
    // No `users` foreign key at all: without the hand-over these would be left
    // pointing at a deleted account (or swept below as personal rows).
    { table: 'workflows', column: 'userId', scope: 'tenantId' },
    { table: 'environments', column: 'userId', scope: 'tenantId' },
    { table: 'inbound_triggers', column: 'userId', scope: 'tenantId' },
    { table: 'memory_facts', column: 'userId', scope: 'tenantId' },
    { table: 'meetings', column: 'userId', scope: 'organizationId' },
    { table: 'model_accounts', column: 'userId', scope: 'tenantId' },
    { table: 'model_policies', column: 'userId', scope: 'tenantId' },
    { table: 'repo_connections', column: 'userId', scope: 'tenantId' },
    { table: 'tool_grants', column: 'userId', scope: 'tenantId' },
    { table: 'autonomy_grants', column: 'userId', scope: 'tenantId' },
];

/**
 * Personal rows that point at the account WITHOUT a `users` foreign key, so
 * no cascade removes them: settings, credentials, read markers, consents.
 * `AccountDeletionService` deletes them before the account row, except, for a
 * table with a workspace column, rows inside a workspace that stays (content
 * there was handed over above; the rest belongs to the workspace).
 *
 * Kept on purpose (not listed): financial and audit trails that name the
 * account only by its id (credit ledger entries, licence purchases, fleet and
 * runtime audit logs, domain events). They become pseudonymous once the
 * account row is gone.
 */
export interface PersonalRowColumn {
    table: string;
    column: string;
    scope?: 'tenantId' | 'organizationId';
}

export const PERSONAL_ROWS_WITHOUT_FK: PersonalRowColumn[] = [
    { table: 'user_plugins', column: 'userId' },
    { table: 'user_sync_configs', column: 'userId' },
    { table: 'user_task_counter', column: 'userId' },
    { table: 'user_template_preferences', column: 'userId' },
    { table: 'product_changelog_reads', column: 'userId' },
    { table: 'terms_acceptance', column: 'userId' },
    { table: 'account', column: 'userId' },
    { table: 'onboarding_checklists', column: 'userId', scope: 'organizationId' },
    { table: 'knowledge_document_reader_states', column: 'userId', scope: 'tenantId' },
    { table: 'inbox_items', column: 'userId', scope: 'tenantId' },
    { table: 'github_app_user_links', column: 'userId', scope: 'tenantId' },
    { table: 'workspace_backups', column: 'userId', scope: 'tenantId' },
    { table: 'fleet_execution_preferences', column: 'userId', scope: 'organizationId' },
    { table: 'fleet_agent_node_affinities', column: 'userId', scope: 'organizationId' },
    { table: 'node_agent_profiles', column: 'userId', scope: 'organizationId' },
    // Reached only when not handed over above (no workspace, or a workspace that goes).
    { table: 'model_accounts', column: 'userId', scope: 'tenantId' },
    { table: 'model_policies', column: 'userId', scope: 'tenantId' },
    { table: 'repo_connections', column: 'userId', scope: 'tenantId' },
    { table: 'workflows', column: 'userId', scope: 'tenantId' },
    { table: 'environments', column: 'userId', scope: 'tenantId' },
    { table: 'inbound_triggers', column: 'userId', scope: 'tenantId' },
    { table: 'memory_facts', column: 'userId', scope: 'tenantId' },
    { table: 'memory_folders', column: 'userId', scope: 'tenantId' },
    { table: 'meetings', column: 'userId', scope: 'organizationId' },
    { table: 'tool_grants', column: 'userId', scope: 'tenantId' },
    { table: 'autonomy_grants', column: 'userId', scope: 'tenantId' },
];
