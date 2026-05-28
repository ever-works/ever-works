import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentmemoryPlugin } from '../agentmemory.plugin.js';
import type { PluginContext } from '@ever-works/plugin';

const mockHealth = vi.fn();
const mockSessionStart = vi.fn();
const mockSessionEnd = vi.fn();
const mockObserve = vi.fn();
const mockRemember = vi.fn();
const mockSmartSearch = vi.fn();
const mockContext = vi.fn();
const mockForget = vi.fn();
const mockListSessions = vi.fn();

vi.mock('../agentmemory-client.js', () => ({
	AgentmemoryClient: vi.fn().mockImplementation(() => ({
		health: mockHealth,
		sessionStart: mockSessionStart,
		sessionEnd: mockSessionEnd,
		observe: mockObserve,
		remember: mockRemember,
		smartSearch: mockSmartSearch,
		context: mockContext,
		forget: mockForget,
		listSessions: mockListSessions
	}))
}));

function createContext(): PluginContext {
	return {
		pluginId: 'agentmemory',
		logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
		cache: { get: vi.fn(), set: vi.fn(), delete: vi.fn(), clear: vi.fn() },
		http: {
			get: vi.fn(),
			post: vi.fn(),
			put: vi.fn(),
			delete: vi.fn(),
			patch: vi.fn(),
			request: vi.fn()
		},
		env: {
			get: vi.fn(),
			isDevelopment: vi.fn().mockReturnValue(true),
			isProduction: vi.fn().mockReturnValue(false),
			getAll: vi.fn().mockReturnValue({})
		},
		envVars: {},
		services: {} as never,
		getSettings: vi.fn().mockResolvedValue({}),
		getResolvedSettings: vi.fn().mockResolvedValue({ settings: {}, source: 'default' }),
		onEvent: vi.fn().mockReturnValue({ unsubscribe: vi.fn() }),
		emitEvent: vi.fn(),
		registerCustomCapability: vi.fn(),
		getCustomCapability: vi.fn()
	} as unknown as PluginContext;
}

