import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { EverWorksClient } from '../client.js';
import { toMcpError } from '../errors.js';

export function registerComparisonTools(server: McpServer, client: EverWorksClient): void {
	server.tool(
		'list_comparisons',
		'List all comparisons for a directory. Comparisons are AI-generated side-by-side analyses of two items.',
		{
			directory_id: z.string().describe('Directory ID (UUID)')
		},
		async ({ directory_id }) => {
			try {
				const result = await client.get(`/directories/${directory_id}/comparisons`);
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			} catch (error) {
				return toMcpError(error);
			}
		}
	);

	server.tool(
		'get_comparison',
		'Get a specific comparison by slug. Returns the full comparison content including pros, cons, and verdict.',
		{
			directory_id: z.string().describe('Directory ID (UUID)'),
			slug: z.string().describe('Comparison slug (e.g. "item-a-vs-item-b")')
		},
		async ({ directory_id, slug }) => {
			try {
				const result = await client.get(`/directories/${directory_id}/comparisons/${slug}`);
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			} catch (error) {
				return toMcpError(error);
			}
		}
	);

	server.tool(
		'generate_comparison',
		'Auto-generate comparisons for a directory. AI will select item pairs and create side-by-side analyses. Runs in background.',
		{
			directory_id: z.string().describe('Directory ID (UUID)')
		},
		async ({ directory_id }) => {
			try {
				const result = await client.post(`/directories/${directory_id}/comparisons/generate`);
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			} catch (error) {
				return toMcpError(error);
			}
		}
	);

	server.tool(
		'generate_manual_comparison',
		'Generate a comparison between two specific items. Provide the slugs of both items to compare.',
		{
			directory_id: z.string().describe('Directory ID (UUID)'),
			item_a_slug: z.string().describe('Slug of the first item to compare'),
			item_b_slug: z.string().describe('Slug of the second item to compare')
		},
		async ({ directory_id, item_a_slug, item_b_slug }) => {
			try {
				const result = await client.post(`/directories/${directory_id}/comparisons/generate-manual`, {
					itemASlug: item_a_slug,
					itemBSlug: item_b_slug
				});
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			} catch (error) {
				return toMcpError(error);
			}
		}
	);

	server.tool(
		'delete_comparison',
		'Delete a comparison from a directory by its slug.',
		{
			directory_id: z.string().describe('Directory ID (UUID)'),
			slug: z.string().describe('Comparison slug to delete')
		},
		async ({ directory_id, slug }) => {
			try {
				const result = await client.delete(`/directories/${directory_id}/comparisons/${slug}`);
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			} catch (error) {
				return toMcpError(error);
			}
		}
	);
}
