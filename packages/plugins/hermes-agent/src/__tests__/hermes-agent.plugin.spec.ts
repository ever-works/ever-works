import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PluginContext, PluginSettings } from '@ever-works/plugin';

import { HermesAgentPlugin } from '../hermes-agent.plugin.js';
import * as processRunner from '../utils/process-runner.js';
import * as binaryManager from '../utils/binary-manager.js';
import * as workspaceManager from '../utils/workspace-manager.js';
import * as screenshotCapture from '../utils/screenshot-capture.js';

vi.mock('../utils/process-runner.js', () => ({
	executeHermes: vi.fn()
}));

vi.mock('../utils/binary-manager.js', () => ({
	ensureBinary: vi.fn(),
	validateProfile: vi.fn()
}));

vi.mock('../utils/workspace-manager.js', () => ({
	createWorkspace: vi.fn(),
	seedExistingItems: vi.fn(),
	seedMetadata: vi.fn(),
	writeResultSchema: vi.fn(),
	readGeneratedResult: vi.fn(),
	collectMetadataFromItems: vi.fn(),
	cleanupWorkspace: vi.fn()
}));

vi.mock('../utils/screenshot-capture.js', () => ({
	captureScreenshots: vi.fn()
}));

function createMockContext(overrides?: Partial<Record<'global' | 'user' | 'directory', PluginSettings>>): PluginContext {
	return {
		pluginId: 'hermes-agent',
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
		getSettings: vi.fn(async (scope: 'global' | 'user' | 'directory') => overrides?.[scope] ?? {}),
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

describe('HermesAgentPlugin', () => {
	let plugin: HermesAgentPlugin;

	const directory = {
		id: 'dir-1',
		name: 'Test Directory',
		slug: 'test-directory',
		description: 'A test directory',
		user: { id: 'user-1' }
	};

	const request = {
		name: 'Test Generation',
		prompt: 'Generate a few test items',
		config: {}
	};

	const existing = {
		items: [],
		categories: [],
		tags: [],
		brands: []
	};

	beforeEach(() => {
		plugin = new HermesAgentPlugin();
		vi.clearAllMocks();

		vi.mocked(binaryManager.ensureBinary).mockResolvedValue('/usr/bin/hermes');
		vi.mocked(binaryManager.validateProfile).mockResolvedValue(undefined);
		vi.mocked(workspaceManager.createWorkspace).mockResolvedValue('/tmp/hermes-workspace');
		vi.mocked(workspaceManager.seedExistingItems).mockResolvedValue(undefined);
		vi.mocked(workspaceManager.seedMetadata).mockResolvedValue(undefined);
		vi.mocked(workspaceManager.writeResultSchema).mockResolvedValue(undefined);
		vi.mocked(workspaceManager.readGeneratedResult).mockResolvedValue({
			items: [],
			errors: [],
			repairedJson: false,
			resultFilePath: '/tmp/hermes-workspace/_meta/hermes-result.json'
		});
		vi.mocked(workspaceManager.collectMetadataFromItems).mockReturnValue({
			categories: [],
			tags: [],
			brands: [],
			collections: []
		});
		vi.mocked(workspaceManager.cleanupWorkspace).mockResolvedValue(undefined);
		vi.mocked(screenshotCapture.captureScreenshots).mockResolvedValue({
			status: 'completed',
			errors: []
		});
	});

	afterEach(async () => {
		await plugin.onUnload();
	});

	it('validates the selected Hermes profile during connection checks', async () => {
		await plugin.onLoad(createMockContext());

		const result = await plugin.validateConnection({
			profile: 'work',
			binaryPath: '/usr/bin/hermes'
		});

		expect(binaryManager.validateProfile).toHaveBeenCalledWith(
			expect.objectContaining({
				profile: 'work',
				binaryPath: '/usr/bin/hermes'
			}),
			expect.any(Object)
		);
		expect(result.success).toBe(true);
		expect(result.message).toContain('profile "work"');
	});

	it('cancels the merged execution signal even when an external signal is provided', async () => {
		await plugin.onLoad(
			createMockContext({
				global: { profile: 'default' },
				user: { profile: 'work' }
			})
		);

		const externalController = new AbortController();
		let executionSignal: AbortSignal | undefined;
		let resolveExecution: ((value: processRunner.ExecuteResult) => void) | undefined;
		const kill = vi.fn();
		const executionStarted = new Promise<void>((resolve) => {
			vi.mocked(processRunner.executeHermes).mockImplementation(({ signal }) => {
				executionSignal = signal;
				resolve();

				const promise = new Promise<processRunner.ExecuteResult>((innerResolve) => {
					resolveExecution = innerResolve;
					signal?.addEventListener(
						'abort',
						() =>
							innerResolve({
								stdout: '',
								stderr: '',
								exitCode: null,
								killed: true,
								duration: 0
							}),
						{ once: true }
					);
				});

				return { promise, kill };
			});
		});

		const executionPromise = plugin.execute(directory as never, request as never, existing as never, {
			signal: externalController.signal
		});

		await executionStarted;
		await plugin.cancel();

		const result = await executionPromise;

		expect(executionSignal?.aborted).toBe(true);
		expect(externalController.signal.aborted).toBe(false);
		expect(kill).toHaveBeenCalledTimes(1);
		expect(result.success).toBe(false);
		expect(result.error).toBe('Pipeline cancelled');

		resolveExecution?.({
			stdout: '',
			stderr: '',
			exitCode: null,
			killed: true,
			duration: 0
		});
	});
});
