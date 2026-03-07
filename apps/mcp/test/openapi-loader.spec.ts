import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpenApiLoaderService } from '../src/openapi-tools/openapi-loader.service.js';
import { McpConfigService } from '../src/config/mcp-config.service.js';

// Mock swagger-parser
vi.mock('@apidevtools/swagger-parser', () => ({
	default: {
		dereference: vi.fn((spec: unknown) => Promise.resolve(spec))
	}
}));

describe('OpenApiLoaderService', () => {
	let service: OpenApiLoaderService;
	let fetchSpy: ReturnType<typeof vi.fn>;

	const minimalSpec = {
		openapi: '3.0.0',
		info: { title: 'Test', version: '1.0' },
		paths: {
			'/api/directories': {
				get: {
					operationId: 'DirectoriesController_findAll',
					summary: 'List directories',
					parameters: [
						{
							name: 'limit',
							in: 'query',
							required: false,
							schema: { type: 'integer' },
							description: 'Max results'
						}
					]
				},
				post: {
					operationId: 'DirectoriesController_create',
					summary: 'Create directory',
					requestBody: {
						content: {
							'application/json': {
								schema: {
									type: 'object',
									properties: {
										name: { type: 'string' },
										slug: { type: 'string' }
									},
									required: ['name', 'slug']
								}
							}
						}
					}
				}
			},
			'/api/directories/{id}': {
				parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
				get: {
					operationId: 'DirectoriesController_findOne',
					summary: 'Get directory'
				}
			}
		}
	};

	beforeEach(() => {
		const config = {
			apiUrl: 'http://localhost:3100/api',
			apiKey: 'ew_test_key',
			httpPort: 3200,
			transport: 'stdio'
		} as McpConfigService;

		service = new OpenApiLoaderService(config);
		fetchSpy = vi.fn();
		globalThis.fetch = fetchSpy;
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	function mockFetchSpec(spec: unknown = minimalSpec, status = 200) {
		fetchSpy.mockResolvedValueOnce({
			ok: status >= 200 && status < 300,
			status,
			json: () => Promise.resolve(spec)
		});
	}

	it('fetches and parses OpenAPI spec', async () => {
		mockFetchSpec();
		await service.onModuleInit();
		const ops = service.getOperations();
		expect(ops.length).toBe(3);
	});

	it('extracts correct operation details', async () => {
		mockFetchSpec();
		await service.onModuleInit();
		const ops = service.getOperations();

		const getAll = ops.find((op) => op.method === 'GET' && op.path === '/api/directories');
		expect(getAll).toBeDefined();
		expect(getAll!.summary).toBe('List directories');
		expect(getAll!.queryParams).toHaveLength(1);
		expect(getAll!.queryParams[0].name).toBe('limit');
	});

	it('extracts path parameters from pathItem level', async () => {
		mockFetchSpec();
		await service.onModuleInit();
		const ops = service.getOperations();

		const getOne = ops.find((op) => op.method === 'GET' && op.path === '/api/directories/{id}');
		expect(getOne).toBeDefined();
		expect(getOne!.pathParams).toHaveLength(1);
		expect(getOne!.pathParams[0].name).toBe('id');
		expect(getOne!.pathParams[0].required).toBe(true);
	});

	it('extracts request body schema', async () => {
		mockFetchSpec();
		await service.onModuleInit();
		const ops = service.getOperations();

		const create = ops.find((op) => op.method === 'POST' && op.path === '/api/directories');
		expect(create).toBeDefined();
		expect(create!.requestBody).toBeDefined();
		expect(create!.requestBody!.properties).toHaveProperty('name');
		expect(create!.requestBody!.properties).toHaveProperty('slug');
	});

	it('retries on first failure', async () => {
		fetchSpy.mockRejectedValueOnce(new Error('Network error'));
		mockFetchSpec();
		await service.onModuleInit();
		expect(fetchSpy).toHaveBeenCalledTimes(2);
		expect(service.getOperations().length).toBe(3);
	});

	it('throws if both attempts fail', async () => {
		fetchSpy.mockRejectedValueOnce(new Error('Network error'));
		fetchSpy.mockRejectedValueOnce(new Error('Still failing'));
		await expect(service.onModuleInit()).rejects.toThrow('Still failing');
	});

	it('handles spec with no paths', async () => {
		mockFetchSpec({ openapi: '3.0.0', info: { title: 'Empty', version: '1.0' }, paths: {} });
		await service.onModuleInit();
		expect(service.getOperations()).toHaveLength(0);
	});
});
