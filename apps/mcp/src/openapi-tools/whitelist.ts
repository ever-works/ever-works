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
	}
];
