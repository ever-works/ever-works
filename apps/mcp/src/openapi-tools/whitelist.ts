export interface WhitelistEntry {
	method: string;
	path: string;
	toolName?: string;
	description?: string;
	annotations?: {
		readOnlyHint?: boolean;
		destructiveHint?: boolean;
	};
}

export const WHITELIST: WhitelistEntry[] = [
	// Works (12)
	{
		method: 'GET',
		path: '/api/works',
		toolName: 'list_works',
		annotations: { readOnlyHint: true }
	},
	{ method: 'POST', path: '/api/works', toolName: 'create_work' },
	{
		method: 'GET',
		path: '/api/works/{id}',
		toolName: 'get_work',
		annotations: { readOnlyHint: true }
	},
	{ method: 'PUT', path: '/api/works/{id}', toolName: 'update_work' },
	{
		method: 'POST',
		path: '/api/works/{id}/delete',
		toolName: 'delete_work',
		annotations: { destructiveHint: true }
	},
	{
		method: 'GET',
		path: '/api/works/{id}/config',
		toolName: 'get_work_config',
		annotations: { readOnlyHint: true }
	},
	{
		method: 'GET',
		path: '/api/works/{id}/items',
		toolName: 'get_work_items',
		annotations: { readOnlyHint: true }
	},
	{
		method: 'GET',
		path: '/api/works/{id}/categories-tags',
		toolName: 'get_categories_tags',
		annotations: { readOnlyHint: true }
	},
	{
		method: 'GET',
		path: '/api/works/{id}/history',
		toolName: 'get_work_history',
		annotations: { readOnlyHint: true }
	},
	{ method: 'POST', path: '/api/works/{id}/regenerate-markdown', toolName: 'regenerate_markdown' },
	{ method: 'POST', path: '/api/works/{id}/update-website', toolName: 'update_website' },
	{ method: 'POST', path: '/api/works/{id}/process-community-prs', toolName: 'process_community_prs' },

	// Generation (4)
	{ method: 'POST', path: '/api/works/{id}/generate', toolName: 'generate_items' },
	{ method: 'POST', path: '/api/works/{id}/update', toolName: 'update_items' },
	{ method: 'POST', path: '/api/works/generate-details', toolName: 'generate_work_details' },
	{
		method: 'GET',
		path: '/api/works/{id}/generator-form',
		toolName: 'get_generator_form',
		annotations: { readOnlyHint: true }
	},

	// Items (4)
	{ method: 'POST', path: '/api/works/{id}/submit-item', toolName: 'submit_item' },
	{ method: 'POST', path: '/api/works/{id}/remove-item', toolName: 'remove_item' },
	{ method: 'POST', path: '/api/works/{id}/update-item', toolName: 'update_item' },
	{ method: 'POST', path: '/api/extract-item-details', toolName: 'extract_item_details' },

	// Deploy (4)
	{ method: 'POST', path: '/api/deploy/works/{id}', toolName: 'deploy_work' },
	{
		method: 'GET',
		path: '/api/deploy/works/{id}/domains',
		toolName: 'list_domains',
		annotations: { readOnlyHint: true }
	},
	{
		method: 'GET',
		path: '/api/deploy/providers',
		toolName: 'list_deploy_providers',
		annotations: { readOnlyHint: true }
	},
	{ method: 'POST', path: '/api/deploy/works/{id}/check', toolName: 'check_deploy_capability' },

	// Plugins (5)
	{
		method: 'GET',
		path: '/api/plugins',
		toolName: 'list_plugins',
		annotations: { readOnlyHint: true }
	},
	{
		method: 'GET',
		path: '/api/plugins/{pluginId}',
		toolName: 'get_plugin',
		annotations: { readOnlyHint: true }
	},
	{ method: 'POST', path: '/api/plugins/{pluginId}/enable', toolName: 'enable_plugin' },
	{ method: 'POST', path: '/api/plugins/{pluginId}/disable', toolName: 'disable_plugin' },
	{ method: 'PATCH', path: '/api/plugins/{pluginId}/settings', toolName: 'update_plugin_settings' },

	// Scheduling (4)
	{
		method: 'GET',
		path: '/api/works/{id}/schedule',
		toolName: 'get_schedule',
		annotations: { readOnlyHint: true }
	},
	{ method: 'PUT', path: '/api/works/{id}/schedule', toolName: 'update_schedule' },
	{
		method: 'DELETE',
		path: '/api/works/{id}/schedule',
		toolName: 'cancel_schedule',
		annotations: { destructiveHint: true }
	},
	{ method: 'POST', path: '/api/works/{id}/schedule/run', toolName: 'run_scheduled_update' },

	// Comparisons (5)
	{
		method: 'GET',
		path: '/api/works/{id}/comparisons',
		toolName: 'list_comparisons',
		annotations: { readOnlyHint: true }
	},
	{
		method: 'GET',
		path: '/api/works/{id}/comparisons/{slug}',
		toolName: 'get_comparison',
		annotations: { readOnlyHint: true }
	},
	{ method: 'POST', path: '/api/works/{id}/comparisons/generate', toolName: 'generate_comparison' },
	{
		method: 'POST',
		path: '/api/works/{id}/comparisons/generate-manual',
		toolName: 'generate_manual_comparison'
	},
	{
		method: 'DELETE',
		path: '/api/works/{id}/comparisons/{slug}',
		toolName: 'delete_comparison',
		annotations: { destructiveHint: true }
	},

	// ────────────────────────────────────────────────────────────
	// Phase 9 PR Z2 — Missions / Ideas / account-wide usage.
	// Mirrors the web-side chat tools (PR Z1) so external MCP
	// clients (Cursor, Claude Desktop, etc.) reach the same verbs.
	// Tool names use the dashed-resource convention already used
	// above (snake_case actions + singular nouns). All routes are
	// ownership-gated server-side via `@CurrentUser()` + the
	// per-service `getForUser` 404 path — no extra MCP-side ACL
	// needed.
	// ────────────────────────────────────────────────────────────

	// Missions (11)
	{
		method: 'GET',
		path: '/api/me/missions',
		toolName: 'list_missions',
		annotations: { readOnlyHint: true }
	},
	{ method: 'POST', path: '/api/me/missions', toolName: 'create_mission' },
	{
		method: 'GET',
		path: '/api/me/missions/{id}',
		toolName: 'get_mission',
		annotations: { readOnlyHint: true }
	},
	{
		method: 'GET',
		path: '/api/me/missions/{id}/budget',
		toolName: 'get_mission_budget',
		annotations: { readOnlyHint: true }
	},
	{ method: 'PATCH', path: '/api/me/missions/{id}', toolName: 'update_mission' },
	{
		method: 'DELETE',
		path: '/api/me/missions/{id}',
		toolName: 'delete_mission',
		annotations: { destructiveHint: true }
	},
	{ method: 'POST', path: '/api/me/missions/{id}/pause', toolName: 'pause_mission' },
	{ method: 'POST', path: '/api/me/missions/{id}/resume', toolName: 'resume_mission' },
	{ method: 'POST', path: '/api/me/missions/{id}/complete', toolName: 'complete_mission' },
	{ method: 'POST', path: '/api/me/missions/{id}/clone', toolName: 'clone_mission' },
	{ method: 'POST', path: '/api/me/missions/{id}/run-now', toolName: 'run_mission_now' },

	// Ideas / Work-Proposals (13)
	{ method: 'POST', path: '/api/me/work-proposals', toolName: 'create_idea' },
	{
		method: 'GET',
		path: '/api/me/work-proposals',
		toolName: 'list_ideas',
		annotations: { readOnlyHint: true }
	},
	{
		method: 'GET',
		path: '/api/me/work-proposals/status',
		toolName: 'get_ideas_refresh_status',
		annotations: { readOnlyHint: true }
	},
	{ method: 'POST', path: '/api/me/work-proposals/refresh', toolName: 'refresh_ideas' },
	{
		method: 'GET',
		path: '/api/me/work-proposals/preferences',
		toolName: 'get_idea_preferences',
		annotations: { readOnlyHint: true }
	},
	{
		method: 'PUT',
		path: '/api/me/work-proposals/preferences',
		toolName: 'update_idea_preferences'
	},
	{
		method: 'GET',
		path: '/api/me/work-proposals/{id}',
		toolName: 'get_idea',
		annotations: { readOnlyHint: true }
	},
	{
		method: 'GET',
		path: '/api/me/work-proposals/{id}/budget',
		toolName: 'get_idea_budget',
		annotations: { readOnlyHint: true }
	},
	{
		method: 'PATCH',
		path: '/api/me/work-proposals/{id}/dismiss',
		toolName: 'dismiss_idea',
		annotations: { destructiveHint: true }
	},
	{ method: 'POST', path: '/api/me/work-proposals/{id}/build', toolName: 'build_idea' },
	{ method: 'POST', path: '/api/me/work-proposals/{id}/retry', toolName: 'retry_idea' },
	{ method: 'POST', path: '/api/me/work-proposals/{id}/rebuild', toolName: 'rebuild_idea' },
	{ method: 'POST', path: '/api/me/work-proposals/{id}/accept', toolName: 'accept_idea' },

	// Account-wide usage (1)
	{
		method: 'GET',
		path: '/api/me/usage/account-wide',
		toolName: 'get_account_usage',
		annotations: { readOnlyHint: true }
	}
];