describe('AgentmemoryPlugin', () => {
	let plugin: AgentmemoryPlugin;

	beforeEach(() => {
		vi.clearAllMocks();
		plugin = new AgentmemoryPlugin();
	});

	describe('metadata', () => {
		it('declares the agent-memory capability', () => {
			expect(plugin.id).toBe('agentmemory');
			expect(plugin.category).toBe('utility');
			expect(plugin.capabilities).toContain('agent-memory');
		});

		it('reports its provider name so the facade can identify it', () => {
			expect(plugin.providerName).toBe('agentmemory');
		});

		it('exposes a JSON Schema with baseUrl + apiKey + envVar fallbacks', () => {
			const schema = plugin.settingsSchema;
			const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
			expect(props.baseUrl).toBeDefined();
			expect(props.baseUrl['x-envVar']).toBe('AGENTMEMORY_BASE_URL');
			expect(props.apiKey['x-secret']).toBe(true);
			expect(props.apiKey['x-envVar']).toBe('AGENTMEMORY_API_KEY');
		});

		it('declares itself the default for agent-memory in its manifest', () => {
			const manifest = plugin.getManifest();
			expect(manifest.defaultForCapabilities).toContain('agent-memory');
			expect(manifest.builtIn).toBe(true);
		});
	});

	describe('validateSettings', () => {
		it('accepts empty / default settings (works against localhost)', async () => {
			await expect(plugin.validateSettings({})).resolves.toEqual({ valid: true });
		});

		it('rejects non-http(s) baseUrl', async () => {
			const result = await plugin.validateSettings({ baseUrl: 'ftp://x.example' });
			expect(result.valid).toBe(false);
			expect(result.errors?.[0].path).toBe('baseUrl');
		});

		it('rejects nonsense baseUrl', async () => {
			const result = await plugin.validateSettings({ baseUrl: 'not a url' });
			expect(result.valid).toBe(false);
		});

		it('rejects too-small timeout', async () => {
			const result = await plugin.validateSettings({ timeoutMs: 50 });
			expect(result.valid).toBe(false);
			expect(result.errors?.[0].path).toBe('timeoutMs');
		});
	});

	describe('validateConnection', () => {
		it('hits the health endpoint and surfaces success', async () => {
			mockHealth.mockResolvedValueOnce({ ok: true });
			const result = await plugin.validateConnection({ baseUrl: 'http://localhost:3111' });
			expect(result.success).toBe(true);
			expect(result.message).toMatch(/Connected to agentmemory/);
		});

		it('reports the error message on failure', async () => {
			mockHealth.mockRejectedValueOnce(new Error('ECONNREFUSED'));
			const result = await plugin.validateConnection({});
			expect(result.success).toBe(false);
			expect(result.message).toMatch(/ECONNREFUSED/);
		});
	});

	describe('saveMemory', () => {
		it('routes to /observe when a sessionId is present', async () => {
			mockObserve.mockResolvedValueOnce({ id: 'obs-1', createdAt: '2026-01-01T00:00:00Z' });
			const record = await plugin.saveMemory({
				content: 'fixed the bug',
				sessionId: 'sess-9',
				settings: {}
			});
			expect(mockObserve).toHaveBeenCalledWith(
				expect.objectContaining({ content: 'fixed the bug', sessionId: 'sess-9' })
			);
			expect(mockRemember).not.toHaveBeenCalled();
			expect(record.id).toBe('obs-1');
		});

		it('routes to /remember when no session is open', async () => {
			mockRemember.mockResolvedValueOnce({ id: 'mem-1', createdAt: '2026-01-01T00:00:00Z' });
			const record = await plugin.saveMemory({ content: 'fact', settings: {} });
			expect(mockRemember).toHaveBeenCalled();
			expect(mockObserve).not.toHaveBeenCalled();
			expect(record.id).toBe('mem-1');
		});

		it('passes through tags / metadata / projectId verbatim', async () => {
			mockRemember.mockResolvedValueOnce({ id: 'm', createdAt: 'now' });
			await plugin.saveMemory({
				content: 'X',
				tags: ['bug'],
				metadata: { file: 'a.ts' },
				projectId: 'proj-A',
				settings: {}
			});
			expect(mockRemember).toHaveBeenCalledWith(
				expect.objectContaining({
					tags: ['bug'],
					metadata: { file: 'a.ts' },
					projectId: 'proj-A'
				})
			);
		});
	});

	describe('searchMemory', () => {
		it('normalises results from /smart-search no matter which field name carries them', async () => {
			mockSmartSearch.mockResolvedValueOnce({
				matches: [
					{ id: '1', text: 'one' },
					{ id: '2', text: 'two' }
				],
				digest: 'summary-text'
			});
			const result = await plugin.searchMemory({ query: 'x', settings: {} });
			expect(result.results).toHaveLength(2);
			expect(result.results[0].content).toBe('one');
			expect(result.summary).toBe('summary-text');
		});

		it('honours the limit when provided', async () => {
			mockSmartSearch.mockResolvedValueOnce({ results: [] });
			await plugin.searchMemory({ query: 'q', limit: 25, settings: {} });
			expect(mockSmartSearch).toHaveBeenCalledWith(expect.objectContaining({ limit: 25 }));
		});
	});

	describe('buildContext', () => {
		it('returns the content field even when the server uses `text` instead', async () => {
			mockContext.mockResolvedValueOnce({ text: 'context-text', approx_tokens: 42 });
			const ctx = await plugin.buildContext({ settings: {} });
			expect(ctx.content).toBe('context-text');
			expect(ctx.approxTokens).toBe(42);
		});
	});

	describe('lifecycle', () => {
		it('captures the context on load and releases on unload', async () => {
			const ctx = createContext();
			await plugin.onLoad(ctx);
			expect(ctx.logger.log).toHaveBeenCalledWith('agentmemory plugin loaded');
			await plugin.onUnload();
		});

		it('reports healthy', async () => {
			const health = await plugin.healthCheck();
			expect(health.status).toBe('healthy');
		});
	});
});
