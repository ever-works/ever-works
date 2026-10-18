import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import { ToolRegistrationService } from '../src/openapi-tools/tool-registration.service.js';
import { OpenApiLoaderService, type OpenApiOperation } from '../src/openapi-tools/openapi-loader.service.js';
import { SchemaConverterService } from '../src/openapi-tools/schema-converter.service.js';
import { ApiClientService } from '../src/api-client/api-client.service.js';
import { McpConfigService } from '../src/config/mcp-config.service.js';
import { WHITELIST } from '../src/openapi-tools/whitelist.js';
import {
	MCP_PRIVILEGED_ARGS,
	MCP_PRIVILEGED_TOOLS,
	MCP_PRIVILEGED_TOOLS_ENV,
	mcpPrivilegedToolsEnabled
} from '../src/openapi-tools/privileged-tools.js';
import { KbCreateTool } from '../src/tools/kb/create.js';
import { KbUpdateTool } from '../src/tools/kb/update.js';
import { kbCreateAuthorship, kbUpdateAuthorship } from '../src/tools/kb/review-gate.js';

/**
 * Works-security (2026-10-18) — MCP privileged tools are OFF by default.
 *
 * The API cannot tell an MCP client holding the owner's key from the owner,
 * and the client is a model that may read hostile content. Deploy, plugin
 * secrets, run starters and destructive tools register only when the
 * operator sets MCP_PRIVILEGED_TOOLS=true — then exactly as before.
 */

const operations: OpenApiOperation[] = [
	{
		operationId: 'Deploy_deploy',
		method: 'POST',
		path: '/api/deploy/works/{id}',
		summary: 'Deploy a Work.',
		pathParams: [{ name: 'id', required: true, schema: { type: 'string' } }],
		queryParams: []
	},
	{
		operationId: 'Tasks_run',
		method: 'POST',
		path: '/api/tasks/{id}/run',
		summary: 'Run a Task.',
		pathParams: [{ name: 'id', required: true, schema: { type: 'string' } }],
		queryParams: []
	},
	{
		operationId: 'Tasks_delete',
		method: 'DELETE',
		path: '/api/tasks/{id}',
		summary: 'Delete a Task.',
		pathParams: [{ name: 'id', required: true, schema: { type: 'string' } }],
		queryParams: []
	},
	{
		operationId: 'Tasks_get',
		method: 'GET',
		path: '/api/tasks/{id}',
		summary: 'Get a Task.',
		pathParams: [{ name: 'id', required: true, schema: { type: 'string' } }],
		queryParams: []
	},
	{
		operationId: 'Tasks_create',
		method: 'POST',
		path: '/api/tasks',
		summary: 'Create a Task.',
		pathParams: [],
		queryParams: [],
		requestBody: {
			type: 'object',
			properties: {
				title: { type: 'string' },
				agentId: { type: 'string' },
				scheduledAt: { type: 'string' },
				acceptanceChecks: { type: 'array', items: { type: 'object' } }
			},
			required: ['title']
		}
	}
];

