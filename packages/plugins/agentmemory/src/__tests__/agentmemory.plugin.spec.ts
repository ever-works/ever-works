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

vi.mock('../agentmemory-client.js', () => ({
	AgentmemoryClient: vi.fn().mockImplementation(() => ({
		health: mockHealth,
		sessionStart: mockSessionStart,
		sessionEnd: mockSessionEnd,
		observe: mockObserve,
		remember: mockRemember,
		smartSearch: mockSmartSearch,
		context: mockContext,
		forget: mockForget
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
		// Clear env vars the plugin reads as last-resort fallback, so
		// tests don't accidentally inherit them from the runner.
		delete process.env.AGENTMEMORY_BASE_URL;
		delete process.env.AGENTMEMORY_API_KEY;
		delete process.env.AGENTMEMORY_PROJECT;
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

		it('exposes a JSON Schema with baseUrl + apiKey (NOT x-envVar-locked)', () => {
			const schema = plugin.settingsSchema;
			const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
			expect(props.baseUrl).toBeDefined();
			expect(props.apiKey['x-secret']).toBe(true);
			// x-envVar makes the field env-only / unsettable via the
			// admin UI (Codex P2 on PR #1073). We fall back to env
			// vars manually instead.
			expect(props.baseUrl['x-envVar']).toBeUndefined();
			expect(props.apiKey['x-envVar']).toBeUndefined();
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

		it('rejects too-large timeout (schema maximum is 120 000)', async () => {
			const result = await plugin.validateSettings({ timeoutMs: 9_999_999 });
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
		it('always routes to /remember and never /observe (observe is reserved for hook capture)', async () => {
			mockRemember.mockResolvedValueOnce({ id: 'mem-1', createdAt: '2026-01-01T00:00:00Z' });
			const record = await plugin.saveMemory({
				content: 'fact',
				sessionId: 'sess-9',
				settings: {}
			});
			expect(mockRemember).toHaveBeenCalledWith(
				expect.objectContaining({
					content: 'fact',
					sessionId: 'sess-9',
					project: 'ever-works'
				})
			);
			expect(mockObserve).not.toHaveBeenCalled();
			expect(record.id).toBe('mem-1');
		});

		it('sends the required `project` field on /remember (mapped from projectId setting)', async () => {
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
					project: 'proj-A',
					tags: ['bug'],
					metadata: { file: 'a.ts' }
				})
			);
		});

		it('throws when the server response is missing the required id field (no silent empty-string id)', async () => {
			mockRemember.mockResolvedValueOnce({ content: 'no id here', createdAt: 'now' });
			await expect(plugin.saveMemory({ content: 'X', settings: {} })).rejects.toThrow(/without an id field/);
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

		it('maps `limit` to the server-required `topK` field', async () => {
			mockSmartSearch.mockResolvedValueOnce({ results: [] });
			await plugin.searchMemory({ query: 'q', limit: 25, settings: {} });
			expect(mockSmartSearch).toHaveBeenCalledWith(
				expect.objectContaining({ topK: 25, query: 'q', project: 'ever-works' })
			);
			expect(mockSmartSearch).toHaveBeenCalledWith(expect.not.objectContaining({ limit: 25 }));
		});
	});

	describe('buildContext', () => {
		it('returns the content field even when the server uses `text` instead', async () => {
			mockContext.mockResolvedValueOnce({ text: 'context-text', approx_tokens: 42 });
			const ctx = await plugin.buildContext({ settings: {} });
			expect(ctx.content).toBe('context-text');
			expect(ctx.approxTokens).toBe(42);
		});

		it('maps `maxTokens` to the server-required `tokenBudget` field', async () => {
			mockContext.mockResolvedValueOnce({ content: 'c' });
			await plugin.buildContext({ maxTokens: 2000, settings: {} });
			expect(mockContext).toHaveBeenCalledWith(
				expect.objectContaining({ tokenBudget: 2000, project: 'ever-works' })
			);
		});
	});

	describe('deleteEntry', () => {
		it('sends `{ project, filter: { id } }` matching the upstream /forget contract', async () => {
			mockForget.mockResolvedValueOnce(undefined);
			await plugin.deleteEntry('mem-42', {});
			expect(mockForget).toHaveBeenCalledWith({
				project: 'ever-works',
				filter: { id: 'mem-42' }
			});
		});

		it('refuses an empty id rather than sending an empty filter (which would mass-delete)', async () => {
			await expect(plugin.deleteEntry('', {})).rejects.toThrow(/missing id/);
			expect(mockForget).not.toHaveBeenCalled();
		});
	});

	describe('openSession / closeSession', () => {
		it('openSession sends the required `project` field', async () => {
			mockSessionStart.mockResolvedValueOnce({ id: 'sess-1', startedAt: '2026-01-01T00:00:00Z' });
			await plugin.openSession({ projectId: 'proj-X', settings: {} });
			expect(mockSessionStart).toHaveBeenCalledWith(expect.objectContaining({ project: 'proj-X' }));
		});

		it('closeSession sends `{ project, sessionId }`', async () => {
			mockSessionEnd.mockResolvedValueOnce(undefined);
			await plugin.closeSession('sess-9', {});
			expect(mockSessionEnd).toHaveBeenCalledWith({
				project: 'ever-works',
				sessionId: 'sess-9'
			});
		});

		it('throws when the server returns a session without an id', async () => {
			mockSessionStart.mockResolvedValueOnce({ startedAt: 'now' });
			await expect(plugin.openSession({ settings: {} })).rejects.toThrow(/without an id field/);
		});
	});

	describe('env-var fallback', () => {
		it('reads AGENTMEMORY_BASE_URL when settings.baseUrl is empty', async () => {
			process.env.AGENTMEMORY_BASE_URL = 'http://envvar.example:9999';
			mockHealth.mockResolvedValueOnce({ ok: true });
			const result = await plugin.validateConnection({});
			expect(result.success).toBe(true);
			expect(result.message).toContain('http://envvar.example:9999');
		});

		it('reads AGENTMEMORY_PROJECT when settings.projectId is empty', async () => {
			process.env.AGENTMEMORY_PROJECT = 'env-proj';
			mockRemember.mockResolvedValueOnce({ id: 'mem-1', createdAt: 'now' });
			await plugin.saveMemory({ content: 'X', settings: {} });
			expect(mockRemember).toHaveBeenCalledWith(expect.objectContaining({ project: 'env-proj' }));
		});

		it('user setting wins over env var', async () => {
			process.env.AGENTMEMORY_PROJECT = 'env-proj';
			mockRemember.mockResolvedValueOnce({ id: 'mem-1', createdAt: 'now' });
			await plugin.saveMemory({ content: 'X', projectId: 'user-proj', settings: {} });
			expect(mockRemember).toHaveBeenCalledWith(expect.objectContaining({ project: 'user-proj' }));
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
