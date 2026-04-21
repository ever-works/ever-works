import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MakePlugin } from '../make.plugin.js';
import type { DirectoryReference, GenerationRequest, ExistingItems, PluginContext } from '@ever-works/plugin';

interface MockResponseInit {
	status?: number;
	statusText?: string;
	body?: unknown;
}

function mockResponse(init: MockResponseInit = {}): Response {
	const status = init.status ?? 200;
	const body = typeof init.body === 'string' ? init.body : JSON.stringify(init.body ?? {});
	return {
		ok: status >= 200 && status < 300,
		status,
		statusText: init.statusText ?? 'OK',
		text: () => Promise.resolve(body)
	} as unknown as Response;
}

function createMockContext(): PluginContext {
	return {
		pluginId: 'make',
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
	} as DirectoryReference;
}

function createRequest(overrides?: Partial<GenerationRequest>): GenerationRequest {
	return {
		prompt: 'Find the best AI tools',
		generationMethod: 'create-update',
		config: {
			execution_mode: 'scenario',
			scenario_id: '42',
			target_items: 50
		},
		...overrides
	} as GenerationRequest;
}

function createExisting(overrides?: Partial<ExistingItems>): ExistingItems {
	return {
		items: [],
		categories: [],
		tags: [],
		...overrides
	} as ExistingItems;
}

/**
 * Programs the fetch mock for a full successful scenario run:
 *  1. validate scenario
 *  2. run scenario
 *  3. poll → success with output
 */
function mockSuccessfulScenarioRun(fetchMock: ReturnType<typeof vi.fn>): void {
	fetchMock
		.mockResolvedValueOnce(
			mockResponse({
				body: { scenario: { id: 42, name: 'My Scenario', isActive: true } }
			})
		)
		.mockResolvedValueOnce(mockResponse({ body: { executionId: 'exec-1', status: 'running' } }))
		.mockResolvedValueOnce(
			mockResponse({
				body: {
					execution: {
						status: 'success',
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
									category: 'Tools',
									tags: ['tag1']
								}
							],
							categories: [{ name: 'Tools', description: 'Development tools' }],
							tags: [{ name: 'tag1' }]
						}
					}
				}
			})
		);
}