describe('MCP privileged tools switch', () => {
	const originalEnv = { ...process.env };
	let registry: { registerTool: ReturnType<typeof vi.fn> };
	let apiClient: ApiClientService;

	const build = () => {
		apiClient = new ApiClientService({
			apiUrl: 'http://localhost:3100/api',
			apiKey: 'ew_test_key'
		} as McpConfigService);
		registry = { registerTool: vi.fn() };
		const loader = { getOperations: vi.fn(() => operations) } as unknown as OpenApiLoaderService;
		const service = new ToolRegistrationService(loader, new SchemaConverterService(), apiClient, registry as never);
		service.registerTools();
	};
	const names = () => registry.registerTool.mock.calls.map((call: unknown[]) => (call[0] as { name: string }).name);
	const registered = (name: string) =>
		registry.registerTool.mock.calls.find((call: unknown[]) => (call[0] as { name: string }).name === name)?.[0] as
			| {
					parameters: z.ZodObject<Record<string, z.ZodTypeAny>>;
					handler: (a: Record<string, unknown>) => Promise<unknown>;
			  }
			| undefined;

	beforeEach(() => {
		process.env = { ...originalEnv };
		delete process.env[MCP_PRIVILEGED_TOOLS_ENV];
	});
	afterEach(() => {
		process.env = originalEnv;
		vi.restoreAllMocks();
	});

	it('names only tools that are on the whitelist (the list cannot rot)', () => {
		const whitelisted = new Set(WHITELIST.map((entry) => entry.toolName));
		expect(Object.keys(MCP_PRIVILEGED_TOOLS).filter((name) => !whitelisted.has(name))).toEqual([]);
		expect(Object.keys(MCP_PRIVILEGED_ARGS).filter((name) => !whitelisted.has(name))).toEqual([]);
	});

	it.each([
		'deploy_work',
		'enable_plugin',
		'update_plugin_settings',
		'generate_items',
		'update_schedule',
		'run_scheduled_update',
		'run_mission_now',
		'build_idea',
		'accept_idea',
		'run_tasks_batch',
		'run_task',
		'activate_goal',
		'update_goal_limits',
		'run_agent_now',
		'resume_agent',
		'delete_work',
		'delete_mission',
		'delete_task',
		'discard_task_branch',
		'delete_inbox_item'
	])('%s is privileged', (name) => {
		expect(MCP_PRIVILEGED_TOOLS[name]).toBeTruthy();
	});

	it('is off unless explicitly enabled', () => {
		expect(mcpPrivilegedToolsEnabled({})).toBe(false);
		expect(mcpPrivilegedToolsEnabled({ [MCP_PRIVILEGED_TOOLS_ENV]: 'false' })).toBe(false);
		expect(mcpPrivilegedToolsEnabled({ [MCP_PRIVILEGED_TOOLS_ENV]: 'yes please' })).toBe(false);
		expect(mcpPrivilegedToolsEnabled({ [MCP_PRIVILEGED_TOOLS_ENV]: 'TRUE' })).toBe(true);
		expect(mcpPrivilegedToolsEnabled({ [MCP_PRIVILEGED_TOOLS_ENV]: '1' })).toBe(true);
	});

	it('off: privileged tools are not registered; ordinary ones are', () => {
		build();
		expect(names()).toContain('get_task');
		expect(names()).toContain('create_task');
		expect(names()).not.toContain('deploy_work');
		expect(names()).not.toContain('run_task');
		expect(names()).not.toContain('delete_task');
	});

	it('off: create_task neither offers nor forwards agentId / scheduledAt', async () => {
		build();
		const tool = registered('create_task');
		expect(tool).toBeDefined();
		expect(Object.keys(tool!.parameters.shape)).toEqual(['title']);
		const spy = vi.spyOn(apiClient, 'request').mockResolvedValue({ id: 't1' });
		await tool!.handler({ title: 'x', agentId: 'a1', scheduledAt: '2030-01-01T00:00:00Z' });
		expect(spy).toHaveBeenCalledWith('POST', '/tasks', { title: 'x' });
	});

	it('on: every tool registers as before and create_task keeps agentId / scheduledAt', async () => {
		process.env[MCP_PRIVILEGED_TOOLS_ENV] = 'true';
		build();
		expect(names()).toEqual(expect.arrayContaining(['deploy_work', 'run_task', 'delete_task', 'create_task']));
		const tool = registered('create_task');
		// acceptanceChecks stays cut regardless — it is a whitelist omitArg, not part of this switch.
		expect(Object.keys(tool!.parameters.shape).sort()).toEqual(['agentId', 'scheduledAt', 'title']);
		const spy = vi.spyOn(apiClient, 'request').mockResolvedValue({ id: 't1' });
		await tool!.handler({ title: 'x', agentId: 'a1' });
		expect(spy).toHaveBeenCalledWith('POST', '/tasks', { title: 'x', agentId: 'a1' });
	});
});

describe('MCP kb.create / kb.update land as proposals', () => {
	const originalEnv = { ...process.env };
	beforeEach(() => {
		process.env = { ...originalEnv };
		delete process.env[MCP_PRIVILEGED_TOOLS_ENV];
	});
	afterEach(() => {
		process.env = originalEnv;
	});

	const WORK = '11111111-1111-4111-8111-111111111111';
	const DOC = '22222222-2222-4222-8222-222222222222';

	it('kb.create sends reviewState proposed + source agent', async () => {
		const request = vi.fn(async () => ({ id: DOC }));
		const tool = new KbCreateTool({ request } as unknown as ApiClientService);
		await tool.create({ workId: WORK, path: 'brand/voice', title: 'Voice', body: 'b', class: 'brand' as never });
		expect(request).toHaveBeenCalledWith(
			'POST',
			`/works/${WORK}/kb/documents`,
			expect.objectContaining({ title: 'Voice', reviewState: 'proposed', source: 'agent' })
		);
	});

	it('kb.update marks a content edit proposed, not a tag-only edit', async () => {
		const request = vi.fn(async () => ({ id: DOC }));
		const tool = new KbUpdateTool({ request } as unknown as ApiClientService);
		await tool.update({ workId: WORK, idOrPath: DOC, patch: { body: 'new' } });
		expect(request).toHaveBeenLastCalledWith('PATCH', `/works/${WORK}/kb/documents/${DOC}`, {
			body: 'new',
			reviewState: 'proposed'
		});
		await tool.update({ workId: WORK, idOrPath: DOC, patch: { tags: ['t'] } });
		expect(request).toHaveBeenLastCalledWith('PATCH', `/works/${WORK}/kb/documents/${DOC}`, { tags: ['t'] });
	});

	it('the operator switch stops the client-side marking', () => {
		expect(kbCreateAuthorship(true)).toEqual({});
		expect(kbUpdateAuthorship({ body: 'x' }, true)).toEqual({});
		expect(kbCreateAuthorship(false)).toEqual({ reviewState: 'proposed', source: 'agent' });
	});
});
