import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ZapierPlugin } from '../zapier.plugin.js';
import type { DirectoryReference, GenerationRequest, ExistingItems, PluginContext } from '@ever-works/plugin';

const { mockGetAction, mockRunAction } = vi.hoisted(() => ({
	mockGetAction: vi.fn(),
	mockRunAction: vi.fn()
}));

vi.mock('@zapier/zapier-sdk', () => {
	class ZapierError extends Error {
		readonly code: string = 'ZAPIER_ERROR';
	}
	class ZapierAppNotFoundError extends ZapierError {
		readonly code = 'ZAPIER_APP_NOT_FOUND_ERROR';
		appKey?: string;
		constructor(message: string, options?: { appKey?: string }) {
			super(message);
			this.appKey = options?.appKey;
		}
	}
	class ZapierNotFoundError extends ZapierError {
		readonly code = 'ZAPIER_NOT_FOUND_ERROR';
	}
	class ZapierAuthenticationError extends ZapierError {
		readonly code = 'ZAPIER_AUTHENTICATION_ERROR';
	}
	class ZapierRateLimitError extends ZapierError {
		readonly code = 'ZAPIER_RATE_LIMIT_ERROR';
	}
	class ZapierTimeoutError extends ZapierError {
		readonly code = 'ZAPIER_TIMEOUT_ERROR';
	}
	class ZapierValidationError extends ZapierError {
		readonly code = 'ZAPIER_VALIDATION_ERROR';
	}
	class ZapierActionError extends ZapierError {
		readonly code = 'ZAPIER_ACTION_ERROR';
	}
	return {
		createZapierSdk: vi.fn().mockImplementation(() => ({
			getAction: mockGetAction,
			runAction: mockRunAction
		})),
		ZapierError,
		ZapierAppNotFoundError,
		ZapierNotFoundError,
		ZapierAuthenticationError,
		ZapierRateLimitError,
		ZapierTimeoutError,
		ZapierValidationError,
		ZapierActionError
	};
});

const { ZapierActionError } = await import('@zapier/zapier-sdk');

