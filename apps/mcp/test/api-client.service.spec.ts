import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ApiClientService } from '../src/api-client/api-client.service.js';
import { ApiError } from '../src/api-client/api-error.js';
import { McpConfigService } from '../src/config/mcp-config.service.js';

describe('ApiClientService', () => {
	let service: ApiClientService;
	let fetchSpy: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		const config = {
			apiUrl: 'http://localhost:3100/api',
			apiKey: 'ew_test_key',
			httpPort: 3200,
			transport: 'stdio'
		} as McpConfigService;

		service = new ApiClientService(config);
		fetchSpy = vi.fn();
		globalThis.fetch = fetchSpy;
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	function mockResponse(data: unknown, status = 200) {
		fetchSpy.mockResolvedValueOnce({
			ok: status >= 200 && status < 300,
			status,
			statusText: status === 200 ? 'OK' : 'Error',
			headers: new Headers({ 'content-type': 'application/json' }),
			json: () => Promise.resolve(data)
		});
	}

	it('sends correct headers', async () => {
		mockResponse({ id: '1' });
		await service.request('GET', '/directories');
		expect(fetchSpy).toHaveBeenCalledWith(
			'http://localhost:3100/api/directories',
			expect.objectContaining({
				headers: {
					'Content-Type': 'application/json',
					'x-api-key': 'ew_test_key'
				}
			})
		);
	});

	it('parses JSON responses', async () => {
		mockResponse({ id: '1', name: 'Test' });
		const result = await service.request('GET', '/directories/1');
		expect(result).toEqual({ id: '1', name: 'Test' });
	});

	it('throws ApiError on non-OK status', async () => {
		mockResponse({ message: 'Not Found' }, 404);
		await expect(service.request('GET', '/directories/missing')).rejects.toThrow(ApiError);
	});

	it('strips sensitive fields from responses', async () => {
		mockResponse({
			id: '1',
			name: 'Test',
			user: {
				id: 'u1',
				email: 'test@example.com',
				password: '$2b$10$hash',
				lastLoginIp: '127.0.0.1'
			}
		});
		const result = await service.request<Record<string, unknown>>('GET', '/directories/1');
		const user = result.user as Record<string, unknown>;
		expect(user.password).toBeUndefined();
		expect(user.lastLoginIp).toBeUndefined();
		expect(user.email).toBe('test@example.com');
	});

	it('includes AbortSignal.timeout in requests', async () => {
		mockResponse({ id: '1' });
		await service.request('GET', '/directories');
		const callArgs = fetchSpy.mock.calls[0];
		expect(callArgs[1].signal).toBeDefined();
	});

	it('sends body for POST requests', async () => {
		mockResponse({ id: '1' });
		await service.request('POST', '/directories', { name: 'New Dir' });
		const callArgs = fetchSpy.mock.calls[0];
		expect(callArgs[1].method).toBe('POST');
		expect(callArgs[1].body).toBe(JSON.stringify({ name: 'New Dir' }));
	});
});
