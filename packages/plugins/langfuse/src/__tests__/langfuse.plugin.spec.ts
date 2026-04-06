import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LangfusePlugin } from '../langfuse.plugin.js';
import type { PluginContext } from '@ever-works/plugin';

const mockPromptGet = vi.fn();

vi.mock('@langfuse/client', () => {
	const MockLangfuseClient = vi.fn().mockImplementation(() => ({
		prompt: { get: mockPromptGet }
	}));
	return { LangfuseClient: MockLangfuseClient };
});

describe('LangfusePlugin', () => {
	let plugin: LangfusePlugin;

	const validSettings = {
		secretKey: 'sk-lf-test-secret',
		publicKey: 'pk-lf-test-public',
		promptLabel: 'production',
		cacheTtlSeconds: 300
	};

	const mockContext: PluginContext = {
		logger: {
			log: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			debug: vi.fn()
		},
		config: {}
	} as unknown as PluginContext;

	beforeEach(() => {
		vi.clearAllMocks();
		plugin = new LangfusePlugin();
	});

	describe('metadata', () => {
		it('should have correct plugin id and name', () => {
			expect(plugin.id).toBe('langfuse');
			expect(plugin.name).toBe('Langfuse');
			expect(plugin.version).toBe('1.0.0');
		});

		it('should have utility category and prompt-provider capability', () => {
			expect(plugin.category).toBe('utility');
			expect(plugin.capabilities).toContain('prompt-provider');
		});

		it('should have hybrid configuration mode', () => {
			expect(plugin.configurationMode).toBe('hybrid');
		});
	});

	describe('settingsSchema', () => {
		it('should require secretKey and publicKey', () => {
			expect(plugin.settingsSchema.required).toContain('secretKey');
			expect(plugin.settingsSchema.required).toContain('publicKey');
		});

		it('should mark secretKey as secret', () => {
			const secretKeySchema = plugin.settingsSchema.properties?.secretKey as any;
			expect(secretKeySchema['x-secret']).toBe(true);
			expect(secretKeySchema['x-envVar']).toBe('PLUGIN_LANGFUSE_SECRET_KEY');
		});

		it('should have publicKey with envVar', () => {
			const publicKeySchema = plugin.settingsSchema.properties?.publicKey as any;
			expect(publicKeySchema['x-envVar']).toBe('PLUGIN_LANGFUSE_PUBLIC_KEY');
		});

		it('should have optional baseUrl for self-hosted with default', () => {
			const baseUrlSchema = plugin.settingsSchema.properties?.baseUrl as any;
			expect(baseUrlSchema['x-envVar']).toBe('PLUGIN_LANGFUSE_BASE_URL');
			expect(baseUrlSchema.default).toBe('https://cloud.langfuse.com');
			expect(plugin.settingsSchema.required).not.toContain('baseUrl');
		});

		it('should have promptLabel with default', () => {
			const labelSchema = plugin.settingsSchema.properties?.promptLabel as any;
			expect(labelSchema.default).toBe('production');
		});

		it('should have cacheTtlSeconds with default', () => {
			const cacheSchema = plugin.settingsSchema.properties?.cacheTtlSeconds as any;
			expect(cacheSchema.default).toBe(300);
			expect(cacheSchema.type).toBe('number');
		});
	});

	describe('isAvailable', () => {
		it('should return false without settings', () => {
			expect(plugin.isAvailable()).toBe(false);
		});

		it('should return false with empty settings', () => {
			expect(plugin.isAvailable({})).toBe(false);
		});

		it('should return false with only secretKey', () => {
			expect(plugin.isAvailable({ secretKey: 'sk-lf-test' })).toBe(false);
		});

		it('should return false with only publicKey', () => {
			expect(plugin.isAvailable({ publicKey: 'pk-lf-test' })).toBe(false);
		});

		it('should return true with both keys', () => {
			expect(plugin.isAvailable(validSettings)).toBe(true);
		});
	});

	describe('getPrompt', () => {
		beforeEach(async () => {
			await plugin.onLoad(mockContext);
		});

		it('should return null when settings are missing', async () => {
			const result = await plugin.getPrompt('test.key');
			expect(result).toBeNull();
		});

		it('should return null when plugin is not available', async () => {
			const result = await plugin.getPrompt('test.key', { settings: {} });
			expect(result).toBeNull();
		});

		it('should return prompt result from Langfuse', async () => {
			const mockGet = mockPromptGet;
			mockGet.mockResolvedValue({ prompt: 'Hello {{name}}!', version: 5 });

			const result = await plugin.getPrompt('greeting', { settings: validSettings });

			expect(result).toEqual({ template: 'Hello {{name}}!', version: 5 });
		});

		it('should return null when prompt is not found (404)', async () => {
			const mockGet = mockPromptGet;
			mockGet.mockRejectedValue(new Error('Prompt not found (404)'));

			const result = await plugin.getPrompt('missing.key', { settings: validSettings });
			expect(result).toBeNull();
		});

		it('should return null on unexpected error', async () => {
			const mockGet = mockPromptGet;
			mockGet.mockRejectedValue(new Error('Network timeout'));

			const result = await plugin.getPrompt('test.key', { settings: validSettings });
			expect(result).toBeNull();
		});

		it('should pass label and cacheTtlSeconds to client', async () => {
			const mockGet = mockPromptGet;
			mockGet.mockResolvedValue({ prompt: 'test', version: 1 });

			await plugin.getPrompt('test.key', {
				settings: { ...validSettings, promptLabel: 'staging', cacheTtlSeconds: 60 }
			});

			expect(mockGet).toHaveBeenCalledWith('test.key', {
				label: 'staging',
				cacheTtlSeconds: 60,
				type: 'text'
			});
		});
	});

	describe('lifecycle', () => {
		it('should load and unload without errors', async () => {
			await expect(plugin.onLoad(mockContext)).resolves.not.toThrow();
			await expect(plugin.onUnload()).resolves.not.toThrow();
		});
	});

	describe('healthCheck', () => {
		it('should return healthy status', async () => {
			const result = await plugin.healthCheck();
			expect(result.status).toBe('healthy');
		});
	});

	describe('getManifest', () => {
		it('should return manifest with readme documenting prompt keys', () => {
			const manifest = plugin.getManifest();
			expect(manifest.id).toBe('langfuse');
			expect(manifest.readme).toContain('standard-pipeline.domain-detection');
			expect(manifest.readme).toContain('standard-pipeline.generation');
			expect(manifest.defaultForCapabilities).toContain('prompt-provider');
		});
	});
});