function createMockContext(settingsOverride?: Record<string, unknown>): PluginContext {
	const settings = settingsOverride ?? { accessToken: 'test-token' };
	return {
		pluginId: 'zapier',
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
		getSettings: vi.fn().mockResolvedValue(settings),
		getResolvedSettings: vi.fn().mockResolvedValue({ settings, source: 'user' }),
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
			app_key: 'slack',
			action_type: 'write',
			action_key: 'custom',
			authentication_id: 12345,
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

function errorMessage(error: Error | string | undefined): string {
	if (!error) return '';
	return typeof error === 'string' ? error : error.message;
}

function mockSuccessfulAction() {
	mockGetAction.mockResolvedValue({ data: { key: 'custom', label: 'Send Message' } });
	mockRunAction.mockResolvedValue({
		data: [
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
		]
	});
}

describe('ZapierPlugin', () => {
	let plugin: ZapierPlugin;

	beforeEach(() => {
		plugin = new ZapierPlugin();
		vi.clearAllMocks();
	});

	describe('metadata', () => {
		it('should have correct id and category', () => {
			expect(plugin.id).toBe('zapier');
			expect(plugin.category).toBe('pipeline');
		});

		it('should declare pipeline and form-schema-provider capabilities', () => {
			expect(plugin.capabilities).toContain('pipeline');
			expect(plugin.capabilities).toContain('form-schema-provider');
		});

		it('should require user configuration', () => {
			expect(plugin.configurationMode).toBe('user-required');
		});

		it('should accept either accessToken or clientId+clientSecret via anyOf', () => {
			const anyOf = plugin.settingsSchema.anyOf as Array<{ required: string[] }>;
			expect(anyOf).toBeDefined();
			const requirements = anyOf.map((entry) => entry.required);
			expect(requirements).toEqual(expect.arrayContaining([['accessToken'], ['clientId', 'clientSecret']]));
		});

		it('should mark accessToken and clientSecret as secret', () => {
			const props = plugin.settingsSchema.properties as Record<string, Record<string, unknown>>;
			expect(props.accessToken['x-secret']).toBe(true);
			expect(props.clientSecret['x-secret']).toBe(true);
			expect(props.clientId['x-secret']).toBeUndefined();
		});
	});

	describe('lifecycle', () => {
		it('should load successfully', async () => {
			const ctx = createMockContext();
			await plugin.onLoad(ctx);
			expect(ctx.logger.log).toHaveBeenCalledWith('Zapier Automation plugin loaded');
		});

		it('should unload cleanly', async () => {
			await plugin.onLoad(createMockContext());
			await expect(plugin.onUnload()).resolves.toBeUndefined();
		});

		it('should report healthy status', async () => {
			const health = await plugin.healthCheck();
			expect(health.status).toBe('healthy');
		});
	});

	describe('isAvailable', () => {
		it('should return true when an access token is provided', async () => {
			expect(await plugin.isAvailable({ accessToken: 'test-token' })).toBe(true);
		});

		it('should return true when client credentials are provided', async () => {
			expect(await plugin.isAvailable({ clientId: 'ckc_x', clientSecret: 'cks_x' })).toBe(true);
		});

		it('should return false without any auth', async () => {
			expect(await plugin.isAvailable({})).toBe(false);
			expect(await plugin.isAvailable({ accessToken: '' })).toBe(false);
			expect(await plugin.isAvailable({ clientId: 'ckc_x' })).toBe(false);
			expect(await plugin.isAvailable({ clientSecret: 'cks_x' })).toBe(false);
		});
	});

	describe('validateSettings', () => {
		it('should pass with a token', async () => {
			const result = await plugin.validateSettings({ accessToken: 'test-token' });
			expect(result.valid).toBe(true);
		});

		it('should pass with client credentials', async () => {
			const result = await plugin.validateSettings({ clientId: 'ckc_x', clientSecret: 'cks_x' });
			expect(result.valid).toBe(true);
		});

		it('should fail with neither auth method', async () => {
			const result = await plugin.validateSettings({});
			expect(result.valid).toBe(false);
		});

		it('should fail when clientId is set without clientSecret', async () => {
			const result = await plugin.validateSettings({ clientId: 'ckc_x' });
			expect(result.valid).toBe(false);
		});
	});

	describe('getStepDefinitions', () => {
		it('should return 6 steps', () => {
			expect(plugin.getStepDefinitions()).toHaveLength(6);
		});

		it('should have unique step IDs', () => {
			const ids = plugin.getStepDefinitions().map((s) => s.id);
			expect(new Set(ids).size).toBe(ids.length);
		});

		it('should begin with validate-zapier and end with cleanup', () => {
			const steps = plugin.getStepDefinitions();
			expect(steps[0].id).toBe('validate-zapier');
			expect(steps[steps.length - 1].id).toBe('cleanup');
		});
	});

	describe('getFormFields', () => {
		it('should include authentication_id as a text field (accepts UUID and numeric IDs)', () => {
			const field = plugin.getFormFields().find((f) => f.name === 'authentication_id');
			expect(field).toBeDefined();
			expect(field!.type).toBe('text');
		});

		it('should include result_shape with structured and native options', () => {
			const field = plugin.getFormFields().find((f) => f.name === 'result_shape');
			expect(field).toBeDefined();
			const values = (field!.options ?? []).map((o) => o.value);
			expect(values).toEqual(expect.arrayContaining(['structured', 'native']));
		});

		it('should include name_field conditional on native shape', () => {
			const field = plugin.getFormFields().find((f) => f.name === 'name_field');
			expect(field).toBeDefined();
			expect(field!.showIf).toEqual({ field: 'result_shape', operator: 'eq', value: 'native' });
		});
	});

	describe('validateFormInput', () => {
		it('should pass with minimal valid input', () => {
			const result = plugin.validateFormInput({ result_shape: 'structured' });
			expect(result.valid).toBe(true);
		});

		it('should require name_field when native shape is selected', () => {
			const result = plugin.validateFormInput({ result_shape: 'native' });
			expect(result.valid).toBe(false);
		});

		it('should pass native shape when name_field is provided', () => {
			const result = plugin.validateFormInput({ result_shape: 'native', name_field: 'title' });
			expect(result.valid).toBe(true);
		});

		it('should fail when repo access enabled without URL', () => {
			const result = plugin.validateFormInput({ pass_repo_access: true });
			expect(result.valid).toBe(false);
		});

		it('should fail when repo access enabled without token', () => {
			const result = plugin.validateFormInput({
				pass_repo_access: true,
				repo_url: 'https://github.com/org/repo'
			});
			expect(result.valid).toBe(false);
		});

		it('should pass when repo access is fully configured', () => {
			const result = plugin.validateFormInput({
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
			mockSuccessfulAction();
		});

		it('should fail without a user ID', async () => {
			const result = await plugin.execute(
				createDirectory({ user: undefined }),
				createRequest(),
				createExisting()
			);
			expect(result.success).toBe(false);
		});

		it('should fail when action_key is missing', async () => {
			const result = await plugin.execute(
				createDirectory(),
				createRequest({ config: { app_key: 'slack', action_type: 'write', authentication_id: 1 } }),
				createExisting()
			);
			expect(result.success).toBe(false);
			expect(errorMessage(result.error)).toMatch(/action_key/);
		});

		it('should fail when authentication_id is missing — never auto-resolves', async () => {
			const result = await plugin.execute(
				createDirectory(),
				createRequest({ config: { app_key: 'slack', action_type: 'write', action_key: 'custom' } }),
				createExisting()
			);
			expect(result.success).toBe(false);
			expect(errorMessage(result.error)).toMatch(/authentication_id/);
		});

		it('should execute a structured-shape action and return items', async () => {
			const result = await plugin.execute(createDirectory(), createRequest(), createExisting());

			expect(result.success).toBe(true);
			expect(result.outputs.items.length).toBeGreaterThan(0);
			expect(result.stepsCompleted).toBeGreaterThan(0);
		});

		it('should call runAction with the resolved action triple', async () => {
			await plugin.execute(createDirectory(), createRequest(), createExisting());

			expect(mockRunAction).toHaveBeenCalledWith(
				expect.objectContaining({
					app: 'slack',
					actionType: 'write',
					action: 'custom',
					connection: 12345,
					timeoutMs: 600_000
				})
			);
		});

		it('should deduplicate items against existing names', async () => {
			const existing = createExisting({
				items: [{ name: 'Test Item 1', description: 'Existing' } as never]
			});

			const result = await plugin.execute(createDirectory(), createRequest(), existing);

			expect(result.success).toBe(true);
			const names = result.outputs.items.map((i) => i.name);
			expect(names).not.toContain('Test Item 1');
		});

		it('should handle pre-aborted signals', async () => {
			const controller = new AbortController();
			controller.abort();

			const result = await plugin.execute(createDirectory(), createRequest(), createExisting(), {
				signal: controller.signal
			});

			expect(result.success).toBe(false);
		});

		it('should abort the action when the configured timeout elapses', async () => {
			vi.useFakeTimers();
			try {
				// runAction never resolves on its own — only the timeout can rescue this.
				mockRunAction.mockImplementation(
					() =>
						new Promise(() => {
							/* never */
						})
				);

				const result = plugin.execute(
					createDirectory(),
					createRequest({
						config: {
							app_key: 'slack',
							action_type: 'write',
							action_key: 'custom',
							authentication_id: 12345,
							action_timeout: 1 // 1 minute → 60_000 ms
						}
					}),
					createExisting()
				);

				// Advance past the 60_000 ms budget; the internal timer must fire and abort.
				await vi.advanceTimersByTimeAsync(61_000);

				const settled = await result;
				expect(settled.success).toBe(false);
			} finally {
				vi.useRealTimers();
			}
		});

		it('should expose state after execution', async () => {
			await plugin.execute(createDirectory(), createRequest(), createExisting());
			const state = plugin.getState();
			expect(state).toBeDefined();
			expect(state!.completedSteps.length).toBeGreaterThan(0);
		});

		it('should execute a native-shape action with field mapping', async () => {
			mockGetAction.mockResolvedValue({ data: { key: 'find_user' } });
			mockRunAction.mockResolvedValue({
				data: [
					{ title: 'Alice', link: 'https://alice.example', tags: 'admin, engineer' },
					{ title: 'Bob', link: 'https://bob.example', tags: ['designer'] }
				]
			});

			const result = await plugin.execute(
				createDirectory(),
				createRequest({
					config: {
						app_key: 'airtable',
						action_type: 'search',
						action_key: 'find_record',
						authentication_id: 999,
						result_shape: 'native',
						name_field: 'title',
						url_field: 'link',
						tags_field: 'tags',
						target_items: 50
					}
				}),
				createExisting()
			);

			expect(result.success).toBe(true);
			expect(result.outputs.items).toHaveLength(2);
			expect(result.outputs.items[0].name).toBe('Alice');
			expect(result.outputs.items[0].source_url).toBe('https://alice.example');
			expect(result.outputs.items[0].tags).toEqual(['admin', 'engineer']);
			expect(result.outputs.items[1].tags).toEqual(['designer']);
		});

		it('should surface Zapier action errors', async () => {
			mockGetAction.mockResolvedValue({ data: { key: 'custom' } });
			mockRunAction.mockRejectedValue(new ZapierActionError('Invalid channel'));

			const result = await plugin.execute(createDirectory(), createRequest(), createExisting());
			expect(result.success).toBe(false);
			expect(errorMessage(result.error)).toContain('Invalid channel');
		});
	});

	describe('validateConnection', () => {
		it('should succeed when the token is present and no default action is set', async () => {
			await plugin.onLoad(createMockContext());
			const result = await plugin.validateConnection({ accessToken: 'test-token' });
			expect(result.success).toBe(true);
		});

		it('should succeed with client credentials only', async () => {
			await plugin.onLoad(createMockContext());
			const result = await plugin.validateConnection({ clientId: 'ckc_x', clientSecret: 'cks_x' });
			expect(result.success).toBe(true);
		});

		it('should fail when no auth method is provided', async () => {
			await plugin.onLoad(createMockContext());
			const result = await plugin.validateConnection({});
			expect(result.success).toBe(false);
			expect(result.message).toMatch(/authentication/i);
		});

		it('should validate the default action when a full triple is provided', async () => {
			mockGetAction.mockResolvedValue({ data: { key: 'custom' } });
			await plugin.onLoad(createMockContext());

			const result = await plugin.validateConnection({
				accessToken: 'test-token',
				defaultAppKey: 'slack',
				defaultActionType: 'write',
				defaultActionKey: 'custom'
			});

			expect(result.success).toBe(true);
			expect(mockGetAction).toHaveBeenCalled();
		});

		it('should flatten wrapped settings values', async () => {
			mockGetAction.mockResolvedValue({ data: { key: 'custom' } });
			await plugin.onLoad(createMockContext());

			const result = await plugin.validateConnection({
				accessToken: { value: 'wrapped-token' },
				defaultAppKey: { value: 'slack' },
				defaultActionType: { value: 'write' },
				defaultActionKey: { value: 'custom' }
			});

			expect(result.success).toBe(true);
		});
	});

	describe('getManifest', () => {
		it('should return a valid manifest with pipeline category', () => {
			const manifest = plugin.getManifest();
			expect(manifest.id).toBe('zapier');
			expect(manifest.name).toBe('Zapier Automation');
			expect(manifest.category).toBe('pipeline');
			expect(manifest.builtIn).toBe(true);
		});

		it('should list screenshot as a selectable provider category', () => {
			const manifest = plugin.getManifest();
			expect(manifest.selectableProviderCategories).toContain('screenshot');
		});
	});
});
