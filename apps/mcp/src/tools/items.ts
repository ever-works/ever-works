import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { EverWorksClient } from '../client.js';
import { toMcpError } from '../errors.js';

export function registerItemTools(server: McpServer, client: EverWorksClient): void {
	server.tool(
		'submit_item',
		"Add a single item to a directory. Provide the item name, description, source URL, and category. The item will be processed and added to the directory's data repository.",
		{
			directory_id: z.string().describe('Directory ID (UUID)'),
			name: z.string().describe('Item display name'),
			description: z.string().describe('Short description of the item'),
			source_url: z.string().url().describe('URL of the item (e.g. GitHub repo, website)'),
			category: z.string().describe('Category to place the item in (must exist in directory)'),
			tags: z.array(z.string()).optional().describe('Tags to apply to the item'),
			featured: z.boolean().optional().describe('Whether to feature this item prominently'),
			slug: z.string().optional().describe('Custom slug for the item (auto-generated if omitted)'),
			create_pull_request: z
				.boolean()
				.optional()
				.describe('Create a PR instead of committing directly (default: true)')
		},
		async ({ directory_id, ...data }) => {
			try {
				const result = await client.post(`/directories/${directory_id}/submit-item`, data);
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			} catch (error) {
				return toMcpError(error);
			}
		}
	);

	server.tool(
		'remove_item',
		'Remove an item from a directory by its slug. Optionally provide a reason and choose whether to create a pull request.',
		{
			directory_id: z.string().describe('Directory ID (UUID)'),
			item_slug: z.string().describe('Slug of the item to remove'),
			reason: z.string().optional().describe('Reason for removing the item'),
			create_pull_request: z.boolean().optional().describe('Create a PR instead of committing directly')
		},
		async ({ directory_id, ...data }) => {
			try {
				const result = await client.post(`/directories/${directory_id}/remove-item`, data);
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			} catch (error) {
				return toMcpError(error);
			}
		}
	);

	server.tool(
		'update_item',
		'Update metadata for an existing item in a directory. Can change featured status and display order.',
		{
			directory_id: z.string().describe('Directory ID (UUID)'),
			item_slug: z.string().describe('Slug of the item to update'),
			featured: z.boolean().optional().describe('Set featured status'),
			order: z.number().int().nonnegative().optional().describe('Display order (0-based)'),
			create_pull_request: z.boolean().optional().describe('Create a PR instead of committing directly')
		},
		async ({ directory_id, ...data }) => {
			try {
				const result = await client.post(`/directories/${directory_id}/update-item`, data);
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			} catch (error) {
				return toMcpError(error);
			}
		}
	);

	server.tool(
		'extract_item_details',
		'Extract item details (name, description, category, tags) from a URL using AI. Does NOT add the item to any directory — use submit_item for that. Useful for previewing what an item would look like before adding it.',
		{
			source_url: z.string().url().describe('URL to extract details from'),
			existing_categories: z.array(z.string()).optional().describe('Existing categories to try to match against')
		},
		async (data) => {
			try {
				const result = await client.post('/extract-item-details', data);
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			} catch (error) {
				return toMcpError(error);
			}
		}
	);
}
