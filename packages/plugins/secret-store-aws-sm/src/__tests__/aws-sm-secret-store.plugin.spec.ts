import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AwsSmSecretStorePlugin } from '../aws-sm-secret-store.plugin.js';

describe('AwsSmSecretStorePlugin (EW-742 P3.2 T20.10a plugin package)', () => {
	let plugin: AwsSmSecretStorePlugin;
	let fetchSpy: ReturnType<typeof vi.spyOn>;
	let warnSpy: ReturnType<typeof vi.spyOn>;
	const orig = {
		ak: process.env.AWS_ACCESS_KEY_ID,
		sk: process.env.AWS_SECRET_ACCESS_KEY,
		st: process.env.AWS_SESSION_TOKEN
	};

	beforeEach(() => {
		plugin = new AwsSmSecretStorePlugin();
		fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
			throw new Error('fetch not mocked');
		});
		warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		process.env.AWS_ACCESS_KEY_ID = 'AKIAIOSFODNN7EXAMPLE';
		process.env.AWS_SECRET_ACCESS_KEY = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
		delete process.env.AWS_SESSION_TOKEN;
	});

	afterEach(() => {
		fetchSpy.mockRestore();
		warnSpy.mockRestore();
		process.env.AWS_ACCESS_KEY_ID = orig.ak;
		process.env.AWS_SECRET_ACCESS_KEY = orig.sk;
		if (orig.st === undefined) delete process.env.AWS_SESSION_TOKEN;
		else process.env.AWS_SESSION_TOKEN = orig.st;
	});

	function mockResponse(opts: { ok?: boolean; status?: number; body?: unknown }): Response {
		const status = opts.status ?? (opts.ok === false ? 500 : 200);
		return {
			ok: opts.ok ?? (status >= 200 && status < 300),
			status,
			json: () => Promise.resolve(opts.body)
		} as unknown as Response;
	}

	it('declares manifest fields', () => {
		expect(plugin.id).toBe('secret-store-aws-sm');
		expect(plugin.category).toBe('secret-store-resolver');
		expect(plugin.capabilities).toContain('secret-store-resolve');
	});

	it('returns null for non-aws-sm: scheme', async () => {
		expect(await plugin.resolveSecret('vault:secret/foo')).toBeNull();
	});

	it('returns null for malformed pointer', async () => {
		expect(await plugin.resolveSecret('aws-sm:us-east-1')).toBeNull();
	});

	it('returns null when AWS_ACCESS_KEY_ID missing', async () => {
		delete process.env.AWS_ACCESS_KEY_ID;
		expect(await plugin.resolveSecret('aws-sm:us-east-1/my-secret')).toBeNull();
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('returns null when AWS_SECRET_ACCESS_KEY missing', async () => {
		delete process.env.AWS_SECRET_ACCESS_KEY;
		expect(await plugin.resolveSecret('aws-sm:us-east-1/my-secret')).toBeNull();
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('returns null on fetch network error', async () => {
		fetchSpy.mockRejectedValue(new Error('ECONNRESET'));
		expect(await plugin.resolveSecret('aws-sm:us-east-1/x')).toBeNull();
	});

	it('returns null on HTTP 400', async () => {
		fetchSpy.mockResolvedValue(mockResponse({ ok: false, status: 400 }));
		expect(await plugin.resolveSecret('aws-sm:us-east-1/x')).toBeNull();
	});

	it('returns null when SecretString is missing', async () => {
		fetchSpy.mockResolvedValue(mockResponse({ ok: true, body: { Name: 'x' } }));
		expect(await plugin.resolveSecret('aws-sm:us-east-1/x')).toBeNull();
	});

	it('returns null when SecretString is not JSON', async () => {
		fetchSpy.mockResolvedValue(mockResponse({ ok: true, body: { SecretString: 'not json' } }));
		expect(await plugin.resolveSecret('aws-sm:us-east-1/x')).toBeNull();
	});

	it('returns parsed bag from SecretString JSON', async () => {
		const credentials = { accessToken: 'tr_dev_xxx', region: 'us-east-1' };
		fetchSpy.mockResolvedValue(mockResponse({ ok: true, body: { SecretString: JSON.stringify(credentials) } }));
		expect(await plugin.resolveSecret('aws-sm:us-east-1/prod/acme')).toEqual(credentials);
	});

	it('composes URL with region in host', async () => {
		fetchSpy.mockResolvedValue(mockResponse({ ok: true, body: { SecretString: '{"k":"v"}' } }));
		await plugin.resolveSecret('aws-sm:eu-west-2/my-secret');
		const [calledUrl] = fetchSpy.mock.calls[0] as [string];
		expect(calledUrl).toBe('https://secretsmanager.eu-west-2.amazonaws.com/');
	});

	it('sends X-Amz-Date, X-Amz-Target, and SigV4 Authorization headers', async () => {
		fetchSpy.mockResolvedValue(mockResponse({ ok: true, body: { SecretString: '{"k":"v"}' } }));
		await plugin.resolveSecret('aws-sm:us-east-1/x');
		const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
		const headers = init.headers as Record<string, string>;
		expect(headers['X-Amz-Target']).toBe('secretsmanager.GetSecretValue');
		expect(headers['X-Amz-Date']).toMatch(/^\d{8}T\d{6}Z$/);
		expect(headers['Authorization']).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\//);
		expect(headers['Authorization']).toContain('Signature=');
	});

	it('includes X-Amz-Security-Token when AWS_SESSION_TOKEN is set', async () => {
		process.env.AWS_SESSION_TOKEN = 'sts-token-xxx';
		fetchSpy.mockResolvedValue(mockResponse({ ok: true, body: { SecretString: '{"k":"v"}' } }));
		await plugin.resolveSecret('aws-sm:us-east-1/x');
		const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
		const headers = init.headers as Record<string, string>;
		expect(headers['X-Amz-Security-Token']).toBe('sts-token-xxx');
	});
});
