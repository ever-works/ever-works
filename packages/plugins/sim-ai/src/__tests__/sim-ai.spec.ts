import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SimAiPlugin } from '../sim-ai.plugin.js';
import type { DirectoryReference, GenerationRequest, ExistingItems, PluginContext } from '@ever-works/plugin';

// Mock the simstudio-ts-sdk
vi.mock('simstudio-ts-sdk', () => ({
	SimStudioClient: vi.fn().mockImplementation(() => ({
		validateWorkflow: vi.fn().mockResolvedValue(true),
		getWorkflowStatus: vi.fn().mockResolvedValue({ isDeployed: true, needsRedeployment: false }),
		executeWorkflow: vi.fn().mockResolvedValue({
			success: true,
			output: {
				items: [
					{
						name: 'Test Item 1',
						description: 'A test item',
						url: 'https://example.com/1',
						category: 'Tools'
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
			}
		}),
		executeWithRetry: vi.fn().mockResolvedValue({
			success: true,
			output: {
				items: [
					{
						name: 'Test Item 1',
						description: 'A test item',
						url: 'https://example.com/1',
						category: 'Tools'
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
			}
		}),
		getJobStatus: vi.fn().mockResolvedValue({
			status: 'completed',
			output: {
				items: [{ name: 'Async Item', description: 'From async' }]
			},
			metadata: { duration: 5000 }
		}),
		getRateLimitInfo: vi.fn().mockReturnValue(null),
		getUsageLimits: vi.fn().mockResolvedValue({
			success: true,
			rateLimit: { sync: { remaining: 100 }, async: { remaining: 100 } },
			usage: { currentPeriodCost: 0, limit: 100, plan: 'pro' }
		})
	})),
	SimStudioError: class SimStudioError extends Error {
		code?: string;
		status?: number;
		constructor(message: string, code?: string) {
			super(message);
			this.code = code;
		}
	}
}));

function createMockContext(): PluginContext {
	return {
		pluginId: 'sim-ai',
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
		getResolvedSettings: vi.fn().mockResolvedValue({ settings: { apiKey: 'test-api-key' }, source: 'user' }),
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
			workflow_id: 'wf-test-123',
			target_items: 50
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

describe('SimAiPlugin', () => {
	let plugin: SimAiPlugin;

	beforeEach(() => {
		plugin = new SimAiPlugin();
		vi.clearAllMocks();
	});

	describe('metadata', () => {
		it('should have correct id and category', () => {
			expect(plugin.id).toBe('sim-ai');
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
			expect(ctx.logger.log).toHaveBeenCalledWith('SIM AI Workflows plugin loaded');
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

		it('should start with validate-sim and end with cleanup', () => {
			const steps = plugin.getStepDefinitions();
			expect(steps[0].id).toBe('validate-sim');
			expect(steps[steps.length - 1].id).toBe('cleanup');
		});
	});

	describe('getFormFields', () => {
		it('should include workflow_id field', () => {
			const fields = plugin.getFormFields();
			const workflowField = fields.find((f) => f.name === 'workflow_id');
			expect(workflowField).toBeDefined();
			expect(workflowField!.validation?.required).toBe(true);
		});

		it('should include target_items with default of 50', () => {
			const fields = plugin.getFormFields();
			const targetField = fields.find((f) => f.name === 'target_items');
			expect(targetField).toBeDefined();
			expect(targetField!.defaultValue).toBe(50);
		});

		it('should not include execution_mode field', () => {
			const fields = plugin.getFormFields();
			const modeField = fields.find((f) => f.name === 'execution_mode');
			expect(modeField).toBeUndefined();
		});
	});

	describe('validateFormInput', () => {
		it('should fail without workflow_id', () => {
			const result = plugin.validateFormInput({});
			expect(result.valid).toBe(false);
		});

		it('should pass with workflow_id', () => {
			const result = plugin.validateFormInput({ workflow_id: 'wf-123' });
			expect(result.valid).toBe(true);
		});

		it('should fail when repo access enabled without URL', () => {
			const result = plugin.validateFormInput({
				workflow_id: 'wf-123',
				pass_repo_access: true
			});
			expect(result.valid).toBe(false);
		});

		it('should fail when repo access enabled without token', () => {
			const result = plugin.validateFormInput({
				workflow_id: 'wf-123',
				pass_repo_access: true,
				repo_url: 'https://github.com/org/repo'
			});
			expect(result.valid).toBe(false);
		});

		it('should pass when repo access is fully configured', () => {
			const result = plugin.validateFormInput({
				workflow_id: 'wf-123',
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

		it('should fail without workflow ID', async () => {
			const result = await plugin.execute(createDirectory(), createRequest({ config: {} }), createExisting());
			expect(result.success).toBe(false);
			expect(result.error).toBeDefined();
		});

		it('should execute sync workflow successfully', async () => {
			const result = await plugin.execute(createDirectory(), createRequest(), createExisting());

			expect(result.success).toBe(true);
			expect(result.outputs.items.length).toBeGreaterThan(0);
			expect(result.stepsCompleted).toBeGreaterThan(0);
		});

		it('should return categories and tags from SIM output', async () => {
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
		it('should succeed with valid API key', async () => {
			await plugin.onLoad(createMockContext());
			const result = await plugin.validateConnection({ apiKey: 'valid-key' });
			expect(result.success).toBe(true);
			expect(result.message).toContain('Connected to SIM');
		});

		it('should fail without API key', async () => {
			await plugin.onLoad(createMockContext());
			const result = await plugin.validateConnection({});
			expect(result.success).toBe(false);
			expect(result.message).toContain('API key');
		});
	});

	describe('execute - async mode', () => {
		beforeEach(async () => {
			await plugin.onLoad(createMockContext());
		});

		it('should execute async workflow successfully', async () => {
			const result = await plugin.execute(
				createDirectory(),
				createRequest({ config: { workflow_id: 'wf-async' } }),
				createExisting()
			);

			expect(result.success).toBe(true);
			expect(result.outputs.items.length).toBeGreaterThan(0);
		});
	});

	describe('getManifest', () => {
		it('should return a valid manifest', () => {
			const manifest = plugin.getManifest();
			expect(manifest.id).toBe('sim-ai');
			expect(manifest.name).toBe('SIM AI Workflows');
			expect(manifest.category).toBe('pipeline');
			expect(manifest.builtIn).toBe(true);
		});
	});
});
