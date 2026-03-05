import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { EverWorksClient } from '../client.js';
import { toMcpError } from '../errors.js';

export function registerDirectoryTools(server: McpServer, client: EverWorksClient): void {
	server.tool(
		'list_directories',
		'List all directories you have access to. Returns directory IDs, names, slugs, and metadata. Use limit/offset for pagination.',
		{
			limit: z.number().int().positive().optional().describe('Max results to return (default: 20)'),
			offset: z.number().int().nonnegative().optional().describe('Number of results to skip'),
			search: z.string().optional().describe('Filter directories by name or slug'),
		},
		async ({ limit, offset, search }) => {
			try {
				const params = new URLSearchParams();
				if (limit !== undefined) params.append('limit', String(limit));
				if (offset !== undefined) params.append('offset', String(offset));
				if (search) params.append('search', search);
				const query = params.toString();
				const result = await client.get(`/directories${query ? `?${query}` : ''}`);
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			} catch (error) {
				return toMcpError(error);
			}
		}
	);

	server.tool(
		'get_directory',
		'Get full details for a single directory by its ID. Returns name, slug, description, config, repository info, and deploy status.',
		{
			directory_id: z.string().describe('Directory ID (UUID)'),
		},
		async ({ directory_id }) => {
			try {
				const result = await client.get(`/directories/${directory_id}`);
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			} catch (error) {
				return toMcpError(error);
			}
		}
	);

	server.tool(
		'create_directory',
		'Create a new directory. Requires a unique slug (URL-safe identifier), display name, and description. Optionally configure git/deploy providers.',
		{
			slug: z.string().describe('Unique URL-safe identifier (e.g. "awesome-ai-tools")'),
			name: z.string().describe('Display name for the directory'),
			description: z.string().describe('Short description of what the directory lists'),
			owner: z.string().optional().describe('GitHub owner/org for repositories'),
			organization: z.boolean().describe('Whether to create under a GitHub organization'),
			gitProvider: z.string().optional().describe('Git provider plugin ID (e.g. "github")'),
			deployProvider: z.string().optional().describe('Deploy provider plugin ID (e.g. "vercel")'),
		},
		async (params) => {
			try {
				const result = await client.post('/directories', params);
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			} catch (error) {
				return toMcpError(error);
			}
		}
	);

	server.tool(
		'update_directory',
		'Update a directory\'s settings. Can change name, description, or deploy provider.',
		{
			directory_id: z.string().describe('Directory ID (UUID)'),
			name: z.string().optional().describe('New display name'),
			description: z.string().optional().describe('New description'),
			deployProvider: z.string().optional().describe('New deploy provider plugin ID'),
		},
		async ({ directory_id, ...data }) => {
			try {
				const result = await client.put(`/directories/${directory_id}`, data);
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			} catch (error) {
				return toMcpError(error);
			}
		}
	);

	server.tool(
		'delete_directory',
		'Permanently delete a directory and optionally its GitHub repositories. This action cannot be undone.',
		{
			directory_id: z.string().describe('Directory ID (UUID)'),
			reason: z.string().optional().describe('Reason for deletion'),
			force_delete: z.boolean().optional().describe('Skip confirmation checks'),
			delete_data_repository: z.boolean().optional().describe('Also delete the data repository on GitHub'),
			delete_markdown_repository: z
				.boolean()
				.optional()
				.describe('Also delete the markdown repository on GitHub'),
			delete_website_repository: z
				.boolean()
				.optional()
				.describe('Also delete the website repository on GitHub'),
		},
		async ({ directory_id, ...data }) => {
			try {
				const result = await client.post(`/directories/${directory_id}/delete`, data);
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			} catch (error) {
				return toMcpError(error);
			}
		}
	);

	server.tool(
		'get_directory_config',
		'Get the configuration and metadata for a directory, including initial prompt, last generation settings, and plugin config.',
		{
			directory_id: z.string().describe('Directory ID (UUID)'),
		},
		async ({ directory_id }) => {
			try {
				const result = await client.get(`/directories/${directory_id}/config`);
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			} catch (error) {
				return toMcpError(error);
			}
		}
	);

	server.tool(
		'get_directory_items',
		'Get all items (listings) in a directory. Returns item names, slugs, descriptions, categories, tags, and URLs.',
		{
			directory_id: z.string().describe('Directory ID (UUID)'),
		},
		async ({ directory_id }) => {
			try {
				const result = await client.get(`/directories/${directory_id}/items`);
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			} catch (error) {
				return toMcpError(error);
			}
		}
	);

	server.tool(
		'get_categories_tags',
		'Get all categories and tags defined for a directory. Useful before submitting items to see valid category/tag values.',
		{
			directory_id: z.string().describe('Directory ID (UUID)'),
		},
		async ({ directory_id }) => {
			try {
				const result = await client.get(`/directories/${directory_id}/categories-tags`);
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			} catch (error) {
				return toMcpError(error);
			}
		}
	);

	server.tool(
		'get_directory_history',
		'Get the generation and update history for a directory. Shows past operations, their status, and timestamps.',
		{
			directory_id: z.string().describe('Directory ID (UUID)'),
			limit: z.number().int().positive().optional().describe('Max results to return'),
			offset: z.number().int().nonnegative().optional().describe('Number of results to skip'),
		},
		async ({ directory_id, limit, offset }) => {
			try {
				const params = new URLSearchParams();
				if (limit !== undefined) params.append('limit', String(limit));
				if (offset !== undefined) params.append('offset', String(offset));
				const query = params.toString();
				const result = await client.get(`/directories/${directory_id}/history${query ? `?${query}` : ''}`);
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			} catch (error) {
				return toMcpError(error);
			}
		}
	);
}
