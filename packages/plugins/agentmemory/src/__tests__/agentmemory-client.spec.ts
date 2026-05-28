import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentmemoryClient } from '../agentmemory-client.js';

describe('AgentmemoryClient', () => {
	let fetchImpl: ReturnType<typeof vi.fn>;
	let client: AgentmemoryClient;

	beforeEach(() => {
		fetchImpl = vi.fn();
		client = new AgentmemoryClient({
			baseUrl: 'http://localhost:3111/',
			apiKey: 'secret-token',
			timeoutMs: 5000,
			fetchImpl: fetchImpl as unknown as typeof fetch
		});
	});

	function ok(body: unknown): Response {
		return {
			ok: true,
			status: 200,
			statusText: 'OK',
			text: vi.fn().mockResolvedValue(typeof body === 'string' ? body : JSON.stringify(body))
		} as unknown as Response;
	}

	function err(status: number, statusText: string, body = ''): Response {
		return {
			ok: false,
			status,
			statusText,
			text: vi.fn().mockResolvedValue(body)
		} as unknown as Response;
	}

	describe('baseUrl normalisation', () => {
		it('strips trailing slash so the same path is not double-slashed', async () => {
			fetchImpl.mockResolvedValueOnce(ok({ ok: true }));
			await client.health();
			expect(fetchImpl).toHaveBeenCalledWith(
				'http://localhost:3111/agentmemory/health',
				expect.objectContaining({ method: 'GET' })
			);
		});
	});

	describe('auth header', () => {
		it('sends Authorization: Bearer when an apiKey is configured', async () => {
			fetchImpl.mockResolvedValueOnce(ok({ ok: true }));
			await client.health();
			const init = fetchImpl.mock.calls[0][1] as RequestInit;
			expect((init.headers as Record<string, string>).Authorization).toBe('Bearer secret-token');
		});

		it('omits Authorization when no apiKey is configured (localhost dev)', async () => {
			const noAuth = new AgentmemoryClient({
				baseUrl: 'http://localhost:3111',
				fetchImpl: fetchImpl as unknown as typeof fetch
			});
			fetchImpl.mockResolvedValueOnce(ok({ ok: true }));
			await noAuth.health();
			const init = fetchImpl.mock.calls[0][1] as RequestInit;
			expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
		});
	});

	describe('health', () => {
		it.each([{ ok: true }, { status: 'ok' }, { status: 'OK' }])('recognises %j as healthy', async (body) => {
			fetchImpl.mockResolvedValueOnce(ok(body));
			const result = await client.health();
			expect(result.ok).toBe(true);
		});

		it('returns ok=false when the body does not look like a health response', async () => {
			fetchImpl.mockResolvedValueOnce(ok({ random: 'data' }));
			const result = await client.health();
			expect(result.ok).toBe(false);
		});
	});

	describe('error translation', () => {
		it('explains 401/403 as a token mismatch', async () => {
			fetchImpl.mockResolvedValueOnce(err(401, 'Unauthorized'));
			await expect(client.smartSearch({ query: 'x' })).rejects.toThrow(/AGENTMEMORY_SECRET/);
		});

		it('explains 404 as a wrong endpoint / wrong baseUrl', async () => {
			fetchImpl.mockResolvedValueOnce(err(404, 'Not Found'));
			await expect(client.smartSearch({ query: 'x' })).rejects.toThrow(/baseUrl/);
		});

		it('explains 429 as rate-limit', async () => {
			fetchImpl.mockResolvedValueOnce(err(429, 'Too Many Requests'));
			await expect(client.smartSearch({ query: 'x' })).rejects.toThrow(/rate-limited/);
		});
	});

	describe('JSON encoding', () => {
		it('sends Content-Type application/json + a JSON body on POSTs', async () => {
			fetchImpl.mockResolvedValueOnce(ok({}));
			await client.observe({ content: 'hello' });
			const init = fetchImpl.mock.calls[0][1] as RequestInit;
			expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
			expect(init.body).toBe(JSON.stringify({ content: 'hello' }));
		});
	});

	describe('listSessions query params', () => {
		it('passes limit + projectId as URL query params', async () => {
			fetchImpl.mockResolvedValueOnce(ok({ sessions: [] }));
			await client.listSessions({ limit: 5, projectId: 'proj-x' });
			expect(fetchImpl).toHaveBeenCalledWith(
				'http://localhost:3111/agentmemory/sessions?limit=5&projectId=proj-x',
				expect.any(Object)
			);
		});
	});
});
