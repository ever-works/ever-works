import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { GeminiPlugin } from '../gemini.plugin';
import type { PluginContext, PluginSettings } from '@ever-works/plugin';
import type { TaxonomyWatcherOptions } from '../utils/taxonomy-watcher';

// Capture the onNewItem callback passed to startTaxonomyWatcher
let capturedWatcherOptions: TaxonomyWatcherOptions | null = null;

// Mock all utility modules
vi.mock('../utils/binary-manager', () => ({
	ensureBinary: vi.fn().mockResolvedValue('/tmp/gemini-generator/bin/gemini-latest/node_modules/.bin/gemini')
}));

vi.mock('../utils/workspace-manager', () => ({
	createWorkspace: vi.fn().mockResolvedValue('/tmp/gemini-generator/user1/dir1'),
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
	executeGemini: vi.fn().mockReturnValue({
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
		pluginId: 'gemini',
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
				apiKey: 'test-key',
				version: 'latest',
				maxTurns: 20,
				model: 'gemini-2.5-flash'
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

describe('GeminiPlugin', () => {
	let plugin: GeminiPlugin;

	beforeEach(() => {
		plugin = new GeminiPlugin();
		capturedWatcherOptions = null;
		vi.clearAllMocks();
	});

	afterEach(async () => {
		await plugin.onUnload();
	});

	it('should have correct plugin metadata', () => {
		expect(plugin.id).toBe('gemini');
		expect(plugin.name).toBe('Gemini Generator');
		expect(plugin.category).toBe('pipeline');
		expect(plugin.capabilities).toContain('pipeline');
		expect(plugin.configurationMode).toBe('user-required');
	});

	it('should define Gemini auth fields as user-scoped settings', () => {
		const props = plugin.settingsSchema.properties!;
		expect(props.apiKey['x-secret']).toBe(true);
		expect(props.apiKey['x-scope']).toBe('user');
		expect(props.authMode).toBeUndefined();
		expect(props.googleCloudProject).toBeUndefined();
		expect(props.googleCloudLocation).toBeUndefined();
	});

	it('should validate API key settings', () => {
		expect(plugin.validateSettings({})).toEqual({
			valid: false,
			errors: [{ path: 'apiKey', message: 'API key is required.' }]
		});

		expect(plugin.validateSettings({ apiKey: 123 })).toEqual({
			valid: false,
			errors: [
				{ path: 'apiKey', message: 'API key must be a string when provided' },
				{ path: 'apiKey', message: 'API key is required.' }
			]
		});

		expect(plugin.validateSettings({ apiKey: 'test-key' })).toEqual({ valid: true });
	});

	it('should validate form input bounds and types', () => {
		expect(plugin.validateFormInput({ target_items: 50, capture_screenshots: false })).toEqual({ valid: true });
		expect(plugin.validateFormInput({ target_items: 0 })).toEqual({
			valid: false,
			errors: [{ path: 'target_items', message: 'target_items must be between 1 and 500' }]
		});
		expect(plugin.validateFormInput({ capture_screenshots: 'yes' })).toEqual({
			valid: false,
			errors: [{ path: 'capture_screenshots', message: 'capture_screenshots must be a boolean' }]
		});
	});

	it('should return 6 step definitions in correct order', () => {
		const steps = plugin.getStepDefinitions();
		expect(steps.map((s) => s.id)).toEqual([
			'setup-gemini',
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

			const result = await plugin.execute(work, request, existing);

			expect(result.success).toBe(true);
			expect(result.outputs.items).toHaveLength(1);
			expect(result.outputs.items[0].name).toBe('Test Item');
			expect(result.outputs.categories).toHaveLength(1);
			expect(result.outputs.tags).toHaveLength(1);
			expect(result.metrics!.itemsProcessed).toBe(1);
			expect(result.warnings).toBeUndefined();

			const { executeGemini } = await import('../utils/process-runner');
			expect(vi.mocked(executeGemini)).toHaveBeenCalledWith(
				expect.objectContaining({
					env: expect.objectContaining({
						GEMINI_CONFIG_DIR: '/tmp/gemini-generator/config/user1',
						HOME: '/tmp/gemini-generator/config/user1',
						XDG_CONFIG_HOME: '/tmp/gemini-generator/config/user1/.config',
						XDG_DATA_HOME: '/tmp/gemini-generator/config/user1/.local/share',
						XDG_CACHE_HOME: '/tmp/gemini-generator/config/user1/.cache',
						GEMINI_API_KEY: 'test-key'
					})
				})
			);
		});

		it('should report progress ending at 100%', async () => {
			const ctx = createMockContext();
			await plugin.onLoad(ctx);

			const progressUpdates: Array<{ percent: number }> = [];
			await plugin.execute(work, request, existing, undefined, (p) => progressUpdates.push(p));

			expect(progressUpdates.length).toBeGreaterThan(0);
			expect(progressUpdates[progressUpdates.length - 1].percent).toBe(100);
		});

		it('should report item-level progress via onNewItem callback', async () => {
			// Make executeGemini call onNewItem before resolving
			const { executeGemini } = await import('../utils/process-runner');
			vi.mocked(executeGemini).mockImplementationOnce(() => ({
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
			await plugin.execute(work, { ...request, config: { target_items: 10 } }, existing, undefined, (p) =>
				progressUpdates.push(p)
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

		it('should stream structured Gemini CLI logs during generation', async () => {
			const { executeGemini } = await import('../utils/process-runner');
			vi.mocked(executeGemini).mockImplementationOnce((options) => {
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
				onLogEntry: (log) => logs.push(log)
			});

			expect(logs).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						event: 'step_started',
						message: 'Setup Gemini CLI',
						stepIndex: 0,
						stepName: 'Setup Gemini CLI'
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
			const { executeGemini } = await import('../utils/process-runner');
			vi.mocked(executeGemini).mockReturnValueOnce({
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

			const result = await plugin.execute(work, request, existing);

			expect(result.success).toBe(true);
			expect(result.warnings).toHaveLength(1);
			expect(result.warnings![0]).toContain('API rate limit exceeded');
		});

		it('should use stdout for warning when stderr is empty', async () => {
			const { executeGemini } = await import('../utils/process-runner');
			vi.mocked(executeGemini).mockReturnValueOnce({
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

			const result = await plugin.execute(work, request, existing);

			expect(result.warnings).toHaveLength(1);
			expect(result.warnings![0]).toContain('Max turns reached');
		});

		it('should skip screenshots when no execContext and succeed when facade throws', async () => {
			const ctx = createMockContext();
			await plugin.onLoad(ctx);

			// No execContext → screenshots skipped
			const result1 = await plugin.execute(work, request, existing);
			expect(result1.success).toBe(true);
			expect(plugin.getState()?.steps.get('capture-screenshots')?.status).toBe('skipped');

			// Reset
			vi.clearAllMocks();
			const plugin2 = new GeminiPlugin();
			await plugin2.onLoad(createMockContext());

			// Facade throws → pipeline still succeeds
			const result2 = await plugin2.execute(work, request, existing, {
				execContext: {
					aiFacade: {} as never,
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

			const result = await plugin.execute(work, { ...request, config: { capture_screenshots: true } }, existing, {
				execContext: {
					aiFacade: {} as never,
					searchFacade: {} as never,
					screenshotFacade: mockScreenshotFacade as never,
					contentExtractorFacade: {} as never,
					logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
					work,
					user: { id: 'user1' }
				}
			});

			expect(result.success).toBe(true);
			expect(mockScreenshotFacade.getSmartImage).toHaveBeenCalled();
			expect(plugin.getState()?.steps.get('capture-screenshots')?.status).toBe('completed');
		});
	});
});
