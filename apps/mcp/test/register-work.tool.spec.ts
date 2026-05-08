import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RegisterWorkTool } from '../src/register-work.tool.js';

const VALID_INPUT = {
	repo: 'https://github.com/acme/widgets',
	githubToken: 'ghp_test_token_123',
	email: 'a@b.test',
	agentId: 'agent-7',
	webhookUrl: 'https://example.test/webhook',
	subdomain: 'widgets',
	idempotencyKey: 'idem-1'
};

type FetchMock = ReturnType<typeof vi.fn>;

function mockFetch(responses: Array<{ status: number; bodyText: string } | Error>): FetchMock {
	let i = 0;
	const fn = vi.fn(async () => {
		const r = responses[i++];
		if (r instanceof Error) throw r;
		return {
			status: r.status,
			text: async () => r.bodyText
		} as unknown as Response;
	});
	return fn;
}

describe('RegisterWorkTool', () => {
	let tool: RegisterWorkTool;
	const ORIGINAL_API_URL = process.env.EVER_WORKS_API_URL;

	beforeEach(() => {
		tool = new RegisterWorkTool();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		if (ORIGINAL_API_URL === undefined) delete process.env.EVER_WORKS_API_URL;
		else process.env.EVER_WORKS_API_URL = ORIGINAL_API_URL;
	});

	it('returns a single text-content envelope on 2xx with pretty-printed JSON', async () => {
		const fetchMock = mockFetch([{ status: 200, bodyText: JSON.stringify({ ok: true, workId: 'w1' }) }]);
		vi.stubGlobal('fetch', fetchMock);

		const result = await tool.register(VALID_INPUT);

		expect(result).toMatchObject({
			content: [{ type: 'text', text: expect.stringContaining('"workId": "w1"') }]
		});
		expect((result as { isError?: true }).isError).toBeUndefined();
	});

	it('uses the default api base when EVER_WORKS_API_URL is unset', async () => {
		delete process.env.EVER_WORKS_API_URL;
		const fetchMock = mockFetch([{ status: 200, bodyText: '{}' }]);
		vi.stubGlobal('fetch', fetchMock);

		await tool.register(VALID_INPUT);

		expect(fetchMock).toHaveBeenCalledWith('https://api.ever.works/api/register-work', expect.any(Object));
	});

	it('strips a trailing slash from EVER_WORKS_API_URL before composing the URL', async () => {
		process.env.EVER_WORKS_API_URL = 'https://api.example.test/';
		const fetchMock = mockFetch([{ status: 200, bodyText: '{}' }]);
		vi.stubGlobal('fetch', fetchMock);

		await tool.register(VALID_INPUT);

		expect(fetchMock).toHaveBeenCalledWith('https://api.example.test/api/register-work', expect.any(Object));
	});

	it('forwards githubToken via X-GitHub-Token header (never in body)', async () => {
		const fetchMock = mockFetch([{ status: 200, bodyText: '{}' }]);
		vi.stubGlobal('fetch', fetchMock);

		await tool.register(VALID_INPUT);

		const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		const headers = init.headers as Record<string, string>;
		expect(headers['X-GitHub-Token']).toBe('ghp_test_token_123');
		expect(init.body as string).not.toContain('ghp_test_token_123');
	});

	it('forwards Idempotency-Key header only when idempotencyKey is provided', async () => {
		const fetchMock = mockFetch([
			{ status: 200, bodyText: '{}' },
			{ status: 200, bodyText: '{}' }
		]);
		vi.stubGlobal('fetch', fetchMock);

		await tool.register({ ...VALID_INPUT, idempotencyKey: 'key-abc' });
		const headersWith = (fetchMock.mock.calls[0] as [string, RequestInit])[1].headers as Record<string, string>;
		expect(headersWith['Idempotency-Key']).toBe('key-abc');

		await tool.register({ ...VALID_INPUT, idempotencyKey: undefined });
		const headersWithout = (fetchMock.mock.calls[1] as [string, RequestInit])[1].headers as Record<string, string>;
		expect(headersWithout['Idempotency-Key']).toBeUndefined();
	});

	it('serialises the body with the expected fields (githubToken NOT included)', async () => {
		const fetchMock = mockFetch([{ status: 200, bodyText: '{}' }]);
		vi.stubGlobal('fetch', fetchMock);

		await tool.register(VALID_INPUT);

		const init = (fetchMock.mock.calls[0] as [string, RequestInit])[1];
		const parsed = JSON.parse(init.body as string);
		expect(parsed).toEqual({
			repo: VALID_INPUT.repo,
			email: VALID_INPUT.email,
			agentId: VALID_INPUT.agentId,
			webhookUrl: VALID_INPUT.webhookUrl,
			subdomain: VALID_INPUT.subdomain
		});
		expect(parsed).not.toHaveProperty('githubToken');
		expect(parsed).not.toHaveProperty('idempotencyKey');
	});

	it('uses POST + Content-Type / Accept headers', async () => {
		const fetchMock = mockFetch([{ status: 200, bodyText: '{}' }]);
		vi.stubGlobal('fetch', fetchMock);

		await tool.register(VALID_INPUT);

		const init = (fetchMock.mock.calls[0] as [string, RequestInit])[1];
		expect(init.method).toBe('POST');
		const headers = init.headers as Record<string, string>;
		expect(headers['Content-Type']).toBe('application/json');
		expect(headers['Accept']).toBe('application/json');
	});

	it('returns an envelope with parsed empty object when 2xx body is empty', async () => {
		const fetchMock = mockFetch([{ status: 202, bodyText: '' }]);
		vi.stubGlobal('fetch', fetchMock);

		const result = await tool.register(VALID_INPUT);

		expect(result).toEqual({ content: [{ type: 'text', text: '{}' }] });
	});

	it('falls back to { raw } when the 2xx body is not valid JSON', async () => {
		const fetchMock = mockFetch([{ status: 200, bodyText: 'not-json-at-all' }]);
		vi.stubGlobal('fetch', fetchMock);

		const result = await tool.register(VALID_INPUT);

		expect(result.content[0].text).toContain('"raw": "not-json-at-all"');
	});

	it('returns isError=true on non-2xx with the parsed body in the message', async () => {
		const fetchMock = mockFetch([{ status: 400, bodyText: JSON.stringify({ error: 'bad repo' }) }]);
		vi.stubGlobal('fetch', fetchMock);

		const result = await tool.register(VALID_INPUT);

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain('HTTP 400');
		expect(result.content[0].text).toContain('"error": "bad repo"');
	});

	it('isError envelope includes the raw body when it is not JSON', async () => {
		const fetchMock = mockFetch([{ status: 502, bodyText: 'Bad Gateway' }]);
		vi.stubGlobal('fetch', fetchMock);

		const result = await tool.register(VALID_INPUT);

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain('HTTP 502');
		expect(result.content[0].text).toContain('"raw": "Bad Gateway"');
	});

	it('returns isError=true with "API unreachable" text when fetch rejects (Error instance)', async () => {
		const fetchMock = mockFetch([new Error('ECONNREFUSED')]);
		vi.stubGlobal('fetch', fetchMock);

		const result = await tool.register(VALID_INPUT);

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toBe('Ever Works API unreachable: ECONNREFUSED');
	});

	it('coerces a non-Error rejection through String(err)', async () => {
		// eslint-disable-next-line prefer-promise-reject-errors
		const fetchMock = vi.fn(async () => {
			throw 'string-rejection';
		});
		vi.stubGlobal('fetch', fetchMock);

		const result = await tool.register(VALID_INPUT);

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toBe('Ever Works API unreachable: string-rejection');
	});

	it('does NOT echo the GitHub token in any error envelope', async () => {
		const fetchMock = mockFetch([{ status: 401, bodyText: JSON.stringify({ message: 'Unauthorized' }) }]);
		vi.stubGlobal('fetch', fetchMock);

		const result = await tool.register(VALID_INPUT);

		expect(result.content[0].text).not.toContain('ghp_test_token_123');
	});

	it('does NOT echo the GitHub token on fetch-rejection', async () => {
		const fetchMock = mockFetch([new Error('boom')]);
		vi.stubGlobal('fetch', fetchMock);

		const result = await tool.register(VALID_INPUT);

		expect(result.content[0].text).not.toContain('ghp_test_token_123');
	});

	it('omits optional fields from the body when caller omits them', async () => {
		const fetchMock = mockFetch([{ status: 200, bodyText: '{}' }]);
		vi.stubGlobal('fetch', fetchMock);

		await tool.register({
			repo: 'https://github.com/x/y',
			githubToken: 'ghp_min_token'
		});

		const init = (fetchMock.mock.calls[0] as [string, RequestInit])[1];
		const parsed = JSON.parse(init.body as string);
		expect(parsed).toEqual({
			repo: 'https://github.com/x/y',
			email: undefined,
			agentId: undefined,
			webhookUrl: undefined,
			subdomain: undefined
		});
	});
});
