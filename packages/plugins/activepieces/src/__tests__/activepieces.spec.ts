import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ActivepiecesPlugin } from '../activepieces.plugin.js';
import type { DirectoryReference, GenerationRequest, ExistingItems, PluginContext } from '@ever-works/plugin';

// Mock the Activepieces REST client used by the plugin
const mockValidateFlow = vi.fn();
const mockExecuteFlow = vi.fn();
const mockPing = vi.fn();

vi.mock('../utils/activepieces-client.js', () => ({
	ActivepiecesClient: vi.fn().mockImplementation(() => ({
		validateFlow: mockValidateFlow,
		executeFlow: mockExecuteFlow,
		ping: mockPing
	}))
}));

function createMockContext(): PluginContext {
	return {
		pluginId: 'activepieces',
		logger: {
			log: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			debug: vi.fn()
		},
		cache: {
			get: vi.fn(),
			set: vi.fn(),
			delete: vi.fn(),
			clear: vi.fn()
		},
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
			isDevelopment: vi.fn().mockReturnValue(false),
			isProduction: vi.fn().mockReturnValue(true),
			getAll: vi.fn().mockReturnValue({})
		},
		envVars: {},
		services: {} as never,
		getSettings: vi.fn().mockResolvedValue({ apiKey: 'test-api-key' }),
		getResolvedSettings: vi.fn().mockResolvedValue({
			settings: { apiKey: 'test-api-key', defaultFlowId: 'flow-test-123' },
			source: 'user'
		}),
		onEvent: vi.fn().mockReturnValue({ unsubscribe: vi.fn() }),
		emitEvent: vi.fn(),
		registerCustomCapability: vi.fn(),
		getCustomCapability: vi.fn()
	} as unknown as PluginContext;
}

function createDirectory(overrides?: Partial<DirectoryReference>): DirectoryReference {
	return {
		id: 'dir-123',
		name: 'Test Directory',
		slug: 'test-directory',
		description: 'A test directory',
		user: { id: 'user-456' },
		...overrides
	};
}

function createRequest(overrides?: Partial<GenerationRequest>): GenerationRequest {
	return {
		prompt: 'Find the best AI tools',
		generationMethod: 'create-update',
		config: {
			flow_id: 'flow-test-123',
			target_items: 50,
			webhook_mode: 'sync'
		},
		...overrides
	};
}

function createExisting(overrides?: Partial<ExistingItems>): ExistingItems {
	return {
		items: [],
		categories: [],
		tags: [],
		...overrides
	};
}

