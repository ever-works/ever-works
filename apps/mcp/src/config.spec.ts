import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('loadConfig', () => {
	const originalEnv = process.env;
	let exitSpy: ReturnType<typeof vi.spyOn>;
	let errorSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		process.env = { ...originalEnv };
		exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
		errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.resetModules();
	});

	afterEach(() => {
		process.env = originalEnv;
		exitSpy.mockRestore();
		errorSpy.mockRestore();
	});

	async function loadConfig() {
		const mod = await import('./config.js');
		return mod.loadConfig();
	}

	it('exits when EVER_WORKS_API_KEY is missing', async () => {
		delete process.env.EVER_WORKS_API_KEY;
		await loadConfig();
		expect(exitSpy).toHaveBeenCalledWith(1);
	});

	it('returns defaults when only API key is set', async () => {
		process.env.EVER_WORKS_API_KEY = 'ew_test_key';
		delete process.env.EVER_WORKS_API_URL;
		delete process.env.EVER_WORKS_MCP_PORT;
		const config = await loadConfig();
		expect(config.apiUrl).toBe('http://localhost:3100/api');
		expect(config.httpPort).toBe(3200);
		expect(config.apiKey).toBe('ew_test_key');
	});

	it('appends /api to URL without trailing slash', async () => {
		process.env.EVER_WORKS_API_KEY = 'ew_test_key';
		process.env.EVER_WORKS_API_URL = 'https://example.com';
		const config = await loadConfig();
		expect(config.apiUrl).toBe('https://example.com/api');
	});

	it('appends api to URL with trailing slash', async () => {
		process.env.EVER_WORKS_API_KEY = 'ew_test_key';
		process.env.EVER_WORKS_API_URL = 'https://example.com/';
		const config = await loadConfig();
		expect(config.apiUrl).toBe('https://example.com/api');
	});

	it('leaves URL alone if already ends with /api', async () => {
		process.env.EVER_WORKS_API_KEY = 'ew_test_key';
		process.env.EVER_WORKS_API_URL = 'https://example.com/api';
		const config = await loadConfig();
		expect(config.apiUrl).toBe('https://example.com/api');
	});

	it('rejects invalid port', async () => {
		process.env.EVER_WORKS_API_KEY = 'ew_test_key';
		process.env.EVER_WORKS_MCP_PORT = 'not-a-number';
		await loadConfig();
		expect(exitSpy).toHaveBeenCalledWith(1);
	});

	it('rejects port out of range', async () => {
		process.env.EVER_WORKS_API_KEY = 'ew_test_key';
		process.env.EVER_WORKS_MCP_PORT = '99999';
		await loadConfig();
		expect(exitSpy).toHaveBeenCalledWith(1);
	});
});
