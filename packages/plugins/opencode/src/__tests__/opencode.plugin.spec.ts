import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { OpenCodePlugin } from '../opencode.plugin';
import type { PluginContext, PluginSettings } from '@ever-works/plugin';
import type { TaxonomyWatcherOptions } from '../utils/taxonomy-watcher';

// Capture the onNewItem callback passed to startTaxonomyWatcher
let capturedWatcherOptions: TaxonomyWatcherOptions | null = null;

// Mock all utility modules
vi.mock('../utils/binary-manager', () => ({
	ensureBinary: vi.fn().mockResolvedValue('/tmp/opencode-generator/bin/opencode-v1.0.223-linux-x64')
}));

vi.mock('../utils/workspace-manager', () => ({
	createWorkspace: vi.fn().mockResolvedValue('/tmp/opencode-generator/user1/dir1'),
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
	executeOpenCode: vi.fn().mockReturnValue({
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

vi.mock('../utils/opencode-config', () => ({
	prepareOpenCodeSessionConfig: vi.fn().mockResolvedValue({
		sessionDir: '/tmp/opencode-generator/user1/opencode/dir1',
		configDir: '/tmp/opencode-generator/user1/opencode/dir1/config',
		model: 'everworks/test-complex-model',
		env: {
			HOME: '/tmp/opencode-generator/user1/opencode/dir1',
			XDG_DATA_HOME: '/tmp/opencode-generator/user1/opencode/dir1/data',
			OPENCODE_CONFIG_DIR: '/tmp/opencode-generator/user1/opencode/dir1/config',
			OPENCODE_CONFIG_CONTENT: '{}',
			OPENCODE_PROVIDER_API_KEY: 'provider-key',
			OPENCODE_ENABLE_EXA: '1',
			OPENCODE_DISABLE_AUTOUPDATE: '1'
		}
	}),
	cleanupOpenCodeSessionConfig: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('../prompt/system-prompt', () => ({
	buildSystemPrompt: vi.fn().mockReturnValue('system prompt'),
	buildUserPrompt: vi.fn().mockReturnValue('user prompt'),
	buildSystemPromptVariables: vi.fn().mockReturnValue({}),
	buildUserPromptVariables: vi.fn().mockReturnValue({}),
	DEFAULT_SYSTEM_PROMPT: 'default system prompt',
	DEFAULT_USER_PROMPT: 'default user prompt'
}));

vi.mock('../utils/taxonomy-watcher', () => ({
	startTaxonomyWatcher: vi.fn().mockImplementation((options: TaxonomyWatcherOptions) => {
		capturedWatcherOptions = options;
		return { stop: vi.fn() };
	})
}));

function createMockContext(settingsOverride?: PluginSettings): PluginContext {
	return {
		pluginId: 'opencode',
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
				version: 'v1.0.223'
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

function createExecContext(overrides?: Record<string, unknown>) {
	return {
		aiFacade: {
			getProviderConfig: vi.fn().mockResolvedValue({
				providerId: 'test-ai-provider',
				providerName: 'Test AI Provider',
				baseUrl: 'https://ai.example.com/v1',
				apiKey: 'provider-key',
				defaultModel: 'test-default-model',
				routing: {
					complexModel: 'test-complex-model'
				}
			})
		},
		searchFacade: {} as never,
		screenshotFacade: undefined,
		contentExtractorFacade: {} as never,
		promptFacade: undefined,
		logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
		work: {
			id: 'dir1'
		},
		user: { id: 'user1' },
		...overrides
	} as never;
}

describe('OpenCodePlugin', () => {
	let plugin: OpenCodePlugin;

	beforeEach(() => {
		plugin = new OpenCodePlugin();
		capturedWatcherOptions = null;
		vi.clearAllMocks();
	});

	afterEach(async () => {
		await plugin.onUnload();
	});

	it('should have correct plugin metadata', () => {
		expect(plugin.id).toBe('opencode');
		expect(plugin.name).toBe('OpenCode Generator');
		expect(plugin.category).toBe('pipeline');
		expect(plugin.capabilities).toContain('pipeline');
		expect(plugin.configurationMode).toBe('user-required');
	});

	it('should define only hidden CLI version settings and use selectable ai-provider category', () => {
		const props = plugin.settingsSchema.properties!;
		expect(Object.keys(props)).toEqual(['version']);
		expect(props.version.default).toBe('v1.0.223');
		const manifest = plugin.getManifest();
		expect(manifest.selectableProviderCategories).toContain('ai-provider');
		expect(manifest.selectableProviderCategories).toContain('screenshot');
	});

	it('should return 6 step definitions in correct order', () => {
		const steps = plugin.getStepDefinitions();
		expect(steps.map((s) => s.id)).toEqual([
			'setup-opencode',
			'prepare-context',
			'generate-items',
			'collect-results',
			'capture-screenshots',
			'cleanup'
		]);
		expect(steps[0].position).toEqual({ type: 'first' });
		expect(steps.find((s) => s.id === 'cleanup')?.position).toEqual({ type: 'last' });
	});

	it('should load and unload without error', async () => {
		const ctx = createMockContext();
		await expect(plugin.onLoad(ctx)).resolves.not.toThrow();
		expect(plugin.getState()).toBeNull();
		await expect(plugin.onUnload()).resolves.not.toThrow();
	});

	describe('execute', () => {
		const work = {
			id: 'dir1',
			name: 'Test Work',
			slug: 'test-work',
			description: 'A test work',
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

		it('should execute successfully and return items with metadata', async () => {
			const ctx = createMockContext();
			await plugin.onLoad(ctx);

			const result = await plugin.execute(work, request, existing, {
				execContext: createExecContext()
			});

			expect(result.success).toBe(true);
			expect(result.outputs.items).toHaveLength(1);
			expect(result.outputs.items[0].name).toBe('Test Item');
			expect(result.outputs.categories).toHaveLength(1);
			expect(result.outputs.tags).toHaveLength(1);
			expect(result.metrics!.itemsProcessed).toBe(1);
			expect(result.warnings).toBeUndefined();
		});

		it('should invoke OpenCode with the provider-qualified session model', async () => {
			const ctx = createMockContext();
			await plugin.onLoad(ctx);

			const { executeOpenCode } = await import('../utils/process-runner');

			await plugin.execute(work, request, existing, {
				execContext: createExecContext()
			});

			expect(vi.mocked(executeOpenCode)).toHaveBeenCalledWith(
				expect.objectContaining({
					model: 'everworks/test-complex-model'
				})
			);
		});

		it('should report progress ending at 100%', async () => {
			const ctx = createMockContext();
			await plugin.onLoad(ctx);

			const progressUpdates: Array<{ percent: number }> = [];
			await plugin.execute(
				work,
				request,
				existing,
				{
					execContext: createExecContext()
				},
				(p) => progressUpdates.push(p)
			);

			expect(progressUpdates.length).toBeGreaterThan(0);
			expect(progressUpdates[progressUpdates.length - 1].percent).toBe(100);
		});

		it('should report item-level progress via onNewItem callback', async () => {
			// Make executeOpenCode call onNewItem before resolving
			const { executeOpenCode } = await import('../utils/process-runner');
			vi.mocked(executeOpenCode).mockImplementationOnce(() => ({
				promise: (async () => {
					// Simulate items being created during generation
					if (capturedWatcherOptions?.onNewItem) {
						capturedWatcherOptions.onNewItem(1, 'item-1.json');
						capturedWatcherOptions.onNewItem(2, 'item-2.json');
						capturedWatcherOptions.onNewItem(3, 'item-3.json');
					}
					return { stdout: 'Done', stderr: '', exitCode: 0, killed: false, duration: 5000 };
				})(),
				kill: vi.fn()
			}));

			const ctx = createMockContext();
			await plugin.onLoad(ctx);

			const progressUpdates: Array<{ percent: number; message?: string; itemsProcessed?: number }> = [];
			await plugin.execute(
				work,
				{ ...request, config: { target_items: 10 } },
				existing,
				{
					execContext: createExecContext()
				},
				(p) => progressUpdates.push(p)
			);

			// Find item-level progress updates (those with itemsProcessed)
			const itemUpdates = progressUpdates.filter((p) => p.itemsProcessed !== undefined);
			expect(itemUpdates).toHaveLength(3);

			expect(itemUpdates[0].itemsProcessed).toBe(1);
			expect(itemUpdates[0].message).toBe('1 items generated');
			expect(itemUpdates[0].percent).toBe(35); // 30 + round(1/10 * 53) = 35

			expect(itemUpdates[1].itemsProcessed).toBe(2);
			expect(itemUpdates[1].message).toBe('2 items generated');
			expect(itemUpdates[1].percent).toBe(41); // 30 + round(2/10 * 53) = 41

			expect(itemUpdates[2].itemsProcessed).toBe(3);
			expect(itemUpdates[2].message).toBe('3 items generated');
			expect(itemUpdates[2].percent).toBe(46); // 30 + round(3/10 * 53) = 46
		});

		it('should stream structured OpenCode logs during generation', async () => {
			const { executeOpenCode } = await import('../utils/process-runner');
			vi.mocked(executeOpenCode).mockImplementationOnce((options) => {
				options.onStdoutLine?.(
					JSON.stringify({
						type: 'assistant',
						message: {
							content: [{ type: 'text', text: 'Researching sources' }]
						}
					})
				);
				options.onStdoutLine?.(JSON.stringify({ type: 'tool_use', tool: 'web_search' }));
				options.onStdoutLine?.(
					JSON.stringify({
						type: 'tool_result',
						tool: 'web_search',
						result: 'Fetched 10 results'
					})
				);
				options.onStdoutLine?.('Plain text status update');
				options.onStderrLine?.('Minor warning from stderr');

				return {
					promise: Promise.resolve({
						stdout: '',
						stderr: '',
						exitCode: 0,
						killed: false,
						duration: 5000
					}),
					kill: vi.fn()
				};
			});

			const ctx = createMockContext();
			await plugin.onLoad(ctx);

			const logs: Array<{
				event: string;
				message: string;
				level: string;
				stepIndex?: number | null;
				stepName?: string | null;
			}> = [];

			await plugin.execute(work, request, existing, {
				execContext: createExecContext(),
				onLogEntry: (log) => logs.push(log)
			});

			expect(logs).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						event: 'step_started',
						message: 'Setup OpenCode',
						stepIndex: 0,
						stepName: 'Setup OpenCode'
					}),
					expect.objectContaining({
						event: 'step_started',
						message: 'Generate Items',
						stepIndex: 2,
						stepName: 'Generate Items'
					}),
					expect.objectContaining({
						event: 'message',
						level: 'info',
						message: 'Researching sources',
						stepIndex: 2,
						stepName: 'Generate Items'
					}),
					expect.objectContaining({
						event: 'message',
						level: 'info',
						message: 'Tool started: web_search'
					}),
					expect.objectContaining({
						event: 'message',
						level: 'info',
						message: 'Tool finished: web_search (Fetched 10 results)'
					}),
					expect.objectContaining({
						event: 'message',
						level: 'info',
						message: 'Plain text status update'
					}),
					expect.objectContaining({
						event: 'message',
						level: 'error',
						message: 'Minor warning from stderr'
					}),
					expect.objectContaining({
						event: 'step_completed',
						message: 'Generate Items',
						stepIndex: 2,
						stepName: 'Generate Items'
					})
				])
			);
		});

		it('should include a warning when CLI exits with non-zero code', async () => {
			const { executeOpenCode } = await import('../utils/process-runner');
			vi.mocked(executeOpenCode).mockReturnValueOnce({
				promise: Promise.resolve({
					stdout: '',
					stderr: 'Error: API rate limit exceeded',
					exitCode: 1,
					killed: false,
					duration: 3000
				}),
				kill: vi.fn()
			});

			const ctx = createMockContext();
			await plugin.onLoad(ctx);

			const result = await plugin.execute(work, request, existing, {
				execContext: createExecContext()
			});

			expect(result.success).toBe(true);
			expect(result.warnings).toHaveLength(1);
			expect(result.warnings![0]).toContain('API rate limit exceeded');
		});

		it('should use stdout for warning when stderr is empty', async () => {
			const { executeOpenCode } = await import('../utils/process-runner');
			vi.mocked(executeOpenCode).mockReturnValueOnce({
				promise: Promise.resolve({
					stdout: 'Max turns reached',
					stderr: '',
					exitCode: 1,
					killed: false,
					duration: 3000
				}),
				kill: vi.fn()
			});

			const ctx = createMockContext();
			await plugin.onLoad(ctx);

			const result = await plugin.execute(work, request, existing, {
				execContext: createExecContext()
			});

			expect(result.warnings).toHaveLength(1);
			expect(result.warnings![0]).toContain('Max turns reached');
		});

		it('should require execContext and still succeed when screenshot facade throws', async () => {
			const ctx = createMockContext();
			await plugin.onLoad(ctx);

			// No execContext → hard failure because AI provider resolution needs facade context
			const result1 = await plugin.execute(work, request, existing);
			expect(result1.success).toBe(false);

			// Reset
			vi.clearAllMocks();
			const plugin2 = new OpenCodePlugin();
			await plugin2.onLoad(createMockContext());

			// Facade throws → pipeline still succeeds
			const result2 = await plugin2.execute(work, request, existing, {
				execContext: {
					...createExecContext(),
					searchFacade: {} as never,
					screenshotFacade: {
						isAvailable: () => true,
						getSmartImage: vi.fn().mockRejectedValue(new Error('Screenshot service down')),
						capture: vi.fn(),
						getScreenshotUrl: vi.fn()
					} as never,
					contentExtractorFacade: {} as never,
					logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
					work,
					user: { id: 'user1' }
				}
			});

			expect(result2.success).toBe(true);
			expect(result2.outputs.items).toHaveLength(1);
			await plugin2.onUnload();
		});

		it('should capture screenshots when facade is available', async () => {
			const ctx = createMockContext();
			await plugin.onLoad(ctx);

			const mockScreenshotFacade = {
				isAvailable: () => true,
				getSmartImage: vi.fn().mockResolvedValue({
					primaryImage: 'https://img.example.com/screenshot.png',
					source: 'screenshot'
				}),
				capture: vi.fn(),
				getScreenshotUrl: vi.fn()
			};

			const result = await plugin.execute(
				work,
				{
					...request,
					config: {
						...(request.config || {}),
						capture_screenshots: true
					}
				},
				existing,
				{
					execContext: {
						...createExecContext(),
						searchFacade: {} as never,
						screenshotFacade: mockScreenshotFacade as never,
						contentExtractorFacade: {} as never,
						logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
						work,
						user: { id: 'user1' }
					}
				}
			);

			expect(result.success).toBe(true);
			expect(mockScreenshotFacade.getSmartImage).toHaveBeenCalled();
			expect(plugin.getState()?.steps.get('capture-screenshots')?.status).toBe('completed');
		});
	});
});
