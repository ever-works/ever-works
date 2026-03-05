import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EverWorksClient } from './client.js';
import { ApiError } from './errors.js';

describe('EverWorksClient', () => {
	let client: EverWorksClient;
	let fetchSpy: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		client = new EverWorksClient('http://localhost:3100/api', 'ew_test_key');
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
		await client.get('/directories');
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
		const result = await client.get('/directories/1');
		expect(result).toEqual({ id: '1', name: 'Test' });
	});

	it('throws ApiError on non-OK status', async () => {
		mockResponse({ message: 'Not Found' }, 404);
		await expect(client.get('/directories/missing')).rejects.toThrow(ApiError);
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
		const result = await client.get<Record<string, unknown>>('/directories/1');
		const user = result.user as Record<string, unknown>;
		expect(user.password).toBeUndefined();
		expect(user.lastLoginIp).toBeUndefined();
		expect(user.email).toBe('test@example.com');
	});

	it('includes AbortSignal.timeout in requests', async () => {
		mockResponse({ id: '1' });
		await client.get('/directories');
		const callArgs = fetchSpy.mock.calls[0];
		expect(callArgs[1].signal).toBeDefined();
	});

	it('sends body for POST requests', async () => {
		mockResponse({ id: '1' });
		await client.post('/directories', { name: 'New Dir' });
		const callArgs = fetchSpy.mock.calls[0];
		expect(callArgs[1].method).toBe('POST');
		expect(callArgs[1].body).toBe(JSON.stringify({ name: 'New Dir' }));
	});
});
