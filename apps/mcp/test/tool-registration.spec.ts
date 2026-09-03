import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import { ToolRegistrationService } from '../src/openapi-tools/tool-registration.service.js';
import { OpenApiLoaderService, type OpenApiOperation } from '../src/openapi-tools/openapi-loader.service.js';
import { SchemaConverterService } from '../src/openapi-tools/schema-converter.service.js';
import { ApiClientService } from '../src/api-client/api-client.service.js';
import { McpConfigService } from '../src/config/mcp-config.service.js';

describe('ToolRegistrationService', () => {
	let service: ToolRegistrationService;
	let registry: { registerTool: ReturnType<typeof vi.fn> };
	let apiClient: ApiClientService;
	let loader: OpenApiLoaderService;

	const sampleOperations: OpenApiOperation[] = [
		{
			operationId: 'WorksController_findAll',
			method: 'GET',
			path: '/api/works',
			summary: 'List all works',
			pathParams: [],
			queryParams: [{ name: 'limit', required: false, schema: { type: 'integer' }, description: 'Max results' }]
		},
		{
			operationId: 'WorksController_findOne',
			method: 'GET',
			path: '/api/works/{id}',
			summary: 'Get a work by ID',
			pathParams: [{ name: 'id', required: true, schema: { type: 'string' } }],
			queryParams: []
		},
		{
			operationId: 'WorksController_create',
			method: 'POST',
			path: '/api/works',
			summary: 'Create a work',
			pathParams: [],
			queryParams: [],
			requestBody: {
				type: 'object',
				properties: {
					name: { type: 'string' },
					slug: { type: 'string' }
				},
				required: ['name', 'slug']
			}
		},
		{
			operationId: 'PluginsController_findOne',
			method: 'GET',
			path: '/api/plugins/{pluginId}',
			summary: 'Get plugin details',
			pathParams: [{ name: 'pluginId', required: true, schema: { type: 'string' } }],
			queryParams: []
		},
		{
			operationId: 'TasksController_transition',
			method: 'POST',
			path: '/api/tasks/{id}/transition',
			summary: 'State-machine transition.',
			pathParams: [{ name: 'id', required: true, schema: { type: 'string' } }],
			queryParams: [],
			requestBody: {
				type: 'object',
				properties: {
					to: { type: 'string' },
					force: { type: 'boolean' }
				},
				required: ['to']
			}
		},
		{
			operationId: 'TasksController_update',
			method: 'PATCH',
			path: '/api/tasks/{id}',
			summary: 'Partial update.',
			pathParams: [{ name: 'id', required: true, schema: { type: 'string' } }],
			queryParams: [],
			requestBody: {
				type: 'object',
				properties: {
					title: { type: 'string' },
					requireAllApprovers: { type: 'boolean' }
				}
			}
		}
	];

	beforeEach(() => {
		const config = {
			apiUrl: 'http://localhost:3100/api',
			apiKey: 'ew_test_key'
		} as McpConfigService;

		apiClient = new ApiClientService(config);
		loader = { getOperations: vi.fn(() => sampleOperations) } as unknown as OpenApiLoaderService;
		registry = { registerTool: vi.fn() };
		const converter = new SchemaConverterService();

		service = new ToolRegistrationService(loader, converter, apiClient, registry as any);
	});

	it('registers tools matching whitelist entries', () => {
		service.registerTools();
		const registeredNames = registry.registerTool.mock.calls.map(
			(call: unknown[]) => (call[0] as { name: string }).name
		);
		expect(registeredNames).toContain('list_works');
		expect(registeredNames).toContain('get_work');
		expect(registeredNames).toContain('create_work');
		expect(registeredNames).toContain('get_plugin');
	});

	it('skips whitelist entries not in the spec', () => {
		service.registerTools();
		// deploy endpoints are in whitelist but not in sampleOperations
		const registeredNames = registry.registerTool.mock.calls.map(
			(call: unknown[]) => (call[0] as { name: string }).name
		);
		expect(registeredNames).not.toContain('deploy_work');
	});

	it('uses whitelist toolName when provided', () => {
		service.registerTools();
		const firstCall = registry.registerTool.mock.calls[0][0] as { name: string };
		expect(firstCall.name).toBe('list_works');
	});

	it('uses spec summary as description', () => {
		service.registerTools();
		const listDirCall = registry.registerTool.mock.calls.find(
			(call: unknown[]) => (call[0] as { name: string }).name === 'list_works'
		);
		expect(listDirCall).toBeDefined();
		expect((listDirCall![0] as { description: string }).description).toBe('List all works');
	});

	it('passes annotations from whitelist', () => {
		service.registerTools();
		const listDirCall = registry.registerTool.mock.calls.find(
			(call: unknown[]) => (call[0] as { name: string }).name === 'list_works'
		);
		expect(listDirCall).toBeDefined();
		expect((listDirCall![0] as { annotations: unknown }).annotations).toEqual({ readOnlyHint: true });
	});

	describe('omitArgs (human-gate overrides never reach the tool surface)', () => {
		function registered(name: string) {
			const call = registry.registerTool.mock.calls.find(
				(c: unknown[]) => (c[0] as { name: string }).name === name
			);
			expect(call, `${name} registered`).toBeDefined();
			return call![0] as { parameters: z.ZodObject<Record<string, z.ZodTypeAny>>; handler: Function };
		}

		it('cuts `force` out of the transition_task schema while keeping the ordinary move', () => {
			service.registerTools();
			const { parameters } = registered('transition_task');
			expect(Object.keys(parameters.shape).sort()).toEqual(['id', 'to']);
			// The transport validates with safeParse before calling the handler;
			// a Zod object strips keys it does not know, so `force` is gone here.
			const parsed = parameters.safeParse({ id: 'abc', to: 'done', force: true });
			expect(parsed.success).toBe(true);
			expect(parsed.data).toEqual({ id: 'abc', to: 'done' });
		});

		it('never forwards an omitted argument upstream, even when handed raw arguments', async () => {
			const requestSpy = vi.spyOn(apiClient, 'request').mockResolvedValue({ id: 'abc', status: 'done' });
			service.registerTools();
			const { handler } = registered('transition_task');
			await handler({ id: 'abc', to: 'done', force: true });
			expect(requestSpy).toHaveBeenCalledWith('POST', '/tasks/abc/transition', { to: 'done' });
		});

		// `requireAllApprovers` is the approver POLICY, not the override: with it
		// false the `→ done` approver check never runs, so flipping it through
		// update_task would clear the very gate `force` was cut out to protect.
		it('cuts `requireAllApprovers` out of the update_task schema while keeping the ordinary fields', () => {
			service.registerTools();
			const { parameters } = registered('update_task');
			expect(Object.keys(parameters.shape).sort()).toEqual(['id', 'title']);
			const parsed = parameters.safeParse({ id: 'abc', title: 'Ship it', requireAllApprovers: false });
			expect(parsed.success).toBe(true);
			expect(parsed.data).toEqual({ id: 'abc', title: 'Ship it' });
		});

		it('never forwards `requireAllApprovers` upstream from update_task', async () => {
			const requestSpy = vi.spyOn(apiClient, 'request').mockResolvedValue({ id: 'abc', title: 'Ship it' });
			service.registerTools();
			const { handler } = registered('update_task');
			await handler({ id: 'abc', title: 'Ship it', requireAllApprovers: false });
			expect(requestSpy).toHaveBeenCalledWith('PATCH', '/tasks/abc', { title: 'Ship it' });
		});

		it('ignores omitArgs names the operation does not define instead of throwing', () => {
			const schema = z.object({ to: z.string() });
			const result = (
				service as unknown as {
					withoutOmittedArgs: (
						p: z.ZodObject<Record<string, z.ZodTypeAny>>,
						e: { method: string; path: string; omitArgs?: string[] }
					) => z.ZodObject<Record<string, z.ZodTypeAny>>;
				}
			).withoutOmittedArgs(schema, { method: 'POST', path: '/api/x', omitArgs: ['nope'] });
			expect(Object.keys(result.shape)).toEqual(['to']);
		});
	});

	it('creates handler that calls API with correct path', async () => {
		const requestSpy = vi.spyOn(apiClient, 'request').mockResolvedValue({ id: '123' });
		service.registerTools();

		const getDirCall = registry.registerTool.mock.calls.find(
			(call: unknown[]) => (call[0] as { name: string }).name === 'get_work'
		);
		const handler = (getDirCall![0] as { handler: Function }).handler;
		const result = await handler({ id: 'abc-123' });

		expect(requestSpy).toHaveBeenCalledWith('GET', '/works/abc-123', undefined);
		expect(result.content[0].text).toContain('"id": "123"');
	});

	it('creates handler that separates query params from body', async () => {
		const requestSpy = vi.spyOn(apiClient, 'request').mockResolvedValue({ items: [] });
		service.registerTools();

		const listDirCall = registry.registerTool.mock.calls.find(
			(call: unknown[]) => (call[0] as { name: string }).name === 'list_works'
		);
		const handler = (listDirCall![0] as { handler: Function }).handler;
		await handler({ limit: 10 });

		expect(requestSpy).toHaveBeenCalledWith('GET', '/works?limit=10', undefined);
	});

	it('creates handler that sends body for POST', async () => {
		const requestSpy = vi.spyOn(apiClient, 'request').mockResolvedValue({ id: '1' });
		service.registerTools();

		const createDirCall = registry.registerTool.mock.calls.find(
			(call: unknown[]) => (call[0] as { name: string }).name === 'create_work'
		);
		const handler = (createDirCall![0] as { handler: Function }).handler;
		await handler({ name: 'Test', slug: 'test' });

		expect(requestSpy).toHaveBeenCalledWith('POST', '/works', { name: 'Test', slug: 'test' });
	});

	it('handler returns error on API failure', async () => {
		vi.spyOn(apiClient, 'request').mockRejectedValue(new Error('Connection refused'));
		service.registerTools();

		const getDirCall = registry.registerTool.mock.calls.find(
			(call: unknown[]) => (call[0] as { name: string }).name === 'get_work'
		);
		const handler = (getDirCall![0] as { handler: Function }).handler;
		const result = await handler({ id: '123' });

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain('Connection refused');
	});

	it('matches paths with different param names', () => {
		service.registerTools();
		const getPluginCall = registry.registerTool.mock.calls.find(
			(call: unknown[]) => (call[0] as { name: string }).name === 'get_plugin'
		);
		expect(getPluginCall).toBeDefined();
	});
});