describe('MakePlugin', () => {
	let plugin: MakePlugin;
	const fetchMock = vi.fn();

	beforeEach(() => {
		plugin = new MakePlugin();
		fetchMock.mockReset();
		vi.stubGlobal('fetch', fetchMock);
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	describe('metadata', () => {
		it('should have correct id and category', () => {
			expect(plugin.id).toBe('make');
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
			expect(ctx.logger.log).toHaveBeenCalledWith('Make.com Workflows plugin loaded');
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

		it('should start with validate-make and end with cleanup', () => {
			const steps = plugin.getStepDefinitions();
			expect(steps[0].id).toBe('validate-make');
			expect(steps[steps.length - 1].id).toBe('cleanup');
		});
	});

	describe('getFormFields', () => {
		it('should include execution_mode field with scenario default', () => {
			const fields = plugin.getFormFields();
			const mode = fields.find((f) => f.name === 'execution_mode');
			expect(mode).toBeDefined();
			expect(mode!.defaultValue).toBe('scenario');
		});

		it('should include scenario_id and webhook_url fields', () => {
			const fields = plugin.getFormFields();
			expect(fields.find((f) => f.name === 'scenario_id')).toBeDefined();
			expect(fields.find((f) => f.name === 'webhook_url')).toBeDefined();
		});

		it('should include target_items with default of 50', () => {
			const fields = plugin.getFormFields();
			const target = fields.find((f) => f.name === 'target_items');
			expect(target).toBeDefined();
			expect(target!.defaultValue).toBe(50);
		});
	});

	describe('validateFormInput', () => {
		it('should pass when scenario mode is used without extra config', () => {
			const result = plugin.validateFormInput({ execution_mode: 'scenario' });
			expect(result.valid).toBe(true);
		});

		it('should fail when webhook mode is selected without URL', () => {
			const result = plugin.validateFormInput({ execution_mode: 'webhook' });
			expect(result.valid).toBe(false);
		});

		it('should pass when webhook mode has a URL', () => {
			const result = plugin.validateFormInput({
				execution_mode: 'webhook',
				webhook_url: 'https://hook.us2.make.com/abc'
			});
			expect(result.valid).toBe(true);
		});

		it('should fail when repo access enabled without URL', () => {
			const result = plugin.validateFormInput({
				scenario_id: '42',
				pass_repo_access: true
			});
			expect(result.valid).toBe(false);
		});

		it('should fail when repo access enabled without token', () => {
			const result = plugin.validateFormInput({
				scenario_id: '42',
				pass_repo_access: true,
				repo_url: 'https://github.com/org/repo'
			});
			expect(result.valid).toBe(false);
		});

		it('should pass when repo access is fully configured', () => {
			const result = plugin.validateFormInput({
				scenario_id: '42',
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

		it('should fail without scenario ID in scenario mode', async () => {
			const result = await plugin.execute(
				createDirectory(),
				createRequest({ config: { execution_mode: 'scenario' } }),
				createExisting()
			);
			expect(result.success).toBe(false);
			expect(result.error).toBeDefined();
		});

		it('should fail without webhook URL in webhook mode', async () => {
			const result = await plugin.execute(
				createDirectory(),
				createRequest({ config: { execution_mode: 'webhook' } }),
				createExisting()
			);
			expect(result.success).toBe(false);
			expect(result.error).toBeDefined();
		});

		it('should execute a scenario run successfully', async () => {
			mockSuccessfulScenarioRun(fetchMock);

			const result = await plugin.execute(createDirectory(), createRequest(), createExisting());

			expect(result.success).toBe(true);
			expect(result.outputs.items.length).toBeGreaterThan(0);
			expect(result.stepsCompleted).toBeGreaterThan(0);
		});

		it('should return categories and tags from Make.com output', async () => {
			mockSuccessfulScenarioRun(fetchMock);

			const result = await plugin.execute(createDirectory(), createRequest(), createExisting());

			expect(result.success).toBe(true);
			expect(result.outputs.categories.length).toBeGreaterThan(0);
		});

		it('should deduplicate items against existing', async () => {
			mockSuccessfulScenarioRun(fetchMock);
			const existing = createExisting({
				items: [{ name: 'Test Item 1', description: 'Existing item' } as never]
			});

			const result = await plugin.execute(createDirectory(), createRequest(), existing);

			expect(result.success).toBe(true);
			const hasExisting = result.outputs.items.some((i) => i.name === 'Test Item 1');
			expect(hasExisting).toBe(false);
		});

		it('should execute via webhook mode when configured', async () => {
			fetchMock.mockResolvedValueOnce(
				mockResponse({ body: { users: [{ id: 1 }] } }) // whoAmI validation
			);
			fetchMock.mockResolvedValueOnce(
				mockResponse({
					body: {
						items: [
							{
								name: 'Webhook Item',
								description: 'Via webhook',
								url: 'https://example.com',
								category: 'Tools'
							}
						]
					}
				})
			);

			const result = await plugin.execute(
				createDirectory(),
				createRequest({
					config: {
						execution_mode: 'webhook',
						webhook_url: 'https://hook.us2.make.com/xyz',
						target_items: 10
					}
				}),
				createExisting()
			);

			expect(result.success).toBe(true);
			expect(result.outputs.items[0].name).toBe('Webhook Item');
		});

		it('should use inline outputs from a responsive scenario run without polling', async () => {
			// validate-make: scenario detail
			fetchMock.mockResolvedValueOnce(
				mockResponse({ body: { scenario: { id: 42, name: 'My Scenario', isActive: true } } })
			);
			// runScenario: responsive run returns the final module's body inline
			fetchMock.mockResolvedValueOnce(
				mockResponse({
					body: {
						executionId: 'exec-inline-1',
						outputs: {
							items: [
								{
									name: 'Inline Item',
									description: 'Returned inline from responsive run',
									url: 'https://example.com/inline',
									category: 'Tools'
								}
							]
						}
					}
				})
			);

			const result = await plugin.execute(createDirectory(), createRequest(), createExisting());

			expect(result.success).toBe(true);
			expect(result.outputs.items[0].name).toBe('Inline Item');
			// No third fetch for /executions/{id} — polling was skipped.
			expect(fetchMock).toHaveBeenCalledTimes(2);
		});

		it('should parse a string-encoded JSON body inside the inline run response', async () => {
			fetchMock.mockResolvedValueOnce(
				mockResponse({ body: { scenario: { id: 42, name: 'My Scenario', isActive: true } } })
			);
			// Some Make zones wrap the final body as a stringified JSON in `body`.
			fetchMock.mockResolvedValueOnce(
				mockResponse({
					body: {
						executionId: 'exec-inline-2',
						body: JSON.stringify({
							items: [
								{
									name: 'Stringified Inline Item',
									description: 'Inline string JSON',
									url: 'https://example.com/sj',
									category: 'Tools'
								}
							]
						})
					}
				})
			);

			const result = await plugin.execute(createDirectory(), createRequest(), createExisting());

			expect(result.success).toBe(true);
			expect(result.outputs.items[0].name).toBe('Stringified Inline Item');
			expect(fetchMock).toHaveBeenCalledTimes(2);
		});

		it('should invoke the hook URL in scenario mode when a hook ID is configured', async () => {
			// validate-make: scenario detail
			fetchMock.mockResolvedValueOnce(
				mockResponse({ body: { scenario: { id: 42, name: 'My Scenario', isActive: true } } })
			);
			// validate-make: pingHook (fire-and-forget, wrapped in try/catch)
			fetchMock.mockResolvedValueOnce(mockResponse({ body: {} }));
			// execute-scenario: getHook returns the webhook URL
			fetchMock.mockResolvedValueOnce(
				mockResponse({
					body: { hook: { id: 99, name: 'My Hook', url: 'https://hook.us2.make.com/abc' } }
				})
			);
			// execute-scenario: invokeWebhook returns the output
			fetchMock.mockResolvedValueOnce(
				mockResponse({
					body: {
						items: [
							{
								name: 'Hook-Routed Item',
								description: 'Fetched via the hook URL fallback',
								url: 'https://example.com/hook',
								category: 'Tools'
							}
						]
					}
				})
			);

			const result = await plugin.execute(
				createDirectory(),
				createRequest({
					config: {
						execution_mode: 'scenario',
						scenario_id: '42',
						hook_id: '99'
					}
				}),
				createExisting()
			);

			expect(result.success).toBe(true);
			expect(result.outputs.items[0].name).toBe('Hook-Routed Item');
			// REST /run and /executions/{id} must NOT be called on this path.
			const calledUrls = fetchMock.mock.calls.map((c) => String(c[0]));
			expect(calledUrls.some((u) => u.includes('/scenarios/42/run'))).toBe(false);
			expect(calledUrls.some((u) => u.includes('/executions/'))).toBe(false);
			expect(calledUrls.some((u) => u === 'https://hook.us2.make.com/abc')).toBe(true);
		});

		it('should fail scenario mode when the configured hook has no URL', async () => {
			fetchMock.mockResolvedValueOnce(
				mockResponse({ body: { scenario: { id: 42, name: 'My Scenario', isActive: true } } })
			);
			fetchMock.mockResolvedValueOnce(mockResponse({ body: {} }));
			fetchMock.mockResolvedValueOnce(
				mockResponse({ body: { hook: { id: 99, name: 'Broken Hook' } } })
			);

			const result = await plugin.execute(
				createDirectory(),
				createRequest({
					config: {
						execution_mode: 'scenario',
						scenario_id: '42',
						hook_id: '99'
					}
				}),
				createExisting()
			);

			expect(result.success).toBe(false);
			const errorMessage = result.error instanceof Error ? result.error.message : String(result.error);
			expect(errorMessage).toMatch(/does not expose a URL/i);
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
			mockSuccessfulScenarioRun(fetchMock);

			await plugin.execute(createDirectory(), createRequest(), createExisting());

			const state = plugin.getState();
			expect(state).toBeDefined();
			expect(state!.completedSteps.length).toBeGreaterThan(0);
		});

		it('should surface scenario validation errors', async () => {
			fetchMock.mockResolvedValueOnce(
				mockResponse({
					body: { scenario: { id: 42, name: 'Inactive', isActive: false } }
				})
			);

			const result = await plugin.execute(createDirectory(), createRequest(), createExisting());

			expect(result.success).toBe(false);
			const errorMessage = result.error instanceof Error ? result.error.message : String(result.error);
			expect(errorMessage).toMatch(/not active/);
		});
	});

	describe('validateConnection', () => {
		it('should succeed with valid API key (no default scenario)', async () => {
			fetchMock.mockResolvedValueOnce(mockResponse({ body: { user: { id: 1 } } }));

			await plugin.onLoad(createMockContext());
			const result = await plugin.validateConnection({ apiKey: 'valid-key' });

			expect(result.success).toBe(true);
			expect(result.message).toContain('Connected to Make.com');
		});

		it('should succeed and validate the default scenario when configured', async () => {
			fetchMock.mockResolvedValueOnce(
				mockResponse({
					body: { scenario: { id: 42, name: 'Default', isActive: true } }
				})
			);

			await plugin.onLoad(createMockContext());
			const result = await plugin.validateConnection({
				apiKey: 'valid-key',
				defaultScenarioId: '42'
			});

			expect(result.success).toBe(true);
			expect(result.message).toContain('42');
		});

		it('should fail without API key', async () => {
			await plugin.onLoad(createMockContext());
			const result = await plugin.validateConnection({});
			expect(result.success).toBe(false);
			expect(result.message).toContain('API key');
		});

		it('should report a friendly message when the API rejects the token', async () => {
			fetchMock.mockResolvedValueOnce(
				mockResponse({ status: 401, statusText: 'Unauthorized', body: { message: 'bad' } })
			);

			await plugin.onLoad(createMockContext());
			const result = await plugin.validateConnection({ apiKey: 'bad-key' });

			expect(result.success).toBe(false);
			expect(result.message).toContain('Invalid Make.com API key');
		});
	});

	describe('getManifest', () => {
		it('should return a valid manifest', () => {
			const manifest = plugin.getManifest();
			expect(manifest.id).toBe('make');
			expect(manifest.name).toBe('Make.com Workflows');
			expect(manifest.category).toBe('pipeline');
			expect(manifest.builtIn).toBe(true);
		});
	});
});
