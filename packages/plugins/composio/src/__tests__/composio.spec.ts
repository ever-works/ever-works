import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WorkReference, GenerationRequest, ExistingItems, PluginContext } from '@ever-works/plugin';

/**
 * Hoisted SDK mocks. Each is a freshly-created `vi.fn()` that the tests
 * configure via `mockResolvedValueOnce` / `mockRejectedValueOnce`. The mock
 * constructor returns an object that exposes these exact spies as
 * `toolkits.get`, `connectedAccounts.list`, `tools.execute` — matching the
 * `ComposioSdkLike` shape consumed by `ComposioClient`.
 */
const { mockToolkitsGet, mockConnectedAccountsList, mockToolsExecute } = vi.hoisted(() => ({
	mockToolkitsGet: vi.fn(),
	mockConnectedAccountsList: vi.fn(),
	mockToolsExecute: vi.fn()
}));

vi.mock('@composio/core', () => ({
	Composio: vi.fn().mockImplementation(function () {
		return {
			toolkits: { get: mockToolkitsGet },
			connectedAccounts: { list: mockConnectedAccountsList },
			tools: { execute: mockToolsExecute }
		};
	})
}));

// Import after vi.mock so the plugin's ComposioClient picks up the mocked SDK.
const { ComposioPlugin } = await import('../composio.plugin.js');

