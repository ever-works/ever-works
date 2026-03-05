import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { EverWorksClient } from '../client.js';
import { toMcpError } from '../errors.js';

export function registerPluginTools(server: McpServer, client: EverWorksClient): void {
	server.tool(
		'list_plugins',
		'List all available plugins. Optionally filter by category (ai-provider, search, content-extraction, screenshot, git, infrastructure, pipeline, ai-tools).',
		{
			category: z
				.string()
				.optional()
				.describe(
					'Filter by category: ai-provider, search, content-extraction, screenshot, git, infrastructure, pipeline, ai-tools'
				)
		},
		async ({ category }) => {
			try {
				const params = new URLSearchParams();
				if (category) params.append('category', category);
				const query = params.toString();
				const result = await client.get(`/plugins${query ? `?${query}` : ''}`);
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			} catch (error) {
				return toMcpError(error);
			}
		}
	);

	server.tool(
		'get_plugin',
		'Get details for a specific plugin, including its settings schema, current configuration, and enabled status.',
		{
			plugin_id: z.string().describe('Plugin ID (e.g. "openai", "vercel", "github")')
		},
		async ({ plugin_id }) => {
			try {
				const result = await client.get(`/plugins/${plugin_id}`);
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			} catch (error) {
				return toMcpError(error);
			}
		}
	);

	server.tool(
		'enable_plugin',
		'Enable a plugin for your account. Optionally provide settings (like API keys) at the same time. Use get_plugin first to see the settings schema.',
		{
			plugin_id: z.string().describe('Plugin ID (e.g. "openai", "vercel", "github")'),
			settings: z.record(z.unknown()).optional().describe('Plugin settings (non-secret, e.g. model preferences)'),
			secret_settings: z
				.record(z.unknown())
				.optional()
				.describe('Secret settings (e.g. API keys — stored encrypted)')
		},
		async ({ plugin_id, settings, secret_settings }) => {
			try {
				const body: Record<string, unknown> = {};
				if (settings) body.settings = settings;
				if (secret_settings) body.secretSettings = secret_settings;
				const result = await client.post(`/plugins/${plugin_id}/enable`, body);
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			} catch (error) {
				return toMcpError(error);
			}
		}
	);

	server.tool(
		'disable_plugin',
		'Disable a plugin for your account. This does not delete saved settings — re-enabling will restore them.',
		{
			plugin_id: z.string().describe('Plugin ID (e.g. "openai", "vercel", "github")')
		},
		async ({ plugin_id }) => {
			try {
				const result = await client.post(`/plugins/${plugin_id}/disable`, {});
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			} catch (error) {
				return toMcpError(error);
			}
		}
	);

	server.tool(
		'update_plugin_settings',
		'Update settings for an already-enabled plugin. Use get_plugin to see the current settings and available options.',
		{
			plugin_id: z.string().describe('Plugin ID (e.g. "openai", "vercel", "github")'),
			settings: z.record(z.unknown()).optional().describe('Plugin settings to update (non-secret)'),
			secret_settings: z.record(z.unknown()).optional().describe('Secret settings to update (e.g. API keys)')
		},
		async ({ plugin_id, settings, secret_settings }) => {
			try {
				const body: Record<string, unknown> = {};
				if (settings) body.settings = settings;
				if (secret_settings) body.secretSettings = secret_settings;
				const result = await client.patch(`/plugins/${plugin_id}/settings`, body);
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			} catch (error) {
				return toMcpError(error);
			}
		}
	);
}
