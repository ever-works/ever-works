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
	// Directories (12)
	{
		method: 'GET',
		path: '/api/directories',
		toolName: 'list_directories',
		annotations: { readOnlyHint: true }
	},
	{ method: 'POST', path: '/api/directories', toolName: 'create_directory' },
	{
		method: 'GET',
		path: '/api/directories/{id}',
		toolName: 'get_directory',
		annotations: { readOnlyHint: true }
	},
	{ method: 'PUT', path: '/api/directories/{id}', toolName: 'update_directory' },
	{
		method: 'POST',
		path: '/api/directories/{id}/delete',
		toolName: 'delete_directory',
		annotations: { destructiveHint: true }
	},
	{
		method: 'GET',
		path: '/api/directories/{id}/config',
		toolName: 'get_directory_config',
		annotations: { readOnlyHint: true }
	},
	{
		method: 'GET',
		path: '/api/directories/{id}/items',
		toolName: 'get_directory_items',
		annotations: { readOnlyHint: true }
	},
	{
		method: 'GET',
		path: '/api/directories/{id}/categories-tags',
		toolName: 'get_categories_tags',
		annotations: { readOnlyHint: true }
	},
	{
		method: 'GET',
		path: '/api/directories/{id}/history',
		toolName: 'get_directory_history',
		annotations: { readOnlyHint: true }
	},
	{ method: 'POST', path: '/api/directories/{id}/regenerate-markdown', toolName: 'regenerate_markdown' },
	{ method: 'POST', path: '/api/directories/{id}/update-website', toolName: 'update_website' },
	{ method: 'POST', path: '/api/directories/{id}/process-community-prs', toolName: 'process_community_prs' },

	// Generation (4)
	{ method: 'POST', path: '/api/directories/{id}/generate', toolName: 'generate_items' },
	{ method: 'POST', path: '/api/directories/{id}/update', toolName: 'update_items' },
	{ method: 'POST', path: '/api/directories/generate-details', toolName: 'generate_directory_details' },
	{
		method: 'GET',
		path: '/api/directories/{id}/generator-form',
		toolName: 'get_generator_form',
		annotations: { readOnlyHint: true }
	},

	// Items (4)
	{ method: 'POST', path: '/api/directories/{id}/submit-item', toolName: 'submit_item' },
	{ method: 'POST', path: '/api/directories/{id}/remove-item', toolName: 'remove_item' },
	{ method: 'POST', path: '/api/directories/{id}/update-item', toolName: 'update_item' },
	{ method: 'POST', path: '/api/extract-item-details', toolName: 'extract_item_details' },

	// Deploy (4)
	{ method: 'POST', path: '/api/deploy/directories/{id}', toolName: 'deploy_directory' },
	{
		method: 'GET',
		path: '/api/deploy/directories/{id}/domains',
		toolName: 'list_domains',
		annotations: { readOnlyHint: true }
	},
	{
		method: 'GET',
		path: '/api/deploy/providers',
		toolName: 'list_deploy_providers',
		annotations: { readOnlyHint: true }
	},
	{ method: 'POST', path: '/api/deploy/directories/{id}/check', toolName: 'check_deploy_capability' },

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
		path: '/api/directories/{id}/schedule',
		toolName: 'get_schedule',
		annotations: { readOnlyHint: true }
	},
	{ method: 'PUT', path: '/api/directories/{id}/schedule', toolName: 'update_schedule' },
	{
		method: 'DELETE',
		path: '/api/directories/{id}/schedule',
		toolName: 'cancel_schedule',
		annotations: { destructiveHint: true }
	},
	{ method: 'POST', path: '/api/directories/{id}/schedule/run', toolName: 'run_scheduled_update' },

	// Comparisons (5)
	{
		method: 'GET',
		path: '/api/directories/{id}/comparisons',
		toolName: 'list_comparisons',
		annotations: { readOnlyHint: true }
	},
	{
		method: 'GET',
		path: '/api/directories/{id}/comparisons/{slug}',
		toolName: 'get_comparison',
		annotations: { readOnlyHint: true }
	},
	{ method: 'POST', path: '/api/directories/{id}/comparisons/generate', toolName: 'generate_comparison' },
	{
		method: 'POST',
		path: '/api/directories/{id}/comparisons/generate-manual',
		toolName: 'generate_manual_comparison'
	},
	{
		method: 'DELETE',
		path: '/api/directories/{id}/comparisons/{slug}',
		toolName: 'delete_comparison',
		annotations: { destructiveHint: true }
	}
];
