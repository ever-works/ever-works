import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ToolRegistrationService } from '../src/openapi-tools/tool-registration.service.js';
import { OpenApiLoaderService, type OpenApiOperation } from '../src/openapi-tools/openapi-loader.service.js';
import { SchemaConverterService } from '../src/openapi-tools/schema-converter.service.js';
import { ApiClientService } from '../src/api-client/api-client.service.js';
import { McpConfigService } from '../src/config/mcp-config.service.js';
import { WHITELIST } from '../src/openapi-tools/whitelist.js';

/**
 * Works-security (2026-10-18) — `create_task` / `update_task` keep `labels`
 * writable but never add or remove a RESERVED Task label (`awaiting-owner`,
 * `app-provision`, `release:*`, `provision-attempt-*`). An agent bound to this
 * server, steered by injected text, must not lift an owner hold or drop the
 * label that forces a human approval on a production revert.
 */
describe('MCP Task tools — reserved labels', () => {
	let registry: { registerTool: ReturnType<typeof vi.fn> };
	let apiClient: ApiClientService;

	const operations: OpenApiOperation[] = [
		{
			operationId: 'TasksController_create',
			method: 'POST',
			path: '/api/tasks',
			summary: 'Create a Task.',
			pathParams: [],
			queryParams: [],
			requestBody: {
				type: 'object',
				properties: { title: { type: 'string' }, labels: { type: 'array', items: { type: 'string' } } },
				required: ['title']
			}
		},
		{
			operationId: 'TasksController_update',
			method: 'PATCH',
			path: '/api/tasks/{id}',
			summary: 'Update Task fields.',
			pathParams: [{ name: 'id', required: true, schema: { type: 'string' } }],
			queryParams: [],
			requestBody: {
				type: 'object',
				properties: { title: { type: 'string' }, labels: { type: 'array', items: { type: 'string' } } }
			}
		}
	];

	function handlerFor(name: string): (args: Record<string, unknown>) => Promise<{ isError?: boolean; content: Array<{ text: string }> }> {
		const call = registry.registerTool.mock.calls.find((c: unknown[]) => (c[0] as { name: string }).name === name);
		return (call![0] as { handler: never }).handler;
	}

	beforeEach(() => {
		delete process.env.TASK_RESERVED_LABELS_ENFORCED;
		const config = { apiUrl: 'http://localhost:3100/api', apiKey: 'ew_test_key' } as McpConfigService;
		apiClient = new ApiClientService(config);
		const loader = { getOperations: vi.fn(() => operations) } as unknown as OpenApiLoaderService;
		registry = { registerTool: vi.fn() };
		new ToolRegistrationService(loader, new SchemaConverterService(), apiClient, registry as never).registerTools();
	});

	afterEach(() => {
		delete process.env.TASK_RESERVED_LABELS_ENFORCED;
		vi.restoreAllMocks();
	});

	it('marks both Task write tools', () => {
		expect(WHITELIST.find((e) => e.toolName === 'create_task')?.reservedTaskLabels).toBe('create');
		expect(WHITELIST.find((e) => e.toolName === 'update_task')?.reservedTaskLabels).toBe('update');
	});

	it('create_task refuses a reserved label and writes nothing', async () => {
		const spy = vi.spyOn(apiClient, 'request').mockResolvedValue({ id: 't1' });
		const result = await handlerFor('create_task')({ title: 'x', labels: ['bug', 'app-provision'] });
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain('"app-provision"');
		expect(spy).not.toHaveBeenCalled();
	});

	it('create_task passes ordinary labels through', async () => {
		const spy = vi.spyOn(apiClient, 'request').mockResolvedValue({ id: 't1' });
		await handlerFor('create_task')({ title: 'x', labels: ['bug'] });
		expect(spy).toHaveBeenCalledWith('POST', '/tasks', { title: 'x', labels: ['bug'] });
	});

	it('update_task refuses a label list that strips awaiting-owner', async () => {
		const spy = vi
			.spyOn(apiClient, 'request')
			.mockImplementation(async (method: string) =>
				method === 'GET' ? { id: 't1', labels: ['awaiting-owner', 'bug'] } : { id: 't1' }
			);
		const result = await handlerFor('update_task')({ id: 't1', labels: ['bug'] });
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain('remove "awaiting-owner"');
		expect(spy).toHaveBeenCalledTimes(1);
		expect(spy).toHaveBeenCalledWith('GET', '/tasks/t1');
	});

	it('update_task lets ordinary labels change while the reserved ones stay', async () => {
		const spy = vi
			.spyOn(apiClient, 'request')
			.mockImplementation(async (method: string) =>
				method === 'GET' ? { id: 't1', labels: ['release:revert', 'bug'] } : { id: 't1' }
			);
		await handlerFor('update_task')({ id: 't1', labels: ['p1', 'release:revert'] });
		expect(spy).toHaveBeenLastCalledWith('PATCH', '/tasks/t1', { labels: ['p1', 'release:revert'] });
	});

	it('update_task without labels does not read the Task', async () => {
		const spy = vi.spyOn(apiClient, 'request').mockResolvedValue({ id: 't1' });
		await handlerFor('update_task')({ id: 't1', title: 'Renamed' });
		expect(spy).toHaveBeenCalledTimes(1);
		expect(spy).toHaveBeenCalledWith('PATCH', '/tasks/t1', { title: 'Renamed' });
	});

	it('is switched off only by TASK_RESERVED_LABELS_ENFORCED=false', async () => {
		process.env.TASK_RESERVED_LABELS_ENFORCED = 'false';
		const spy = vi.spyOn(apiClient, 'request').mockResolvedValue({ id: 't1' });
		await handlerFor('create_task')({ title: 'x', labels: ['app-provision'] });
		expect(spy).toHaveBeenCalledWith('POST', '/tasks', { title: 'x', labels: ['app-provision'] });
	});
});
