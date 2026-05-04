import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PluginContext, PluginSettings } from '@ever-works/plugin';

import { CodexPlugin } from '../codex.plugin.js';
import * as pipelineHelpers from '../utils/pipeline-helpers.js';
import * as processRunner from '../utils/process-runner.js';
import * as workspaceManager from '../utils/workspace-manager.js';
import * as screenshotCapture from '../utils/screenshot-capture.js';
import * as binaryManager from '../utils/binary-manager.js';
import * as taxonomyWatcher from '../utils/taxonomy-watcher.js';

vi.mock('../utils/pipeline-helpers.js', async () => {
	const actual = await vi.importActual<typeof import('../utils/pipeline-helpers.js')>('../utils/pipeline-helpers.js');

	return {
		...actual,
		resolveSettings: vi.fn(),
		resolveExecutionAuth: vi.fn(),
		hasDeviceCodexAuth: vi.fn()
	};
});

vi.mock('../utils/process-runner.js', () => ({
	executeCodex: vi.fn()
}));

vi.mock('../utils/workspace-manager.js', async () => {
	const actual = await vi.importActual<typeof import('../utils/workspace-manager.js')>(
		'../utils/workspace-manager.js'
	);

	return {
		...actual,
		createWorkspace: vi.fn(),
		seedExistingItems: vi.fn(),
		seedMetadata: vi.fn(),
		readGeneratedItems: vi.fn(),
		collectMetadataFromItems: vi.fn(),
		writeGeneratedItems: vi.fn(),
		cleanupWorkspace: vi.fn()
	};
});

vi.mock('../utils/screenshot-capture.js', () => ({
	captureScreenshots: vi.fn()
}));

vi.mock('../utils/binary-manager.js', () => ({
	ensureBinary: vi.fn()
}));

vi.mock('../utils/taxonomy-watcher.js', () => ({
	startTaxonomyWatcher: vi.fn(() => ({ stop: vi.fn() }))
}));

function createMockContext(settingsOverride?: PluginSettings): PluginContext {
	return {
		pluginId: 'codex',
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
				apiKey: 'sk-test',
				model: 'codex-mini-latest'
			}
		),
		getResolvedSettings: vi.fn(),
		updateSettings: vi.fn(),
		onEvent: vi.fn().mockReturnValue({ unsubscribe: vi.fn() }),
		emitEvent: vi.fn(),
		registerCustomCapability: vi.fn(),
		getCustomCapability: vi.fn(),
		hasCustomCapability: vi.fn(),
		listCustomCapabilities: vi.fn()
	} as unknown as PluginContext;
}

