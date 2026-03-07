import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { McpConfigService } from '../src/config/mcp-config.service.js';

describe('McpConfigService', () => {
	const originalEnv = { ...process.env };

	beforeEach(() => {
		process.env = { ...originalEnv };
	});

	afterEach(() => {
		process.env = originalEnv;
	});

	it('throws when EVER_WORKS_API_KEY is missing', () => {
		delete process.env.EVER_WORKS_API_KEY;
		expect(() => new McpConfigService()).toThrow('EVER_WORKS_API_KEY');
	});

	it('returns defaults when only API key is set', () => {
		process.env.EVER_WORKS_API_KEY = 'ew_test_key';
		delete process.env.EVER_WORKS_API_URL;
		delete process.env.EVER_WORKS_MCP_PORT;
		const config = new McpConfigService();
		expect(config.apiUrl).toBe('http://localhost:3100/api');
		expect(config.httpPort).toBe(3200);
		expect(config.apiKey).toBe('ew_test_key');
	});

	it('appends /api to URL without trailing slash', () => {
		process.env.EVER_WORKS_API_KEY = 'ew_test_key';
		process.env.EVER_WORKS_API_URL = 'https://example.com';
		const config = new McpConfigService();
		expect(config.apiUrl).toBe('https://example.com/api');
	});

	it('appends api to URL with trailing slash', () => {
		process.env.EVER_WORKS_API_KEY = 'ew_test_key';
		process.env.EVER_WORKS_API_URL = 'https://example.com/';
		const config = new McpConfigService();
		expect(config.apiUrl).toBe('https://example.com/api');
	});

	it('leaves URL alone if already ends with /api', () => {
		process.env.EVER_WORKS_API_KEY = 'ew_test_key';
		process.env.EVER_WORKS_API_URL = 'https://example.com/api';
		const config = new McpConfigService();
		expect(config.apiUrl).toBe('https://example.com/api');
	});

	it('throws on invalid port', () => {
		process.env.EVER_WORKS_API_KEY = 'ew_test_key';
		process.env.EVER_WORKS_MCP_PORT = 'not-a-number';
		expect(() => new McpConfigService()).toThrow('EVER_WORKS_MCP_PORT');
	});

	it('throws on port out of range', () => {
		process.env.EVER_WORKS_API_KEY = 'ew_test_key';
		process.env.EVER_WORKS_MCP_PORT = '99999';
		expect(() => new McpConfigService()).toThrow('EVER_WORKS_MCP_PORT');
	});

	it('reads MCP_TRANSPORT env var', () => {
		process.env.EVER_WORKS_API_KEY = 'ew_test_key';
		process.env.MCP_TRANSPORT = 'streamable-http';
		const config = new McpConfigService();
		expect(config.transport).toBe('streamable-http');
	});

	it('defaults transport to stdio', () => {
		process.env.EVER_WORKS_API_KEY = 'ew_test_key';
		delete process.env.MCP_TRANSPORT;
		const config = new McpConfigService();
		expect(config.transport).toBe('stdio');
	});
});
