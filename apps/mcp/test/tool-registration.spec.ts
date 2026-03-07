import { describe, it, expect, vi, beforeEach } from 'vitest';
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
			operationId: 'DirectoriesController_findAll',
			method: 'GET',
			path: '/api/directories',
			summary: 'List all directories',
			pathParams: [],
			queryParams: [{ name: 'limit', required: false, schema: { type: 'integer' }, description: 'Max results' }]
		},
		{
			operationId: 'DirectoriesController_findOne',
			method: 'GET',
			path: '/api/directories/{id}',
			summary: 'Get a directory by ID',
			pathParams: [{ name: 'id', required: true, schema: { type: 'string' } }],
			queryParams: []
		},
		{
			operationId: 'DirectoriesController_create',
			method: 'POST',
			path: '/api/directories',
			summary: 'Create a directory',
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
		expect(registeredNames).toContain('list_directories');
		expect(registeredNames).toContain('get_directory');
		expect(registeredNames).toContain('create_directory');
		expect(registeredNames).toContain('get_plugin');
	});

	it('skips whitelist entries not in the spec', () => {
		service.registerTools();
		// deploy endpoints are in whitelist but not in sampleOperations
		const registeredNames = registry.registerTool.mock.calls.map(
			(call: unknown[]) => (call[0] as { name: string }).name
		);
		expect(registeredNames).not.toContain('deploy_directory');
	});

	it('uses whitelist toolName when provided', () => {
		service.registerTools();
		const firstCall = registry.registerTool.mock.calls[0][0] as { name: string };
		expect(firstCall.name).toBe('list_directories');
	});

	it('uses spec summary as description', () => {
		service.registerTools();
		const listDirCall = registry.registerTool.mock.calls.find(
			(call: unknown[]) => (call[0] as { name: string }).name === 'list_directories'
		);
		expect(listDirCall).toBeDefined();
		expect((listDirCall![0] as { description: string }).description).toBe('List all directories');
	});

	it('passes annotations from whitelist', () => {
		service.registerTools();
		const listDirCall = registry.registerTool.mock.calls.find(
			(call: unknown[]) => (call[0] as { name: string }).name === 'list_directories'
		);
		expect(listDirCall).toBeDefined();
		expect((listDirCall![0] as { annotations: unknown }).annotations).toEqual({ readOnlyHint: true });
	});

	it('creates handler that calls API with correct path', async () => {
		const requestSpy = vi.spyOn(apiClient, 'request').mockResolvedValue({ id: '123' });
		service.registerTools();

		const getDirCall = registry.registerTool.mock.calls.find(
			(call: unknown[]) => (call[0] as { name: string }).name === 'get_directory'
		);
		const handler = (getDirCall![0] as { handler: Function }).handler;
		const result = await handler({ id: 'abc-123' });

		expect(requestSpy).toHaveBeenCalledWith('GET', '/directories/abc-123', undefined);
		expect(result.content[0].text).toContain('"id": "123"');
	});

	it('creates handler that separates query params from body', async () => {
		const requestSpy = vi.spyOn(apiClient, 'request').mockResolvedValue({ items: [] });
		service.registerTools();

		const listDirCall = registry.registerTool.mock.calls.find(
			(call: unknown[]) => (call[0] as { name: string }).name === 'list_directories'
		);
		const handler = (listDirCall![0] as { handler: Function }).handler;
		await handler({ limit: 10 });

		expect(requestSpy).toHaveBeenCalledWith('GET', '/directories?limit=10', undefined);
	});

	it('creates handler that sends body for POST', async () => {
		const requestSpy = vi.spyOn(apiClient, 'request').mockResolvedValue({ id: '1' });
		service.registerTools();

		const createDirCall = registry.registerTool.mock.calls.find(
			(call: unknown[]) => (call[0] as { name: string }).name === 'create_directory'
		);
		const handler = (createDirCall![0] as { handler: Function }).handler;
		await handler({ name: 'Test', slug: 'test' });

		expect(requestSpy).toHaveBeenCalledWith('POST', '/directories', { name: 'Test', slug: 'test' });
	});

	it('handler returns error on API failure', async () => {
		vi.spyOn(apiClient, 'request').mockRejectedValue(new Error('Connection refused'));
		service.registerTools();

		const getDirCall = registry.registerTool.mock.calls.find(
			(call: unknown[]) => (call[0] as { name: string }).name === 'get_directory'
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