describe('CodexPlugin', () => {
	let plugin: CodexPlugin;

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

	beforeEach(() => {
		plugin = new CodexPlugin();
		vi.clearAllMocks();

		vi.mocked(pipelineHelpers.resolveSettings).mockResolvedValue({
			apiKey: 'sk-test',
			model: 'codex-mini-latest'
		});
		vi.mocked(pipelineHelpers.resolveExecutionAuth).mockResolvedValue({
			mode: 'api-key',
			env: { OPENAI_API_KEY: 'sk-test' }
		});
		vi.mocked(pipelineHelpers.hasDeviceCodexAuth).mockResolvedValue(false);
		vi.mocked(binaryManager.ensureBinary).mockResolvedValue('/tmp/codex-generator/bin/codex');

		vi.mocked(workspaceManager.createWorkspace).mockResolvedValue('/tmp/codex-generator/user1/dir1');
		vi.mocked(workspaceManager.seedExistingItems).mockResolvedValue(undefined);
		vi.mocked(workspaceManager.seedMetadata).mockResolvedValue(undefined);
		vi.mocked(workspaceManager.readGeneratedItems).mockResolvedValue([
			{
				name: 'Test Item',
				description: 'A test item',
				source_url: 'https://example.com',
				category: 'Testing',
				tags: ['test']
			}
		]);
		vi.mocked(workspaceManager.collectMetadataFromItems).mockReturnValue({
			categories: [{ id: 'testing', name: 'Testing' }],
			tags: [{ id: 'test', name: 'test' }],
			brands: [],
			collections: []
		});
		vi.mocked(workspaceManager.writeGeneratedItems).mockResolvedValue(undefined);
		vi.mocked(workspaceManager.cleanupWorkspace).mockResolvedValue(undefined);

		vi.mocked(processRunner.executeCodex).mockReturnValue({
			promise: Promise.resolve({
				stdout: 'Done',
				stderr: '',
				exitCode: 0,
				killed: false,
				duration: 5000
			}),
			kill: vi.fn()
		});

		vi.mocked(screenshotCapture.captureScreenshots).mockResolvedValue({
			status: 'completed',
			errors: []
		});
	});

	afterEach(async () => {
		await plugin.onUnload();
	});

	it('exposes the expected plugin identity', () => {
		expect(plugin.id).toBe('codex');
		expect(plugin.category).toBe('pipeline');
		expect(plugin.capabilities).toContain('pipeline');
		expect(plugin.capabilities).toContain('form-schema-provider');
	});

	it('returns step definitions', () => {
		expect(plugin.getStepDefinitions()).toHaveLength(6);
		expect(plugin.getStepDefinitions()[0]?.id).toBe('setup-codex');
	});

	it('does not rely on legacy completion fields in the manifest', () => {
		expect(plugin.getManifest().uiHints?.completionFields).toBeUndefined();
	});

	it('fails API key validation when the key cannot be verified', async () => {
		const validateApiKeySpy = vi.spyOn(plugin as never, 'validateApiKey').mockResolvedValue(false as never);

		const result = await plugin.validateConnection({
			apiKey: 'sk-test',
			model: 'codex-mini-latest'
		});

		expect(result.success).toBe(false);
		expect(result.message).toContain('validation failed');

		validateApiKeySpy.mockRestore();
	});

	it('verifies Codex device auth through the CLI validation path', async () => {
		vi.mocked(pipelineHelpers.hasDeviceCodexAuth).mockResolvedValue(true);
		const validateCliAuthSpy = vi.spyOn(plugin as never, 'validateCliAuth').mockResolvedValue(true as never);

		const result = await plugin.validateConnection({
			model: 'codex-mini-latest'
		});

		expect(result.success).toBe(true);
		expect(result.message).toContain('Codex device authentication verified');

		validateCliAuthSpy.mockRestore();
	});

	it('does not use host-global device auth fallback during unscoped connection validation', async () => {
		vi.mocked(pipelineHelpers.hasDeviceCodexAuth).mockResolvedValue(false);

		const result = await plugin.validateConnection({
			authMode: 'device-auth'
		});

		expect(pipelineHelpers.hasDeviceCodexAuth).toHaveBeenCalledWith({ authMode: 'device-auth' });
		expect(result.success).toBe(false);
		expect(result.message).toContain('is not configured for this user');
	});

	describe('execute', () => {
		it('returns a successful normalized PipelineResult', async () => {
			await plugin.onLoad(createMockContext());

			const progressUpdates: Array<{ percent: number }> = [];
			const result = await plugin.execute(work, request, existing, undefined, (progress) =>
				progressUpdates.push(progress)
			);

			expect(result.success).toBe(true);
			expect(result.outputs.items).toHaveLength(1);
			expect(result.outputs.items[0].name).toBe('Test Item');
			expect(result.outputs.categories).toHaveLength(1);
			expect(result.outputs.tags).toHaveLength(1);
			expect(result.metrics?.itemsProcessed).toBe(1);
			expect(progressUpdates.at(-1)?.percent).toBe(100);
			expect(plugin.getState()?.steps.get('generate-items')?.status).toBe('completed');
			expect(plugin.getState()?.steps.get('capture-screenshots')?.status).toBe('skipped');
		});

		it('returns a failed result when Codex exits with non-zero code and produces no items', async () => {
			const recoverySpy = vi
				.spyOn(plugin as never, 'recoverItemsFromStructuredOutput')
				.mockResolvedValue([] as never);
			vi.mocked(processRunner.executeCodex).mockReturnValueOnce({
				promise: Promise.resolve({
					stdout: '',
					stderr: 'Error: Codex failed',
					exitCode: 1,
					killed: false,
					duration: 1000
				}),
				kill: vi.fn()
			});
			vi.mocked(workspaceManager.readGeneratedItems).mockResolvedValue([]);

			await plugin.onLoad(createMockContext());

			const result = await plugin.execute(work, request, existing);

			expect(result.success).toBe(false);
			expect(String(result.error)).toContain('Codex completed without producing any valid item JSON files');
			expect(workspaceManager.cleanupWorkspace).toHaveBeenCalledWith('/tmp/codex-generator/user1/dir1');
			recoverySpy.mockRestore();
		});

		it('succeeds with warning when Codex exits with non-zero code but produces items', async () => {
			vi.mocked(processRunner.executeCodex).mockReturnValueOnce({
				promise: Promise.resolve({
					stdout: '',
					stderr: 'Error: Codex failed',
					exitCode: 1,
					killed: false,
					duration: 1000
				}),
				kill: vi.fn()
			});

			await plugin.onLoad(createMockContext());

			const result = await plugin.execute(work, request, existing);

			expect(result.success).toBe(true);
			expect(result.warnings).toBeDefined();
			expect(result.warnings!.some((w) => w.includes('Codex finished with an error'))).toBe(true);
		});

		it('fails when Codex finishes without producing any valid item JSON files', async () => {
			const recoverySpy = vi
				.spyOn(plugin as never, 'recoverItemsFromStructuredOutput')
				.mockResolvedValue([] as never);
			vi.mocked(workspaceManager.readGeneratedItems).mockResolvedValueOnce([]);
			vi.mocked(processRunner.executeCodex).mockReturnValueOnce({
				promise: Promise.resolve({
					stdout: 'Research complete\nNo files created',
					stderr: '',
					exitCode: 0,
					killed: false,
					duration: 1000
				}),
				kill: vi.fn()
			});
			vi.mocked(workspaceManager.createWorkspace).mockResolvedValueOnce('/tmp/codex-generator/user1/dir1');
			vi.mocked(workspaceManager.cleanupWorkspace).mockResolvedValue(undefined);

			await plugin.onLoad(createMockContext());

			const result = await plugin.execute(work, request, existing);

			expect(result.success).toBe(false);
			expect(String(result.error)).toContain('without producing any valid item JSON files');
			expect(String(result.error)).toContain('Visible workspace entries');
			expect(String(result.error)).toContain('Codex output excerpt');
			recoverySpy.mockRestore();
		});

		it('recovers items from structured output when Codex research completes but writes no files', async () => {
			const recoveredItems = [
				{
					name: 'Recovered Item',
					description: 'Recovered from structured output',
					source_url: 'https://example.com/recovered',
					category: 'Testing',
					tags: ['test']
				}
			];

			vi.spyOn(plugin as never, 'recoverItemsFromStructuredOutput').mockResolvedValue(recoveredItems as never);
			vi.mocked(workspaceManager.readGeneratedItems)
				.mockResolvedValueOnce([])
				.mockResolvedValueOnce(recoveredItems as never);

			await plugin.onLoad(createMockContext());

			const result = await plugin.execute(work, request, existing);

			expect(result.success).toBe(true);
			expect(result.outputs.items).toHaveLength(1);
			expect(result.outputs.items[0].name).toBe('Recovered Item');
		});

		it('retries once with sandbox bypass when Codex reports file writes were blocked', async () => {
			const recoverySpy = vi
				.spyOn(plugin as never, 'recoverItemsFromStructuredOutput')
				.mockResolvedValue([] as never);
			vi.mocked(workspaceManager.readGeneratedItems)
				.mockResolvedValueOnce([])
				.mockResolvedValueOnce([
					{
						name: 'Bypass Item',
						description: 'Created after bypass retry',
						source_url: 'https://example.com/bypass',
						category: 'Testing',
						tags: ['test']
					}
				] as never);

			vi.mocked(processRunner.executeCodex)
				.mockReturnValueOnce({
					promise: Promise.resolve({
						stdout: 'If you want the fastest recovery path, re-run this task in a session where local file tools are working and I can write the JSON files directly. If needed, I can also paste the full 12 ready-to-save JSON objects in the next reply.',
						stderr: 'tokens used',
						exitCode: 0,
						killed: false,
						duration: 1000
					}),
					kill: vi.fn()
				})
				.mockReturnValueOnce({
					promise: Promise.resolve({
						stdout: 'Files written',
						stderr: '',
						exitCode: 0,
						killed: false,
						duration: 1000
					}),
					kill: vi.fn()
				});

			await plugin.onLoad(createMockContext());

			await plugin.execute(work, request, existing);

			expect(processRunner.executeCodex).toHaveBeenNthCalledWith(
				2,
				expect.objectContaining({
					bypassApprovalsAndSandbox: true
				})
			);
			expect(recoverySpy).not.toHaveBeenCalled();
			recoverySpy.mockRestore();
		});

		it('translates stdin-interactive Codex failures into a clearer auth message', async () => {
			const recoverySpy = vi
				.spyOn(plugin as never, 'recoverItemsFromStructuredOutput')
				.mockResolvedValue([] as never);
			vi.mocked(processRunner.executeCodex).mockReturnValueOnce({
				promise: Promise.resolve({
					stdout: '',
					stderr: 'Reading additional input from stdin...',
					exitCode: 1,
					killed: false,
					duration: 1000
				}),
				kill: vi.fn()
			});
			vi.mocked(workspaceManager.readGeneratedItems).mockResolvedValue([]);

			await plugin.onLoad(createMockContext());

			const result = await plugin.execute(work, request, existing);

			expect(result.success).toBe(false);
			expect(String(result.error)).toContain('Codex completed without producing any valid item JSON files');
			recoverySpy.mockRestore();
		});

		it('executes using device-auth mode when resolved settings include a portable auth payload', async () => {
			vi.mocked(pipelineHelpers.resolveSettings).mockResolvedValueOnce({
				model: 'codex-mini-latest',
				deviceAuthAuthJson: '{"token":"abc"}'
			});
			vi.mocked(pipelineHelpers.resolveExecutionAuth).mockResolvedValueOnce({
				mode: 'device-auth',
				authJson: '{"token":"abc"}'
			});

			await plugin.onLoad(createMockContext());

			const result = await plugin.execute(work, request, existing);

			expect(result.success).toBe(true);
			expect(processRunner.executeCodex).toHaveBeenCalledWith(
				expect.objectContaining({
					env: expect.objectContaining({
						CODEX_HOME: expect.stringContaining('/_meta/device-auth/.codex')
					})
				})
			);
		});

		it('passes the unsafe bypass flag to the runner when enabled in settings', async () => {
			vi.mocked(pipelineHelpers.resolveSettings).mockResolvedValueOnce({
				apiKey: 'sk-test',
				model: 'codex-mini-latest',
				unsafeBypassSandbox: true
			});

			await plugin.onLoad(createMockContext());

			const result = await plugin.execute(work, request, existing);

			expect(result.success).toBe(true);
			expect(processRunner.executeCodex).toHaveBeenCalledWith(
				expect.objectContaining({
					bypassApprovalsAndSandbox: true
				})
			);
		});

		it('completes the screenshot step when a screenshot facade is available', async () => {
			await plugin.onLoad(createMockContext());

			const mockScreenshotFacade = {
				isAvailable: () => true,
				getSmartImage: vi.fn(),
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
			expect(screenshotCapture.captureScreenshots).toHaveBeenCalled();
			expect(plugin.getState()?.steps.get('capture-screenshots')?.status).toBe('completed');
		});
	});
});
