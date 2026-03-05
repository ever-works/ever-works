import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { EverWorksClient } from '../client.js';
import { toMcpError } from '../errors.js';

export function registerGenerationTools(server: McpServer, client: EverWorksClient): void {
	server.tool(
		'generate_items',
		'Start AI-powered item generation for a directory. Requires a name for the generation run and a prompt describing what items to find. Returns immediately — generation runs in the background.',
		{
			directory_id: z.string().describe('Directory ID (UUID)'),
			name: z.string().describe('Name/label for this generation run (max 200 chars)'),
			prompt: z
				.string()
				.describe(
					'Prompt describing what items to generate (e.g. "Find the top 20 open-source AI coding tools")'
				),
			generation_method: z
				.enum(['create-update', 'create-only', 'update-only'])
				.optional()
				.describe('Generation strategy: create-update (default), create-only, or update-only'),
			providers: z
				.object({
					ai: z.string().optional().describe('AI provider plugin ID'),
					search: z.string().optional().describe('Search provider plugin ID'),
					contentExtraction: z.string().optional().describe('Content extraction plugin ID'),
					screenshot: z.string().optional().describe('Screenshot provider plugin ID'),
				})
				.optional()
				.describe('Override default providers for this generation'),
		},
		async ({ directory_id, ...data }) => {
			try {
				const result = await client.post(`/directories/${directory_id}/generate`, data);
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			} catch (error) {
				return toMcpError(error);
			}
		}
	);

	server.tool(
		'update_items',
		'Update existing items in a directory using AI. Re-fetches item data and refreshes descriptions, categories, and metadata. Runs in background.',
		{
			directory_id: z.string().describe('Directory ID (UUID)'),
			generation_method: z
				.enum(['create-update', 'create-only', 'update-only'])
				.optional()
				.describe('Generation strategy (default: create-update)'),
			providers: z
				.object({
					ai: z.string().optional().describe('AI provider plugin ID'),
					search: z.string().optional().describe('Search provider plugin ID'),
					contentExtraction: z.string().optional().describe('Content extraction plugin ID'),
					screenshot: z.string().optional().describe('Screenshot provider plugin ID'),
				})
				.optional()
				.describe('Override default providers for this update'),
		},
		async ({ directory_id, ...data }) => {
			try {
				const result = await client.post(`/directories/${directory_id}/update`, data);
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			} catch (error) {
				return toMcpError(error);
			}
		}
	);

	server.tool(
		'generate_directory_details',
		'Use AI to generate a directory name, slug, description, and suggested categories from a prompt. Useful when creating a new directory — call this first to get AI suggestions, then create_directory with the results.',
		{
			directory_name: z.string().describe('Working name for the directory'),
			prompt: z.string().describe('Description of what the directory should contain'),
			ai_provider: z.string().optional().describe('AI provider plugin ID to use'),
		},
		async (data) => {
			try {
				const result = await client.post('/directories/generate-details', data);
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			} catch (error) {
				return toMcpError(error);
			}
		}
	);

	server.tool(
		'get_generator_form',
		'Get the dynamic form schema for the AI generator. Returns available fields, pipelines, provider options, and validation rules. Use this to understand what parameters generate_items accepts.',
		{
			directory_id: z.string().describe('Directory ID (UUID)'),
			pipeline_id: z.string().optional().describe('Pipeline plugin ID to get form schema for'),
		},
		async ({ directory_id, pipeline_id }) => {
			try {
				const params = new URLSearchParams();
				if (pipeline_id) params.append('pipelineId', pipeline_id);
				const query = params.toString();
				const result = await client.get(
					`/directories/${directory_id}/generator-form${query ? `?${query}` : ''}`
				);
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			} catch (error) {
				return toMcpError(error);
			}
		}
	);
}
