import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { EverWorksClient } from '../client.js';
import { toMcpError } from '../errors.js';

export function registerSchedulingTools(server: McpServer, client: EverWorksClient): void {
	server.tool(
		'get_schedule',
		'Get the current scheduled update configuration for a directory. Returns cadence, enabled status, and failure settings.',
		{
			directory_id: z.string().describe('Directory ID (UUID)')
		},
		async ({ directory_id }) => {
			try {
				const result = await client.get(`/directories/${directory_id}/schedule`);
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			} catch (error) {
				return toMcpError(error);
			}
		}
	);

	server.tool(
		'update_schedule',
		'Update the scheduled update configuration for a directory. Set cadence, enable/disable, and failure thresholds.',
		{
			directory_id: z.string().describe('Directory ID (UUID)'),
			enable: z.boolean().optional().describe('Enable or disable scheduled updates'),
			cadence: z
				.enum(['hourly', 'daily', 'weekly', 'monthly'])
				.optional()
				.describe('How often to run scheduled updates'),
			maxFailureBeforePause: z
				.number()
				.int()
				.min(1)
				.max(10)
				.optional()
				.describe('Number of consecutive failures before pausing (1-10)'),
			alwaysCreatePullRequest: z
				.boolean()
				.optional()
				.describe('Always create a PR for scheduled updates instead of committing directly')
		},
		async ({ directory_id, ...data }) => {
			try {
				const result = await client.put(`/directories/${directory_id}/schedule`, data);
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			} catch (error) {
				return toMcpError(error);
			}
		}
	);

	server.tool(
		'cancel_schedule',
		'Cancel and remove the scheduled update configuration for a directory.',
		{
			directory_id: z.string().describe('Directory ID (UUID)')
		},
		async ({ directory_id }) => {
			try {
				const result = await client.delete(`/directories/${directory_id}/schedule`);
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			} catch (error) {
				return toMcpError(error);
			}
		}
	);

	server.tool(
		'run_scheduled_update',
		'Manually trigger a scheduled update run for a directory. Runs immediately regardless of cadence settings.',
		{
			directory_id: z.string().describe('Directory ID (UUID)')
		},
		async ({ directory_id }) => {
			try {
				const result = await client.post(`/directories/${directory_id}/schedule/run`);
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			} catch (error) {
				return toMcpError(error);
			}
		}
	);
}