describe('ActivepiecesPlugin', () => {
	let plugin: ActivepiecesPlugin;

	beforeEach(() => {
		plugin = new ActivepiecesPlugin();
		vi.clearAllMocks();

		mockValidateFlow.mockResolvedValue({ id: 'flow-test-123', status: 'ENABLED', publishedVersionId: 'v1' });
		mockPing.mockResolvedValue(undefined);
		mockExecuteFlow.mockResolvedValue({
			output: {
				items: [
					{
						name: 'Test Item 1',
						description: 'A test item',
						url: 'https://example.com/1',
						category: 'Tools',
						tags: ['ai']
					},
					{
						name: 'Test Item 2',
						description: 'Another test item',
						url: 'https://example.com/2',
						tags: ['tag1']
					}
				],
				categories: [{ name: 'Tools', description: 'Development tools' }],
				tags: [{ name: 'tag1' }]
			},
			flowRunId: 'run-1',
			flowDuration: 1234
		});
	});

	describe('metadata', () => {
		it('should have correct id and category', () => {
			expect(plugin.id).toBe('activepieces');
			expect(plugin.category).toBe('pipeline');
		});

		it('should have pipeline and form-schema-provider capabilities', () => {
			expect(plugin.capabilities).toContain('pipeline');
			expect(plugin.capabilities).toContain('form-schema-provider');
		});

		it('should require user configuration', () => {
			expect(plugin.configurationMode).toBe('user-required');
		});

		it('should have apiKey as required in settings schema', () => {
			expect(plugin.settingsSchema.required).toContain('apiKey');
		});

		it('should mark apiKey as secret', () => {
			const apiKeyProp = (plugin.settingsSchema.properties as Record<string, Record<string, unknown>>).apiKey;
			expect(apiKeyProp['x-secret']).toBe(true);
		});
	});

	describe('lifecycle', () => {
		it('should load successfully', async () => {
			const ctx = createMockContext();
			await plugin.onLoad(ctx);
			expect(ctx.logger.log).toHaveBeenCalledWith('Activepieces Automation plugin loaded');
		});

		it('should unload successfully', async () => {
			await plugin.onLoad(createMockContext());
			await expect(plugin.onUnload()).resolves.toBeUndefined();
		});

		it('should report healthy status', async () => {
			const health = await plugin.healthCheck();
			expect(health.status).toBe('healthy');
		});
	});

	describe('isAvailable', () => {
		it('should return true when API key is provided', async () => {
			expect(await plugin.isAvailable({ apiKey: 'test-key' })).toBe(true);
		});

		it('should return false when no API key', async () => {
			expect(await plugin.isAvailable({})).toBe(false);
			expect(await plugin.isAvailable({ apiKey: '' })).toBe(false);
		});
	});

	describe('validateSettings', () => {
		it('should pass with valid API key', async () => {
			const result = await plugin.validateSettings({ apiKey: 'test-key' });
			expect(result.valid).toBe(true);
		});

		it('should fail without API key', async () => {
			const result = await plugin.validateSettings({});
			expect(result.valid).toBe(false);
		});
	});

	describe('getStepDefinitions', () => {
		it('should return 6 steps', () => {
			const steps = plugin.getStepDefinitions();
			expect(steps).toHaveLength(6);
		});

		it('should have unique step IDs', () => {
			const steps = plugin.getStepDefinitions();
			const ids = steps.map((s) => s.id);
			expect(new Set(ids).size).toBe(ids.length);
		});

		it('should start with validate-activepieces and end with cleanup', () => {
			const steps = plugin.getStepDefinitions();
			expect(steps[0].id).toBe('validate-activepieces');
			expect(steps[steps.length - 1].id).toBe('cleanup');
		});
	});

	describe('getFormFields', () => {
		it('should include flow_id field as optional', () => {
			const fields = plugin.getFormFields();
			const flowField = fields.find((f) => f.name === 'flow_id');
			expect(flowField).toBeDefined();
			expect(flowField!.validation?.required).toBeUndefined();
		});

		it('should include target_items with default of 50', () => {
			const fields = plugin.getFormFields();
			const targetField = fields.find((f) => f.name === 'target_items');
			expect(targetField).toBeDefined();
			expect(targetField!.defaultValue).toBe(50);
		});

		it('should default webhook_mode to sync', () => {
			const fields = plugin.getFormFields();
			const modeField = fields.find((f) => f.name === 'webhook_mode');
			expect(modeField).toBeDefined();
			expect(modeField!.defaultValue).toBe('sync');
		});
	});

	describe('validateFormInput', () => {
		it('should pass without flow_id (falls back to plugin settings)', () => {
			const result = plugin.validateFormInput({});
			expect(result.valid).toBe(true);
		});

		it('should fail when repo access enabled without URL', () => {
			const result = plugin.validateFormInput({
				flow_id: 'flow-123',
				pass_repo_access: true
			});
			expect(result.valid).toBe(false);
		});

		it('should fail when repo access enabled without token', () => {
			const result = plugin.validateFormInput({
				flow_id: 'flow-123',
				pass_repo_access: true,
				repo_url: 'https://github.com/org/repo'
			});
			expect(result.valid).toBe(false);
		});

		it('should pass when repo access is fully configured', () => {
			const result = plugin.validateFormInput({
				flow_id: 'flow-123',
				pass_repo_access: true,
				repo_url: 'https://github.com/org/repo',
				repo_access_token: 'ghp_test'
			});
			expect(result.valid).toBe(true);
		});
	});

	describe('execute', () => {
		beforeEach(async () => {
			await plugin.onLoad(createMockContext());
		});

		it('should fail without user ID', async () => {
			const result = await plugin.execute(
				createDirectory({ user: undefined }),
				createRequest(),
				createExisting()
			);
			expect(result.success).toBe(false);
		});

		it('should fail without flow ID', async () => {
			const ctx = createMockContext();
			ctx.getResolvedSettings = vi.fn().mockResolvedValue({
				settings: { apiKey: 'test-api-key' },
				source: 'user'
			});
			await plugin.onLoad(ctx);

			const result = await plugin.execute(createDirectory(), createRequest({ config: {} }), createExisting());
			expect(result.success).toBe(false);
			expect(result.error).toBeDefined();
		});

		it('should execute sync flow successfully', async () => {
			const result = await plugin.execute(createDirectory(), createRequest(), createExisting());

			expect(result.success).toBe(true);
			expect(result.outputs.items.length).toBeGreaterThan(0);
			expect(result.stepsCompleted).toBeGreaterThan(0);
		});

		it('should return categories and tags from flow output', async () => {
			const result = await plugin.execute(createDirectory(), createRequest(), createExisting());

			expect(result.success).toBe(true);
			expect(result.outputs.categories.length).toBeGreaterThan(0);
		});

		it('should deduplicate items against existing', async () => {
			const existing = createExisting({
				items: [{ name: 'Test Item 1', description: 'Existing item' } as never]
			});

			const result = await plugin.execute(createDirectory(), createRequest(), existing);

			expect(result.success).toBe(true);
			const hasExisting = result.outputs.items.some((i) => i.name === 'Test Item 1');
			expect(hasExisting).toBe(false);
		});

		it('should handle cancellation', async () => {
			const abortController = new AbortController();
			abortController.abort();

			const result = await plugin.execute(createDirectory(), createRequest(), createExisting(), {
				signal: abortController.signal
			});

			expect(result.success).toBe(false);
		});

		it('should track state during execution', async () => {
			await plugin.execute(createDirectory(), createRequest(), createExisting());

			const state = plugin.getState();
			expect(state).toBeDefined();
			expect(state!.completedSteps.length).toBeGreaterThan(0);
		});
	});

	describe('validateConnection', () => {
		it('should succeed with valid API key and flow', async () => {
			await plugin.onLoad(createMockContext());
			const result = await plugin.validateConnection({
				apiKey: 'valid-key',
				defaultFlowId: 'flow-test-123'
			});
			expect(result.success).toBe(true);
			expect(result.message).toContain('Activepieces');
		});

		it('should succeed when only API key is provided (no flow)', async () => {
			await plugin.onLoad(createMockContext());
			const result = await plugin.validateConnection({ apiKey: 'valid-key' });
			expect(result.success).toBe(true);
			expect(mockPing).toHaveBeenCalled();
		});

		it('should fail without API key', async () => {
			await plugin.onLoad(createMockContext());
			const result = await plugin.validateConnection({});
			expect(result.success).toBe(false);
			expect(result.message).toContain('API key');
		});
	});

	describe('getManifest', () => {
		it('should return a valid manifest', () => {
			const manifest = plugin.getManifest();
			expect(manifest.id).toBe('activepieces');
			expect(manifest.name).toBe('Activepieces Automation');
			expect(manifest.category).toBe('pipeline');
			expect(manifest.builtIn).toBe(true);
		});
	});
});
