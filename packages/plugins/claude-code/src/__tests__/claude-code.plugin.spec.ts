import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { ClaudeCodePlugin } from '../claude-code.plugin';
import type { PluginContext, PluginSettings } from '@ever-works/plugin';

// Mock all utility modules
vi.mock('../utils/binary-manager', () => ({
	ensureBinary: vi.fn().mockResolvedValue('/tmp/claude-code-generator/bin/claude-2.1.37-linux-x64')
}));

vi.mock('../utils/workspace-manager', () => ({
	createWorkspace: vi.fn().mockResolvedValue('/tmp/claude-code-generator/user1/dir1'),
	ensureOnboardingConfig: vi.fn().mockResolvedValue(undefined),
	seedExistingItems: vi.fn().mockResolvedValue(undefined),
	seedMetadata: vi.fn().mockResolvedValue(undefined),
	readGeneratedItems: vi.fn().mockResolvedValue([
		{
			name: 'Test Item',
			description: 'A test item',
			source_url: 'https://example.com',
			category: 'Testing',
			tags: ['test']
		}
	]),
	collectMetadataFromItems: vi.fn().mockReturnValue({
		categories: [{ id: 'testing', name: 'Testing' }],
		tags: [{ id: 'test', name: 'test' }],
		brands: []
	}),
	cleanupWorkspace: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('../utils/process-runner', () => ({
	executeClaudeCode: vi.fn().mockReturnValue({
		promise: Promise.resolve({
			stdout: 'Done',
			stderr: '',
			exitCode: 0,
			killed: false,
			duration: 5000
		}),
		kill: vi.fn()
	})
}));

vi.mock('../prompt/system-prompt', () => ({
	buildSystemPrompt: vi.fn().mockReturnValue('system prompt'),
	buildUserPrompt: vi.fn().mockReturnValue('user prompt')
}));

function createMockContext(settingsOverride?: PluginSettings): PluginContext {
	return {
		pluginId: 'claude-code',
		logger: {
			log: vi.fn(),
			error: vi.fn(),
			warn: vi.fn(),
			debug: vi.fn()
		},
		cache: {
			get: vi.fn(),
			set: vi.fn(),
			delete: vi.fn(),
			has: vi.fn(),
			clear: vi.fn()
		},
		http: {
			get: vi.fn(),
			post: vi.fn(),
			put: vi.fn(),
			patch: vi.fn(),
			delete: vi.fn()
		},
		env: {
			nodeEnv: 'test',
			isDevelopment: false,
			isProduction: false,
			isTest: true
		},
		envVars: {
			get: vi.fn(),
			has: vi.fn(),
			getRequired: vi.fn()
		},
		services: {},
		getSettings: vi.fn().mockResolvedValue(
			settingsOverride ?? {
				oauthToken: 'test-token',
				version: '2.1.37',
				maxTurns: 20
			}
		),
		getResolvedSettings: vi.fn(),
		onEvent: vi.fn().mockReturnValue({ unsubscribe: vi.fn() }),
		emitEvent: vi.fn(),
		registerCustomCapability: vi.fn(),
		getCustomCapability: vi.fn(),
		hasCustomCapability: vi.fn(),
		listCustomCapabilities: vi.fn()
	} as unknown as PluginContext;
}

describe('ClaudeCodePlugin', () => {
	let plugin: ClaudeCodePlugin;

	beforeEach(() => {
		plugin = new ClaudeCodePlugin();
		vi.clearAllMocks();
	});

	afterEach(async () => {
		await plugin.onUnload();
	});

	describe('Plugin Properties', () => {
		it('should have correct id', () => {
			expect(plugin.id).toBe('claude-code');
		});

		it('should have correct name', () => {
			expect(plugin.name).toBe('Claude Code Generator');
		});

		it('should have correct version', () => {
			expect(plugin.version).toBe('1.0.0');
		});

		it('should have correct category', () => {
			expect(plugin.category).toBe('pipeline');
		});

		it('should include full-pipeline capability', () => {
			expect(plugin.capabilities).toContain('full-pipeline');
		});

		it('should have user-required configuration mode', () => {
			expect(plugin.configurationMode).toBe('user-required');
		});
	});

	describe('Settings Schema', () => {
		it('should define oauthToken as a secret user-scoped field', () => {
			const props = plugin.settingsSchema.properties!;
			expect(props.oauthToken).toBeDefined();
			expect(props.oauthToken['x-secret']).toBe(true);
			expect(props.oauthToken['x-scope']).toBe('user');
		});

		it('should define apiKey as a secret user-scoped field', () => {
			const props = plugin.settingsSchema.properties!;
			expect(props.apiKey).toBeDefined();
			expect(props.apiKey['x-secret']).toBe(true);
			expect(props.apiKey['x-scope']).toBe('user');
		});

		it('should define version as a hidden field with default', () => {
			const props = plugin.settingsSchema.properties!;
			expect(props.version['x-hidden']).toBe(true);
			expect(props.version.default).toBe('2.1.37');
		});

		it('should define maxTurns as a hidden integer field', () => {
			const props = plugin.settingsSchema.properties!;
			expect(props.maxTurns.type).toBe('integer');
			expect(props.maxTurns['x-hidden']).toBe(true);
			expect(props.maxTurns.default).toBe(50);
		});

		it('should have a required group for auth fields', () => {
			const groups = plugin.settingsSchema['x-requiredGroups'];
			expect(groups).toBeDefined();
			expect(groups).toHaveLength(1);
			expect(groups![0].fields).toContain('oauthToken');
			expect(groups![0].fields).toContain('apiKey');
		});
	});

	describe('validateSettings', () => {
		it('should pass when oauthToken is provided', async () => {
			const result = await plugin.validateSettings({ oauthToken: 'token' });
			expect(result.valid).toBe(true);
		});

		it('should pass when apiKey is provided', async () => {
			const result = await plugin.validateSettings({ apiKey: 'key' });
			expect(result.valid).toBe(true);
		});

		it('should pass when both are provided', async () => {
			const result = await plugin.validateSettings({ oauthToken: 'token', apiKey: 'key' });
			expect(result.valid).toBe(true);
		});

		it('should fail when neither is provided', async () => {
			const result = await plugin.validateSettings({});
			expect(result.valid).toBe(false);
			expect(result.errors).toHaveLength(1);
			expect(result.errors![0].code).toBe('auth-required');
		});
	});

	describe('Step Definitions', () => {
		it('should return 5 step definitions', () => {
			const steps = plugin.getStepDefinitions();
			expect(steps).toHaveLength(5);
		});

		it('should have correct step IDs in order', () => {
			const steps = plugin.getStepDefinitions();
			const ids = steps.map((s) => s.id);
			expect(ids).toEqual([
				'setup-claude-code',
				'prepare-context',
				'generate-items',
				'collect-results',
				'cleanup'
			]);
		});

		it('should have setup-claude-code as first step', () => {
			const steps = plugin.getStepDefinitions();
			expect(steps[0].position).toEqual({ type: 'first' });
		});

		it('should have cleanup as last step', () => {
			const steps = plugin.getStepDefinitions();
			const cleanup = steps.find((s) => s.id === 'cleanup');
			expect(cleanup?.position).toEqual({ type: 'last' });
			expect(cleanup?.optional).toBe(true);
		});

		it('should have no parallelizable steps', () => {
			const steps = plugin.getStepDefinitions();
			expect(steps.every((s) => s.parallelizable === false)).toBe(true);
		});
	});

	describe('Execution Plan', () => {
		it('should create a plan with 5 sequential phases', () => {
			const plan = plugin.createExecutionPlan();
			expect(plan.phases).toHaveLength(5);
			expect(plan.totalSteps).toBe(5);
		});

		it('should have all phases as non-parallel', () => {
			const plan = plugin.createExecutionPlan();
			expect(plan.phases.every((p) => p.parallel === false)).toBe(true);
		});

		it('should have estimated duration', () => {
			const plan = plugin.createExecutionPlan();
			expect(plan.estimatedDuration).toBeGreaterThan(0);
		});
	});

	describe('Lifecycle', () => {
		it('should load without error', async () => {
			const ctx = createMockContext();
			await expect(plugin.onLoad(ctx)).resolves.not.toThrow();
		});

		it('should unload without error', async () => {
			const ctx = createMockContext();
			await plugin.onLoad(ctx);
			await expect(plugin.onUnload()).resolves.not.toThrow();
		});

		it('should return null state before execution', () => {
			expect(plugin.getState()).toBeNull();
		});
	});

	describe('execute', () => {
		const directory = {
			id: 'dir1',
			name: 'Test Directory',
			slug: 'test-directory',
			description: 'A test directory',
			user: { id: 'user1' }
		};

		const request = {
			prompt: 'Generate items for testing tools',
			name: 'Testing Tools'
		};

		const existing = {
			items: [],
			categories: [],
			tags: []
		};

		it('should execute successfully and return items', async () => {
			const ctx = createMockContext();
			await plugin.onLoad(ctx);

			const result = await plugin.execute(directory, request, existing);

			expect(result.success).toBe(true);
			expect(result.items).toHaveLength(1);
			expect(result.items[0].name).toBe('Test Item');
			expect(result.stepsCompleted).toBe(5);
			expect(result.totalSteps).toBe(5);
		});

		it('should report progress during execution', async () => {
			const ctx = createMockContext();
			await plugin.onLoad(ctx);

			const progressUpdates: Array<{ percent: number; currentStepName: string }> = [];
			const onProgress = vi.fn((p) => progressUpdates.push(p));

			await plugin.execute(directory, request, existing, undefined, onProgress);

			expect(onProgress).toHaveBeenCalled();
			expect(progressUpdates.length).toBeGreaterThan(0);
			// Last update should be 100%
			const lastUpdate = progressUpdates[progressUpdates.length - 1];
			expect(lastUpdate.percent).toBe(100);
		});

		it('should have running state during execution', async () => {
			const ctx = createMockContext();
			await plugin.onLoad(ctx);

			// State is null before execution
			expect(plugin.getState()).toBeNull();

			await plugin.execute(directory, request, existing);

			// After execution, state should exist
			const state = plugin.getState();
			expect(state).not.toBeNull();
		});

		it('should include categories and tags in result', async () => {
			const ctx = createMockContext();
			await plugin.onLoad(ctx);

			const result = await plugin.execute(directory, request, existing);

			expect(result.categories).toHaveLength(1);
			expect(result.tags).toHaveLength(1);
		});

		it('should include metrics in result', async () => {
			const ctx = createMockContext();
			await plugin.onLoad(ctx);

			const result = await plugin.execute(directory, request, existing);

			expect(result.metrics).toBeDefined();
			expect(result.metrics!.itemsProcessed).toBe(1);
			expect(result.duration).toBeGreaterThanOrEqual(0);
		});
	});
});