function createMockContext(settingsOverride?: Record<string, unknown>): PluginContext {
	const settings = settingsOverride ?? { apiKey: 'test-key' };
	return {
		pluginId: 'composio',
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

function createWork(overrides?: Partial<WorkReference>): WorkReference {
	return {
		id: 'dir-123',
		name: 'Test Work',
		slug: 'test-work',
		description: 'A test work',
		user: { id: 'user-456' },
		...overrides
	};
}

function createRequest(overrides?: Partial<GenerationRequest>): GenerationRequest {
	return {
		prompt: 'Find the best AI tools',
		generationMethod: 'create-update',
		config: {
			toolkit: 'GMAIL',
			tool_slug: 'GMAIL_LIST_MESSAGES',
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

const ACTIVE_GMAIL_ACCOUNTS = {
	items: [{ id: 'ca_active', status: 'ACTIVE', toolkit: { slug: 'GMAIL' } }]
};

/** Helper: stage the SDK with an active connection + a successful tool response. */
function stageHappyPath(toolData: unknown): void {
	mockConnectedAccountsList.mockResolvedValueOnce(ACTIVE_GMAIL_ACCOUNTS);
	mockToolsExecute.mockResolvedValueOnce({ successful: true, data: toolData });
}

function sdkError(status: number, message: string): Error {
	const err = new Error(message);
	(err as { status?: number }).status = status;
	return err;
}

describe('ComposioPlugin', () => {
	let plugin: InstanceType<typeof ComposioPlugin>;

	beforeEach(() => {
		plugin = new ComposioPlugin();
		vi.clearAllMocks();
	});

	describe('metadata', () => {
		it('has correct id and category', () => {
			expect(plugin.id).toBe('composio');
			expect(plugin.category).toBe('pipeline');
		});

		it('declares pipeline and form-schema-provider capabilities', () => {
			expect(plugin.capabilities).toContain('pipeline');
			expect(plugin.capabilities).toContain('form-schema-provider');
		});

		it('requires user configuration', () => {
			expect(plugin.configurationMode).toBe('user-required');
		});

		it('lists apiKey as required in the settings schema', () => {
			expect(plugin.settingsSchema.required).toEqual(['apiKey']);
		});

		it('marks apiKey as secret with the COMPOSIO_API_KEY env var fallback', () => {
			const props = plugin.settingsSchema.properties as Record<string, Record<string, unknown>>;
			expect(props.apiKey['x-secret']).toBe(true);
			expect(props.apiKey['x-envVar']).toBe('COMPOSIO_API_KEY');
		});

		it('does not put tool selection in plugin settings (per-run config only)', () => {
			const props = plugin.settingsSchema.properties as Record<string, Record<string, unknown>>;
			expect(props.toolkit).toBeUndefined();
			expect(props.tool_slug).toBeUndefined();
		});
	});

	describe('lifecycle', () => {
		it('loads successfully', async () => {
			const ctx = createMockContext();
			await plugin.onLoad(ctx);
			expect(ctx.logger.log).toHaveBeenCalledWith('Composio Integrations plugin loaded');
		});

		it('unloads cleanly', async () => {
			await plugin.onLoad(createMockContext());
			await expect(plugin.onUnload()).resolves.toBeUndefined();
		});

		it('reports healthy status', async () => {
			const health = await plugin.healthCheck();
			expect(health.status).toBe('healthy');
		});
	});

	describe('isAvailable', () => {
		it('returns true when an API key is provided', async () => {
			expect(await plugin.isAvailable({ apiKey: 'test-key' })).toBe(true);
		});

		it('returns false when API key is missing or empty', async () => {
			expect(await plugin.isAvailable({})).toBe(false);
			expect(await plugin.isAvailable({ apiKey: '' })).toBe(false);
			expect(await plugin.isAvailable({ apiKey: '   ' })).toBe(false);
		});
	});

	describe('validateSettings', () => {
		it('passes with an API key', async () => {
			const result = await plugin.validateSettings({ apiKey: 'test-key' });
			expect(result.valid).toBe(true);
		});

		it('fails without an API key', async () => {
			const result = await plugin.validateSettings({});
			expect(result.valid).toBe(false);
			expect(result.errors?.[0].path).toBe('apiKey');
		});
	});

	describe('getStepDefinitions', () => {
		it('returns 6 steps', () => {
			expect(plugin.getStepDefinitions()).toHaveLength(6);
		});

		it('starts with validate-composio and ends with cleanup', () => {
			const steps = plugin.getStepDefinitions();
			expect(steps[0].id).toBe('validate-composio');
			expect(steps[steps.length - 1].id).toBe('cleanup');
		});

		it('has unique step IDs', () => {
			const ids = plugin.getStepDefinitions().map((s) => s.id);
			expect(new Set(ids).size).toBe(ids.length);
		});
	});

	describe('getFormFields', () => {
		it('includes tool_slug + toolkit + composio_user_id', () => {
			const names = plugin.getFormFields().map((f) => f.name);
			expect(names).toContain('toolkit');
			expect(names).toContain('tool_slug');
			expect(names).toContain('composio_user_id');
		});

		it('includes result_shape with structured, native, side-effect options', () => {
			const field = plugin.getFormFields().find((f) => f.name === 'result_shape');
			expect(field).toBeDefined();
			const values = (field!.options ?? []).map((o) => o.value);
			expect(values).toEqual(expect.arrayContaining(['structured', 'native', 'side-effect']));
		});

		it('makes name_field conditional on native shape', () => {
			const field = plugin.getFormFields().find((f) => f.name === 'name_field');
			expect(field!.showIf).toEqual({ field: 'result_shape', operator: 'eq', value: 'native' });
		});
	});

	describe('validateFormInput', () => {
		it('passes with minimal valid input', () => {
			expect(plugin.validateFormInput({ result_shape: 'structured' }).valid).toBe(true);
		});

		it('requires name_field for native shape', () => {
			expect(plugin.validateFormInput({ result_shape: 'native' }).valid).toBe(false);
		});

		it('passes native shape when name_field is supplied', () => {
			expect(plugin.validateFormInput({ result_shape: 'native', name_field: 'title' }).valid).toBe(true);
		});

		it('fails when repo access is enabled without URL', () => {
			expect(plugin.validateFormInput({ pass_repo_access: true }).valid).toBe(false);
		});
	});

	describe('execute', () => {
		beforeEach(async () => {
			await plugin.onLoad(createMockContext());
		});

		it('fails without a user ID', async () => {
			const result = await plugin.execute(createWork({ user: undefined }), createRequest(), createExisting());
			expect(result.success).toBe(false);
		});

		it('fails when tool_slug is missing', async () => {
			const result = await plugin.execute(
				createWork(),
				createRequest({ config: { toolkit: 'GMAIL' } }),
				createExisting()
			);
			expect(result.success).toBe(false);
			expect(errorMessage(result.error)).toMatch(/tool_slug/);
		});

		it('fails when toolkit is missing', async () => {
			const result = await plugin.execute(
				createWork(),
				createRequest({ config: { tool_slug: 'GMAIL_SEND_EMAIL' } }),
				createExisting()
			);
			expect(result.success).toBe(false);
			expect(errorMessage(result.error)).toMatch(/toolkit/);
		});

		it('executes a structured-shape tool and returns items', async () => {
			stageHappyPath({ items: [{ name: 'A', url: 'https://a' }, { name: 'B' }] });

			const result = await plugin.execute(createWork(), createRequest(), createExisting());

			expect(result.success).toBe(true);
			expect(result.outputs.items).toHaveLength(2);
			expect(result.stepsCompleted).toBeGreaterThan(0);
		});

		it('calls sdk.tools.execute with the resolved userId and arguments', async () => {
			stageHappyPath({ items: [{ name: 'X' }] });

			await plugin.execute(createWork(), createRequest(), createExisting());

			expect(mockToolsExecute).toHaveBeenCalledWith(
				'GMAIL_LIST_MESSAGES',
				expect.objectContaining({
					userId: 'user-456', // defaults to ever works user id
					arguments: expect.objectContaining({
						metadata: expect.objectContaining({ workSlug: 'test-work' })
					})
				})
			);
		});

		it('honors composio_user_id override', async () => {
			stageHappyPath({ items: [{ name: 'X' }] });

			await plugin.execute(
				createWork(),
				createRequest({
					config: {
						toolkit: 'GMAIL',
						tool_slug: 'GMAIL_LIST_MESSAGES',
						composio_user_id: 'alice@example.com'
					}
				}),
				createExisting()
			);

			expect(mockToolsExecute).toHaveBeenCalledWith(
				'GMAIL_LIST_MESSAGES',
				expect.objectContaining({ userId: 'alice@example.com' })
			);
		});

		it('completes successfully for a side-effect tool with no items', async () => {
			stageHappyPath({ ok: true });

			const result = await plugin.execute(
				createWork(),
				createRequest({
					config: {
						toolkit: 'GMAIL',
						tool_slug: 'GMAIL_SEND_EMAIL',
						result_shape: 'side-effect',
						tool_params: { to: 'a@b.c', subject: 'hi', body: 'hello' }
					}
				}),
				createExisting()
			);

			expect(result.success).toBe(true);
			expect(result.outputs.items).toHaveLength(0);
		});

		it('deduplicates items against existing names', async () => {
			stageHappyPath({ items: [{ name: 'Alice' }, { name: 'Bob' }] });

			const result = await plugin.execute(
				createWork(),
				createRequest(),
				createExisting({ items: [{ name: 'Alice' } as never] })
			);

			expect(result.success).toBe(true);
			expect(result.outputs.items.map((i) => i.name)).toEqual(['Bob']);
		});

		it('returns failure when no ACTIVE connected account exists', async () => {
			mockConnectedAccountsList.mockResolvedValueOnce({
				items: [{ id: 'ca_x', status: 'EXPIRED', toolkit: { slug: 'GMAIL' } }]
			});

			const result = await plugin.execute(createWork(), createRequest(), createExisting());
			expect(result.success).toBe(false);
			expect(errorMessage(result.error)).toMatch(/no active.*connected account/i);
		});

		it('handles pre-aborted signals', async () => {
			const controller = new AbortController();
			controller.abort();

			const result = await plugin.execute(createWork(), createRequest(), createExisting(), {
				signal: controller.signal
			});

			expect(result.success).toBe(false);
		});

		it('surfaces Composio successful=false envelope as an error', async () => {
			mockConnectedAccountsList.mockResolvedValueOnce(ACTIVE_GMAIL_ACCOUNTS);
			mockToolsExecute.mockResolvedValueOnce({ successful: false, error: 'gmail quota exceeded' });

			const result = await plugin.execute(createWork(), createRequest(), createExisting());
			expect(result.success).toBe(false);
			expect(errorMessage(result.error)).toMatch(/gmail quota exceeded/i);
		});

		it('executes a native-shape tool with field mapping', async () => {
			stageHappyPath([
				{ subject: 'Alice', link: 'https://alice', labels: ['important'] },
				{ subject: 'Bob', link: 'https://bob' }
			]);

			const result = await plugin.execute(
				createWork(),
				createRequest({
					config: {
						toolkit: 'GMAIL',
						tool_slug: 'GMAIL_LIST_MESSAGES',
						result_shape: 'native',
						name_field: 'subject',
						url_field: 'link',
						tags_field: 'labels'
					}
				}),
				createExisting()
			);

			expect(result.success).toBe(true);
			expect(result.outputs.items).toHaveLength(2);
			expect(result.outputs.items[0].name).toBe('Alice');
			expect(result.outputs.items[0].tags).toEqual(['important']);
		});

		it('exposes pipeline state after execution', async () => {
			stageHappyPath({ items: [{ name: 'A' }] });

			await plugin.execute(createWork(), createRequest(), createExisting());
			const state = plugin.getState();
			expect(state).toBeDefined();
			expect(state!.completedSteps.length).toBeGreaterThan(0);
		});
	});

	describe('validateConnection', () => {
		beforeEach(async () => {
			await plugin.onLoad(createMockContext());
		});

		it('fails when API key is missing', async () => {
			const result = await plugin.validateConnection({});
			expect(result.success).toBe(false);
			expect(result.message).toMatch(/API key is not configured/i);
		});

		it('succeeds when API key is accepted (no default toolkit set)', async () => {
			mockToolkitsGet.mockResolvedValueOnce({ items: [{ slug: 'GMAIL', name: 'Gmail' }] });

			const result = await plugin.validateConnection({ apiKey: 'test-key' });
			expect(result.success).toBe(true);
			expect(result.message).toMatch(/Connected to Composio/i);
		});

		it('reports ACTIVE account for the default toolkit + user', async () => {
			mockToolkitsGet.mockResolvedValueOnce({ items: [{ slug: 'GMAIL' }] });
			mockConnectedAccountsList.mockResolvedValueOnce({ items: [{ id: 'ca_a', status: 'ACTIVE' }] });

			const result = await plugin.validateConnection({
				apiKey: 'test-key',
				defaultUserId: 'alice@example.com',
				defaultToolkit: 'GMAIL'
			});

			expect(result.success).toBe(true);
			expect(result.message).toMatch(/ACTIVE GMAIL connection/i);
		});

		it('flattens wrapped settings values', async () => {
			mockToolkitsGet.mockResolvedValueOnce({ items: [] });

			const result = await plugin.validateConnection({
				apiKey: { value: 'wrapped-key' }
			});

			expect(result.success).toBe(true);
		});

		it('reports underlying error when toolkit listing fails', async () => {
			mockToolkitsGet.mockRejectedValueOnce(sdkError(403, 'forbidden'));

			const result = await plugin.validateConnection({ apiKey: 'test-key' });
			expect(result.success).toBe(false);
			expect(result.message).toMatch(/HTTP 403|API key/i);
		});
	});

	describe('getManifest', () => {
		it('returns a valid manifest with pipeline category', () => {
			const manifest = plugin.getManifest();
			expect(manifest.id).toBe('composio');
			expect(manifest.name).toBe('Composio Integrations');
			expect(manifest.category).toBe('pipeline');
			expect(manifest.builtIn).toBe(true);
		});

		it('lists screenshot as a selectable provider category', () => {
			const manifest = plugin.getManifest();
			expect(manifest.selectableProviderCategories).toContain('screenshot');
		});
	});
});
