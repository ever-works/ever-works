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
	MCP_PRIVILEGED_ARG_VALUES,
	MCP_PRIVILEGED_TOOLS,
	MCP_PRIVILEGED_TOOLS_ENV,
	heldBackValueRefusal,
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
		expect(Object.keys(MCP_PRIVILEGED_ARG_VALUES).filter((name) => !whitelisted.has(name))).toEqual([]);
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
		'resume_mission',
		'clone_mission',
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

/**
 * Review fix (2026-10-21): the held-back run starters must not be one call away
 * through a registered tool. `transition_task` to a dispatching status starts
 * agent runs, an `@mention` in Task chat starts the mentioned Agent, and a
 * Mission `schedule` / `autoBuildWorks` sets up recurring paid runs.
 */
describe('MCP privileged argument values', () => {
	const originalEnv = { ...process.env };
	const TASK = '33333333-3333-4333-8333-333333333333';
	const valueOperations: OpenApiOperation[] = [
		{
			operationId: 'Tasks_transition',
			method: 'POST',
			path: '/api/tasks/{id}/transition',
			summary: 'Transition a Task.',
			pathParams: [{ name: 'id', required: true, schema: { type: 'string' } }],
			queryParams: [],
			requestBody: {
				type: 'object',
				properties: { to: { type: 'string' }, force: { type: 'boolean' } },
				required: ['to']
			}
		},
		{
			operationId: 'Tasks_postChat',
			method: 'POST',
			path: '/api/tasks/{id}/chat',
			summary: 'Post a chat message.',
			pathParams: [{ name: 'id', required: true, schema: { type: 'string' } }],
			queryParams: [],
			requestBody: { type: 'object', properties: { body: { type: 'string' } }, required: ['body'] }
		},
		{
			operationId: 'Missions_create',
			method: 'POST',
			path: '/api/me/missions',
			summary: 'Create a Mission.',
			pathParams: [],
			queryParams: [],
			requestBody: {
				type: 'object',
				properties: {
					description: { type: 'string' },
					type: { type: 'string' },
					schedule: { type: 'string' },
					autoBuildWorks: { type: 'boolean' },
					guardrailsOverride: { type: 'object' }
				},
				required: ['description']
			}
		},
		{
			operationId: 'Missions_clone',
			method: 'POST',
			path: '/api/me/missions/{id}/clone',
			summary: 'Clone a Mission.',
			pathParams: [{ name: 'id', required: true, schema: { type: 'string' } }],
			queryParams: []
		}
	];
	let registry: { registerTool: ReturnType<typeof vi.fn> };
	let apiClient: ApiClientService;

	const build = () => {
		apiClient = new ApiClientService({
			apiUrl: 'http://localhost:3100/api',
			apiKey: 'ew_test_key'
		} as McpConfigService);
		registry = { registerTool: vi.fn() };
		const loader = { getOperations: vi.fn(() => valueOperations) } as unknown as OpenApiLoaderService;
		const service = new ToolRegistrationService(loader, new SchemaConverterService(), apiClient, registry as never);
		service.registerTools();
	};
	const registered = (name: string) =>
		registry.registerTool.mock.calls.find((call: unknown[]) => (call[0] as { name: string }).name === name)?.[0] as
			| {
					description: string;
					parameters: z.ZodObject<Record<string, z.ZodTypeAny>>;
					handler: (
						a: Record<string, unknown>
					) => Promise<{ isError?: boolean; content: Array<{ text: string }> }>;
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

	it.each(['in_progress', 'in_review', 'done', 'IN_PROGRESS', ' done '])(
		'off: transition_task to %j is refused and nothing is sent',
		async (to) => {
			build();
			const tool = registered('transition_task');
			expect(tool).toBeDefined();
			const spy = vi.spyOn(apiClient, 'request').mockResolvedValue({ id: TASK });
			const result = await tool!.handler({ id: TASK, to });
			expect(result.isError).toBe(true);
			expect(result.content[0].text).toContain(MCP_PRIVILEGED_TOOLS_ENV);
			expect(spy).not.toHaveBeenCalled();
		}
	);

	it.each(['backlog', 'todo', 'blocked', 'cancelled'])('off: transition_task to %s still runs', async (to) => {
		build();
		const spy = vi.spyOn(apiClient, 'request').mockResolvedValue({ id: TASK });
		const result = await registered('transition_task')!.handler({ id: TASK, to });
		expect(result.isError).toBeUndefined();
		expect(spy).toHaveBeenCalledWith('POST', `/tasks/${TASK}/transition`, { to });
	});

	it('off: the transition_task description says which moves are held back', () => {
		build();
		expect(registered('transition_task')!.description).toContain('in_progress');
		expect(registered('transition_task')!.description).toContain(MCP_PRIVILEGED_TOOLS_ENV);
	});

	it.each(['ping @builder-bot please', 'mail ops@example.com', 'hey @Nova'])(
		'off: a Task chat post with a mention (%j) is refused',
		async (body) => {
			build();
			const spy = vi.spyOn(apiClient, 'request').mockResolvedValue({ id: 'm1' });
			const result = await registered('post_task_chat_message')!.handler({ id: TASK, body });
			expect(result.isError).toBe(true);
			expect(spy).not.toHaveBeenCalled();
		}
	);

	it('off: a plain Task chat post still runs', async () => {
		build();
		const spy = vi.spyOn(apiClient, 'request').mockResolvedValue({ id: 'm1' });
		await registered('post_task_chat_message')!.handler({ id: TASK, body: 'Looks good, thanks.' });
		expect(spy).toHaveBeenCalledWith('POST', `/tasks/${TASK}/chat`, { body: 'Looks good, thanks.' });
	});

	it('off: create_mission neither offers nor forwards schedule / autoBuildWorks / guardrailsOverride', async () => {
		build();
		const tool = registered('create_mission');
		expect(Object.keys(tool!.parameters.shape).sort()).toEqual(['description', 'type']);
		const spy = vi.spyOn(apiClient, 'request').mockResolvedValue({ id: 'ms1' });
		await tool!.handler({
			description: 'find niches',
			schedule: '0 9 * * *',
			autoBuildWorks: true,
			guardrailsOverride: { maxSpendCents: 999999 }
		});
		expect(spy).toHaveBeenCalledWith('POST', '/me/missions', { description: 'find niches' });
	});

	it('off: clone_mission is not registered', () => {
		build();
		expect(registered('clone_mission')).toBeUndefined();
	});

	it('on: every value and argument is available as before', async () => {
		process.env[MCP_PRIVILEGED_TOOLS_ENV] = 'true';
		build();
		const spy = vi.spyOn(apiClient, 'request').mockResolvedValue({ id: TASK });
		await registered('transition_task')!.handler({ id: TASK, to: 'in_progress' });
		expect(spy).toHaveBeenLastCalledWith('POST', `/tasks/${TASK}/transition`, { to: 'in_progress' });
		await registered('post_task_chat_message')!.handler({ id: TASK, body: '@builder-bot go' });
		expect(spy).toHaveBeenLastCalledWith('POST', `/tasks/${TASK}/chat`, { body: '@builder-bot go' });
		expect(Object.keys(registered('create_mission')!.parameters.shape)).toEqual(
			expect.arrayContaining(['schedule', 'autoBuildWorks', 'guardrailsOverride'])
		);
		expect(registered('clone_mission')).toBeDefined();
		expect(registered('transition_task')!.description).not.toContain(MCP_PRIVILEGED_TOOLS_ENV);
	});

	it('heldBackValueRefusal ignores arguments the client did not send', () => {
		expect(heldBackValueRefusal('transition_task', { id: TASK }, false)).toBeNull();
		expect(heldBackValueRefusal('transition_task', { to: 'in_progress' }, true)).toBeNull();
		expect(heldBackValueRefusal('get_task', { to: 'in_progress' }, false)).toBeNull();
	});
});
