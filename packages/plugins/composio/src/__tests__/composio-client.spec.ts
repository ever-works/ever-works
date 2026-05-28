import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ComposioClient } from '../utils/composio-client.js';
import type { ComposioToolRef } from '../types.js';

function jsonResponse(body: unknown, init?: ResponseInit): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { 'content-type': 'application/json' },
		...init
	});
}

function errorResponse(status: number, body: string | object = ''): Response {
	const text = typeof body === 'string' ? body : JSON.stringify(body);
	return new Response(text, {
		status,
		headers: { 'content-type': typeof body === 'string' ? 'text/plain' : 'application/json' }
	});
}

function createClient(fetchImpl: typeof fetch): ComposioClient {
	return new ComposioClient({
		apiKey: 'test-key',
		baseUrl: 'https://composio.test/api/v3',
		logger: { log: vi.fn(), warn: vi.fn() },
		fetchImpl
	});
}

function createRef(overrides: Partial<ComposioToolRef> = {}): ComposioToolRef {
	return {
		toolkit: 'GMAIL',
		toolSlug: 'GMAIL_SEND_EMAIL',
		userId: 'user-123',
		...overrides
	};
}

describe('ComposioClient', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe('constructor', () => {
		it('throws when API key is empty', () => {
			expect(
				() =>
					new ComposioClient({
						apiKey: '',
						logger: { log: vi.fn(), warn: vi.fn() }
					})
			).toThrow(/API key is required/i);
		});

		it('strips trailing slashes from the base URL', async () => {
			const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ items: [] }));
			const client = new ComposioClient({
				apiKey: 'k',
				baseUrl: 'https://composio.test/api/v3///',
				logger: { log: vi.fn(), warn: vi.fn() },
				fetchImpl
			});
			await client.listToolkits();
			const url = (fetchImpl.mock.calls[0][0] as string).split('?')[0];
			expect(url).toBe('https://composio.test/api/v3/toolkits');
		});
	});

	describe('listToolkits', () => {
		it('sends GET with x-api-key and accept headers', async () => {
			const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ items: [{ slug: 'GMAIL', name: 'Gmail' }] }));
			const client = createClient(fetchImpl);

			const result = await client.listToolkits(50);

			expect(result).toEqual([{ slug: 'GMAIL', name: 'Gmail' }]);
			const [url, init] = fetchImpl.mock.calls[0];
			expect((url as string).startsWith('https://composio.test/api/v3/toolkits')).toBe(true);
			expect(url as string).toContain('limit=50');
			const headers = new Headers((init as RequestInit).headers);
			expect(headers.get('x-api-key')).toBe('test-key');
			expect(headers.get('accept')).toBe('application/json');
		});

		it('clamps the limit into [1, 200]', async () => {
			// Response bodies are single-use streams — make a fresh one per call.
			const fetchImpl = vi.fn().mockImplementation(async () => jsonResponse({ items: [] }));
			const client = createClient(fetchImpl);

			await client.listToolkits(99999);
			expect(fetchImpl.mock.calls[0][0] as string).toContain('limit=200');

			await client.listToolkits(0);
			expect(fetchImpl.mock.calls[1][0] as string).toContain('limit=1');
		});

		it('extracts the array under .items', async () => {
			const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ items: [{ slug: 'A' }, { slug: 'B' }] }));
			const client = createClient(fetchImpl);
			expect(await client.listToolkits()).toHaveLength(2);
		});

		it('falls back to .data envelope', async () => {
			const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ data: [{ slug: 'A' }] }));
			const client = createClient(fetchImpl);
			expect(await client.listToolkits()).toHaveLength(1);
		});

		it('returns [] for an unrecognized envelope', async () => {
			const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ foo: 'bar' }));
			const client = createClient(fetchImpl);
			expect(await client.listToolkits()).toEqual([]);
		});

		it('translates 401 into an actionable error', async () => {
			const fetchImpl = vi.fn().mockResolvedValue(errorResponse(401, 'bad key'));
			const client = createClient(fetchImpl);

			await expect(client.listToolkits()).rejects.toThrow(/rejected the API key.*HTTP 401/i);
		});

		it('translates 429 into a rate-limit error', async () => {
			const fetchImpl = vi.fn().mockResolvedValue(errorResponse(429));
			const client = createClient(fetchImpl);

			await expect(client.listToolkits()).rejects.toThrow(/rate limit/i);
		});

		it('translates 5xx into a Composio status error', async () => {
			const fetchImpl = vi.fn().mockResolvedValue(errorResponse(503, 'maintenance'));
			const client = createClient(fetchImpl);

			await expect(client.listToolkits()).rejects.toThrow(/HTTP 503/);
		});
	});

	describe('listConnectedAccounts', () => {
		it('sends user_ids and toolkit_slugs (uppercased)', async () => {
			const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ items: [] }));
			const client = createClient(fetchImpl);

			await client.listConnectedAccounts('user-123', 'gmail');

			const url = fetchImpl.mock.calls[0][0] as string;
			expect(url).toContain('user_ids=user-123');
			expect(url).toContain('toolkit_slugs=GMAIL');
		});

		it('omits toolkit_slugs when toolkit is undefined', async () => {
			const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ items: [] }));
			const client = createClient(fetchImpl);

			await client.listConnectedAccounts('user-123');

			const url = fetchImpl.mock.calls[0][0] as string;
			expect(url).not.toContain('toolkit_slugs=');
		});
	});

	describe('validateConnection', () => {
		it('succeeds when an ACTIVE account exists', async () => {
			const fetchImpl = vi.fn().mockResolvedValue(
				jsonResponse({
					items: [
						{ id: 'ca_1', status: 'INITIATED', toolkit: { slug: 'GMAIL' } },
						{ id: 'ca_2', status: 'ACTIVE', toolkit: { slug: 'GMAIL' } }
					]
				})
			);
			const client = createClient(fetchImpl);

			const account = await client.validateConnection(createRef());
			expect(account.id).toBe('ca_2');
		});

		it('normalizes status to upper-case before matching', async () => {
			const fetchImpl = vi
				.fn()
				.mockResolvedValue(
					jsonResponse({ items: [{ id: 'ca_x', status: 'active', toolkit: { slug: 'GMAIL' } }] })
				);
			const client = createClient(fetchImpl);

			const account = await client.validateConnection(createRef());
			expect(account.id).toBe('ca_x');
		});

		it('throws a friendly error when no ACTIVE account exists', async () => {
			const fetchImpl = vi
				.fn()
				.mockResolvedValue(
					jsonResponse({ items: [{ id: 'ca_1', status: 'EXPIRED', toolkit: { slug: 'GMAIL' } }] })
				);
			const client = createClient(fetchImpl);

			await expect(client.validateConnection(createRef())).rejects.toThrow(
				/No active Composio connected account/i
			);
		});
	});

	describe('executeTool', () => {
		it('POSTs to /tools/execute/{slug} with { user_id, arguments }', async () => {
			const fetchImpl = vi
				.fn()
				.mockResolvedValue(jsonResponse({ successful: true, data: { items: [{ name: 'A' }] } }));
			const client = createClient(fetchImpl);

			const result = await client.executeTool(createRef(), { to: 'a@b.c', subject: 'hi' });

			expect((result.data as { items: unknown[] }).items).toHaveLength(1);
			expect(result.composioDuration).toBeGreaterThanOrEqual(0);

			const [url, init] = fetchImpl.mock.calls[0];
			expect(url).toBe('https://composio.test/api/v3/tools/execute/GMAIL_SEND_EMAIL');
			expect((init as RequestInit).method).toBe('POST');
			const body = JSON.parse((init as { body: string }).body);
			expect(body.user_id).toBe('user-123');
			expect(body.arguments).toEqual({ to: 'a@b.c', subject: 'hi' });
		});

		it('URL-encodes the tool slug', async () => {
			const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ successful: true, data: {} }));
			const client = createClient(fetchImpl);

			await client.executeTool(createRef({ toolSlug: 'TOOL/WITH SPACE' }), {});

			const url = fetchImpl.mock.calls[0][0] as string;
			expect(url).toBe('https://composio.test/api/v3/tools/execute/TOOL%2FWITH%20SPACE');
		});

		it('converts timeoutMs to seconds in the request body', async () => {
			const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ successful: true, data: {} }));
			const client = createClient(fetchImpl);

			await client.executeTool(createRef(), {}, { timeoutMs: 90_000 });

			const body = JSON.parse((fetchImpl.mock.calls[0][1] as { body: string }).body);
			expect(body.timeout).toBe(90);
		});

		it('throws when successful=false even on HTTP 200', async () => {
			const fetchImpl = vi
				.fn()
				.mockResolvedValue(
					jsonResponse({ successful: false, error: 'gmail quota exceeded', log_id: 'log_42' })
				);
			const client = createClient(fetchImpl);

			await expect(client.executeTool(createRef(), {})).rejects.toThrow(/gmail quota exceeded.*log_42/i);
		});

		it('rejects pre-aborted signals before issuing a request', async () => {
			const fetchImpl = vi.fn();
			const client = createClient(fetchImpl);
			const controller = new AbortController();
			controller.abort();

			await expect(client.executeTool(createRef(), {}, { signal: controller.signal })).rejects.toThrow(
				/cancelled/i
			);
			expect(fetchImpl).not.toHaveBeenCalled();
		});

		it('translates 404 into a tool-or-account-not-found message', async () => {
			const fetchImpl = vi.fn().mockResolvedValue(errorResponse(404, 'not found'));
			const client = createClient(fetchImpl);

			await expect(client.executeTool(createRef(), {})).rejects.toThrow(
				/404.*tool slug or toolkit does not exist/i
			);
		});
	});
});
