import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { EverWorksClient } from '../client.js';
import { toMcpError } from '../errors.js';

export function registerDeployTools(server: McpServer, client: EverWorksClient): void {
	server.tool(
		'deploy_directory',
		'Deploy a directory\'s website to the configured deploy provider (e.g. Vercel). The directory must have a website repository and a deploy provider configured.',
		{
			directory_id: z.string().describe('Directory ID (UUID)'),
			team_scope: z.string().optional().describe('Deploy provider team/scope to deploy under'),
		},
		async ({ directory_id, team_scope }) => {
			try {
				const body: Record<string, unknown> = {};
				if (team_scope) body.teamScope = team_scope;
				const result = await client.post(`/deploy/directories/${directory_id}`, body);
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			} catch (error) {
				return toMcpError(error);
			}
		}
	);

	server.tool(
		'list_domains',
		'List all domains (including auto-assigned and custom) for a deployed directory.',
		{
			directory_id: z.string().describe('Directory ID (UUID)'),
		},
		async ({ directory_id }) => {
			try {
				const result = await client.get(`/deploy/directories/${directory_id}/domains`);
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			} catch (error) {
				return toMcpError(error);
			}
		}
	);

	server.tool(
		'list_deploy_providers',
		'List all available deployment providers and whether they are enabled. Providers include Vercel and others depending on installed plugins.',
		{},
		async () => {
			try {
				const result = await client.get('/deploy/providers');
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			} catch (error) {
				return toMcpError(error);
			}
		}
	);

	server.tool(
		'check_deploy_capability',
		'Check if a directory can be deployed. Returns whether the user has the required tokens and permissions.',
		{
			directory_id: z.string().describe('Directory ID (UUID)'),
		},
		async ({ directory_id }) => {
			try {
				const result = await client.post(`/deploy/directories/${directory_id}/check`);
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			} catch (error) {
				return toMcpError(error);
			}
		}
	);
}
