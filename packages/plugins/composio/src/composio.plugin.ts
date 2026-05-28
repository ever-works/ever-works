import type {
	IPlugin,
	IPipelinePlugin,
	IFormSchemaProvider,
	ISkillsProviderPlugin,
	PluginContext,
	PluginCategory,
	PluginSettings,
	JsonSchema,
	ValidationResult,
	ConnectionValidationResult,
	PipelineStepDefinition,
	PipelineState,
	PipelineExecutionOptions,
	PipelineProgressCallback,
	PipelineResult,
	WorkReference,
	GenerationRequest,
	ExistingItems,
	PluginManifest,
	PluginHealthCheck,
	SkillCatalogEntry,
	SkillCatalogListOptions,
	SkillCatalogListResult,
	SkillCatalogUpdate,
	StepStatus,
	FormFieldDefinition,
	FormFieldGroup,
	ItemData,
	FacadeOptions
} from '@ever-works/plugin';
import { buildSuccessPipelineResult } from '@ever-works/plugin';
import {
	buildSkillCatalogEntries,
	diffSkillCatalogVersions,
	filterSkillCatalog,
	readApiKey,
	readBaseUrl,
	readDefaultUserId
} from './skills-provider.js';

import type {
	ComposioStepId,
	ComposioSettings,
	ComposioPipelineMetrics,
	ComposioToolRef,
	ComposioResultShape,
	ComposioFieldMapping
} from './types.js';
import { COMPOSIO_STEP_IDS, DEFAULT_BASE_URL, DEFAULT_TIMEOUT_MS } from './types.js';
import { STEP_DEFINITIONS } from './steps.js';
import { ComposioClient, type ComposioExecutionResult } from './utils/composio-client.js';
import { buildToolPayload } from './utils/payload-builder.js';
import { parseComposioOutput, deduplicateItems, type ParsedResults } from './utils/result-parser.js';
import {
	initializeState,
	updateStepState,
	reportProgress,
	resolveSettings,
	buildMetrics,
	buildErrorResult,
	buildCancelledResult
} from './utils/pipeline-helpers.js';
import {
	getFormFields as formFields,
	getFormGroups as formGroups,
	validateFormInput as formValidate,
	getDefaultValues as formDefaults
} from './form-schema.js';
import { README } from './readme.js';

/**
 * Composio Integrations Plugin
 *
 * Pipeline plugin that executes a Composio tool during work generation.
 * Composio brokers OAuth across 500+ third-party apps; each user connects
 * their accounts once via Composio's hosted flow, and the platform runs
 * tools against `composio.user_id` (defaulted to the Ever Works user id).
 */
export class ComposioPlugin
	implements IPlugin, IPipelinePlugin, IFormSchemaProvider, ISkillsProviderPlugin
{
	readonly id = 'composio';
	readonly name = 'Composio Integrations';
	readonly version = '1.0.0';
	readonly category: PluginCategory = 'pipeline';
	readonly capabilities = ['pipeline', 'form-schema-provider', 'skills-provider'] as const;
	readonly configurationMode = 'user-required' as const;
	readonly handledConfigFields = ['*'] as const;
	readonly providerName = 'Composio Integrations';

	readonly settingsSchema: JsonSchema = {
		type: 'object',
		properties: {
			apiKey: {
				type: 'string',
				title: 'Composio API Key',
				description:
					'Your Composio API key. Generate one at https://app.composio.dev/settings/api-keys. Used as the `x-api-key` header on every Composio v3 call.',
				'x-secret': true,
				'x-envVar': 'COMPOSIO_API_KEY',
				'x-scope': 'user'
			},
			baseUrl: {
				type: 'string',
				title: 'Composio API Base URL',
				description: `Override the Composio API base URL. Leave empty to use the default (${DEFAULT_BASE_URL}).`,
				'x-scope': 'user'
			},
			defaultUserId: {
				type: 'string',
				title: 'Default Composio User ID',
				description:
					'Composio `user_id` to run tools against. Defaults to your Ever Works user id. Override if you connected the upstream app under a different identifier (typically an email).',
				'x-scope': 'user'
			},
			defaultToolkit: {
				type: 'string',
				title: 'Default Toolkit',
				description:
					'Default toolkit slug (e.g. GMAIL, GITHUB, SLACK). Used when no toolkit is set in the generator form.',
				'x-scope': 'user'
			},
			defaultToolSlug: {
				type: 'string',
				title: 'Default Tool Slug',
				description:
					'Default Composio tool slug (e.g. GMAIL_SEND_EMAIL, GITHUB_CREATE_ISSUE). Used when no tool is set in the generator form.',
				'x-scope': 'user'
			}
		},
		required: ['apiKey']
	};

	private context: PluginContext | null = null;

	// ── IPlugin lifecycle ──────────────────────────────────────────────

	async onLoad(context: PluginContext): Promise<void> {
		this.context = context;
		context.logger.log('Composio Integrations plugin loaded');
	}

	async onUnload(): Promise<void> {
		await this.cancel();
		this.context = null;
	}

	async healthCheck(): Promise<PluginHealthCheck> {
		return {
			status: 'healthy',
			message: 'Composio Integrations plugin is ready',
			checkedAt: Date.now()
		};
	}

	isAvailable(settings?: Record<string, unknown>): boolean {
		return hasApiKey(settings ?? {});
	}

	async validateSettings(settings: Record<string, unknown>): Promise<ValidationResult> {
		if (hasApiKey(settings)) {
			return { valid: true };
		}
		return {
			valid: false,
			errors: [
				{
					path: 'apiKey',
					message: 'Composio API key is required. Generate one at https://app.composio.dev/settings/api-keys.'
				}
			]
		};
	}

	async validateConnection(rawSettings: Record<string, unknown>): Promise<ConnectionValidationResult> {
		const settings = this.flattenSettings(rawSettings);
		if (!hasApiKey(settings)) {
			return {
				success: false,
				message: 'Composio API key is not configured.'
			};
		}

		try {
			const client = new ComposioClient({
				apiKey: settings.apiKey as string,
				baseUrl: (settings.baseUrl as string) || undefined,
				logger: this.context?.logger ?? console
			});

			// A toolkit list call is the cheapest way to confirm the API key is accepted
			// and the user has access to the Composio organization. We cap at 1 result.
			const toolkits = await client.listToolkits(1);

			const userId = trimOrUndefined(settings.defaultUserId);
			const toolkitSlug = trimOrUndefined(settings.defaultToolkit);
			if (userId && toolkitSlug) {
				const accounts = await client.listConnectedAccounts(userId, toolkitSlug);
				const active = accounts.find((a) => (a.status || '').toUpperCase() === 'ACTIVE');
				if (active) {
					return {
						success: true,
						message: `Connected to Composio. User "${userId}" has an ACTIVE ${toolkitSlug} connection.`
					};
				}
				return {
					success: true,
					message:
						`Connected to Composio (${toolkits.length} toolkit(s) visible), but no ACTIVE connected account ` +
						`for user "${userId}" on toolkit "${toolkitSlug}". Connect it in the Composio dashboard.`
				};
			}

			return {
				success: true,
				message: `Connected to Composio. ${toolkits.length} toolkit(s) visible. Set a default toolkit + user to verify a specific connection.`
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Connection validation failed';
			return { success: false, message };
		}
	}

	getManifest(): PluginManifest {
		return {
			id: this.id,
			name: this.name,
			version: this.version,
			description:
				'Pipeline plugin that executes Composio tools across 500+ third-party apps (Gmail, Slack, GitHub, Notion, …) during work generation. Composio brokers OAuth per user.',
			category: this.category,
			capabilities: [...this.capabilities],
			author: { name: 'Ever Works Team' },
			license: 'AGPL-3.0',
			builtIn: true,
			autoEnable: false,
			visibility: 'public',
			selectableProviderCategories: ['screenshot'],
			uiHints: {
				includeInOnboarding: true,
				onboardingPriority: 2,
				completionFields: ['apiKey'],
				onboardingDescription:
					'Connect Composio to call 500+ third-party app integrations (Gmail, Slack, GitHub, Notion, Linear, Salesforce, …) per user during work generation.'
			},
			readme: README,
			homepage: 'https://docs.composio.dev',
			icon: {
				type: 'url',
				value: 'https://composio.dev/favicon.ico'
			}
		};
	}

	// ── IFormSchemaProvider ─────────────────────────────────────────────

	getFormFields(): FormFieldDefinition[] {
		return formFields();
	}

	getFormGroups(): FormFieldGroup[] {
		return formGroups();
	}

	validateFormInput(values: Record<string, unknown>): ValidationResult {
		return formValidate(values);
	}

	getDefaultValues(): Record<string, unknown> {
		return formDefaults(this.getFormFields());
	}

	// ── ISkillsProviderPlugin ───────────────────────────────────────────
	//
	// Each ACTIVE Composio connected account the user owns surfaces as one
	// markdown skill entry under `composio-<toolkit>`. The agent reads the
	// entry's body during planning and learns to dispatch the toolkit via
	// the composio pipeline plugin. Connection state is read live (cached
	// per call) — there's no separate ingestion job.

	async listEntries(options: SkillCatalogListOptions): Promise<SkillCatalogListResult> {
		const entries = await this.loadEntries(options.settings);
		return filterSkillCatalog(entries, options);
	}

	async getEntry(slug: string, settings?: PluginSettings): Promise<SkillCatalogEntry | null> {
		const entries = await this.loadEntries(settings);
		return entries.find((e) => e.slug === slug) ?? null;
	}

	async checkForUpdates(
		installedVersions: Record<string, string>,
		settings?: PluginSettings
	): Promise<{ updated: SkillCatalogUpdate[] }> {
		const entries = await this.loadEntries(settings);
		return diffSkillCatalogVersions(entries, installedVersions);
	}

	private async loadEntries(settings?: PluginSettings): Promise<SkillCatalogEntry[]> {
		const apiKey = readApiKey(settings);
		const defaultUserId = readDefaultUserId(settings);
		if (!apiKey || !defaultUserId) return [];
		try {
			return await buildSkillCatalogEntries({
				apiKey,
				baseUrl: readBaseUrl(settings),
				defaultUserId,
				logger: this.context?.logger ?? console
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			(this.context?.logger ?? console).warn(
				`Composio skills-provider: failed to load catalog — ${message}`
			);
			return [];
		}
	}

	// ── IPipelinePlugin ─────────────────────────────────────────────────

	getStepDefinitions(): readonly PipelineStepDefinition[] {
		return STEP_DEFINITIONS;
	}

	private _lastState: PipelineState<ComposioStepId> | null = null;
	private _lastAbortController: AbortController | null = null;

	async execute(
		work: WorkReference,
		request: GenerationRequest,
		existing: ExistingItems,
		options?: PipelineExecutionOptions,
		onProgress?: PipelineProgressCallback
	): Promise<PipelineResult> {
		const startTime = Date.now();
		const abortController = new AbortController();
		if (options?.signal) {
			if (options.signal.aborted) {
				abortController.abort();
			} else {
				options.signal.addEventListener('abort', () => abortController.abort(), { once: true });
			}
		}
		const signal = abortController.signal;

		let state = initializeState();
		this._lastState = state;
		this._lastAbortController = abortController;

		const setState = (stepId: ComposioStepId, status: StepStatus, error?: string): void => {
			state = updateStepState(state, stepId, status, error);
			this._lastState = state;
		};

		const handleError = (error: Error): PipelineResult => {
			const { result, state: s } = buildErrorResult(state, error, startTime);
			state = s;
			this._lastState = state;
			return result;
		};

		const handleCancel = (): PipelineResult => {
			const { result, state: s } = buildCancelledResult(state, startTime);
			state = s;
			this._lastState = state;
			return result;
		};

		const logger = this.context?.logger ?? console;
		const userId = work.user?.id;

		if (!userId) {
			return handleError(new Error('User ID is required'));
		}

		let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

		try {
			const pluginSettings = await resolveSettings(this.context, userId, work.id);
			const config = (request.config || {}) as Record<string, unknown>;

			const composioSettings = this.resolveComposioSettings(pluginSettings, config);

			// Enforce the user-configured timeout — abort the pipeline if the tool exceeds the budget.
			timeoutHandle = setTimeout(() => {
				if (!signal.aborted) {
					logger.warn(`Composio tool timed out after ${composioSettings.timeoutMs}ms — aborting`);
					abortController.abort();
				}
			}, composioSettings.timeoutMs);
			const toolRef = this.resolveToolRef(config, composioSettings, userId);

			const missing = this.collectMissingToolFields(toolRef);
			if (missing.length > 0) {
				return handleError(
					new Error(
						`Composio tool is not fully configured. Missing: ${missing.join(', ')}. ` +
							'Provide the values in the generator form or in plugin settings.'
					)
				);
			}

			const client = new ComposioClient({
				apiKey: composioSettings.apiKey as string,
				baseUrl: composioSettings.baseUrl,
				logger
			});

			// ── Step 1: Validate Composio connection ──────────────────
			setState('validate-composio', 'running');
			reportProgress(onProgress, 0, 5, 'Validate Composio Connection');

			await client.validateConnection(toolRef);
			setState('validate-composio', 'completed');

			if (signal.aborted) return handleCancel();

			// ── Step 2: Prepare payload ───────────────────────────────
			setState('prepare-payload', 'running');
			reportProgress(onProgress, 1, 10, 'Prepare Tool Payload');

			const payload = buildToolPayload({ work, request, existing, config });

			logger.log(
				`Payload prepared: ${payload.metadata.targetItems} target items, ` +
					`${payload.existingSummary?.totalItems ?? 0} existing items, ` +
					`dataSource=${payload.dataSource?.type ?? 'none'}`
			);
			setState('prepare-payload', 'completed');

			if (signal.aborted) return handleCancel();

			// ── Step 3: Execute Composio tool ─────────────────────────
			setState('execute-tool', 'running');
			reportProgress(
				onProgress,
				2,
				15,
				'Execute Composio Tool',
				`Starting tool "${toolRef.toolSlug}" for user "${toolRef.userId}"...`
			);

			// Timeout enforcement happens at the pipeline level via the `setTimeout`
			// above that fires `abortController.abort()` — the SDK doesn't accept
			// a timeout parameter, so we only forward the signal here.
			const execResult: ComposioExecutionResult = await client.executeTool(
				toolRef,
				payload as unknown as Record<string, unknown>,
				{ signal }
			);

			reportProgress(onProgress, 2, 70, 'Execute Composio Tool', 'Tool completed.');

			logger.log(`Composio tool completed. Duration: ${execResult.composioDuration}ms`);
			setState('execute-tool', 'completed');

			if (signal.aborted) return handleCancel();

			// ── Step 4: Collect & validate results ────────────────────
			setState('collect-results', 'running');
			reportProgress(onProgress, 3, 75, 'Collect & Validate Results');

			let parsed: ParsedResults;
			let items: ItemData[];

			if (composioSettings.resultShape === 'side-effect') {
				// Fire-and-forget tool (send email, post message, create task, …).
				// The tool executed successfully but produces no work items — treat as success with 0 items.
				logger.log(`Side-effect tool completed — no items parsed. Response: ${safeStringify(execResult.data)}`);
				parsed = { items: [], categories: [], tags: [], brands: [] };
				items = [];
			} else {
				parsed = parseComposioOutput(
					execResult.data,
					composioSettings.resultShape,
					composioSettings.fieldMapping
				);
				const existingNames = existing.items.map((i) => i.name);
				items = deduplicateItems(parsed.items, existingNames);
				logger.log(
					`Collected ${parsed.items.length} items from Composio, ` +
						`${parsed.items.length - items.length} duplicates removed, ` +
						`${items.length} new items`
				);
			}
			setState('collect-results', 'completed');

			// ── Step 5: Capture screenshots ───────────────────────────
			const screenshotWarnings = await this.captureScreenshots(
				setState,
				request,
				options?.execContext,
				items,
				{ userId, workId: work.id },
				signal,
				onProgress,
				logger
			);

			// ── Step 6: Cleanup ───────────────────────────────────────
			setState('cleanup', 'running');
			reportProgress(onProgress, 5, 95, 'Cleanup');
			setState('cleanup', 'completed');

			// ── Build result ──────────────────────────────────────────
			reportProgress(onProgress, 6, 100, 'Complete');

			const duration = Date.now() - startTime;
			const composioMetrics: ComposioPipelineMetrics = {
				toolkit: toolRef.toolkit,
				toolSlug: toolRef.toolSlug,
				userId: toolRef.userId,
				resultShape: composioSettings.resultShape,
				composioDuration: execResult.composioDuration,
				itemsReturned: parsed.items.length
			};

			return buildSuccessPipelineResult(
				{
					items,
					categories: parsed.categories,
					tags: parsed.tags,
					brands: parsed.brands,
					collections: []
				},
				{
					metrics: buildMetrics(startTime, duration, items.length, composioMetrics),
					duration,
					stepsCompleted: state.completedSteps.length,
					totalSteps: COMPOSIO_STEP_IDS.length,
					state,
					warnings: screenshotWarnings.length > 0 ? screenshotWarnings : undefined
				}
			);
		} catch (error) {
			const err = error instanceof Error ? error : new Error(String(error));
			logger.error(`Composio pipeline failed: ${err.message}`);
			return handleError(err);
		} finally {
			if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
		}
	}

	async cancel(): Promise<void> {
		this._lastAbortController?.abort();
	}

	getState(): PipelineState<ComposioStepId> | null {
		return this._lastState;
	}

	// ── Private helpers ────────────────────────────────────────────────

	private resolveComposioSettings(
		pluginSettings: Record<string, unknown>,
		config: Record<string, unknown>
	): ComposioSettings {
		const apiKey = trimOrUndefined(pluginSettings.apiKey);

		if (!apiKey) {
			throw new Error('Composio API key is not configured. Add it in plugin settings.');
		}

		const timeoutMinutes = (config.tool_timeout as number) || 10;
		const resultShape = ((config.result_shape as string) || 'structured') as ComposioResultShape;

		const fieldMapping: ComposioFieldMapping = {
			nameField: (config.name_field as string) || 'name',
			urlField: trimOrUndefined(config.url_field),
			descriptionField: trimOrUndefined(config.description_field),
			categoryField: trimOrUndefined(config.category_field),
			tagsField: trimOrUndefined(config.tags_field),
			imageField: trimOrUndefined(config.image_field),
			brandField: trimOrUndefined(config.brand_field),
			contentField: trimOrUndefined(config.content_field)
		};

		// Math.max(60_000, …) is always ≥ 60_000 — handles NaN/0 from the config
		// field. No need for a separate DEFAULT_TIMEOUT_MS fallback after it.
		const timeoutCandidate = timeoutMinutes * 60 * 1000;
		const timeoutMs = Number.isFinite(timeoutCandidate) ? Math.max(60_000, timeoutCandidate) : DEFAULT_TIMEOUT_MS;

		return {
			apiKey,
			baseUrl: trimOrUndefined(pluginSettings.baseUrl),
			defaultUserId: trimOrUndefined(pluginSettings.defaultUserId),
			defaultToolkit: trimOrUndefined(pluginSettings.defaultToolkit),
			defaultToolSlug: trimOrUndefined(pluginSettings.defaultToolSlug),
			timeoutMs,
			resultShape,
			fieldMapping
		};
	}

	private resolveToolRef(
		config: Record<string, unknown>,
		settings: ComposioSettings,
		fallbackUserId: string
	): ComposioToolRef {
		const toolkit = (trimOrUndefined(config.toolkit) || settings.defaultToolkit || '').trim().toUpperCase();
		const toolSlug = (trimOrUndefined(config.tool_slug) || settings.defaultToolSlug || '').trim().toUpperCase();
		const userId = trimOrUndefined(config.composio_user_id) || settings.defaultUserId || fallbackUserId;

		return { toolkit, toolSlug, userId };
	}

	private collectMissingToolFields(ref: ComposioToolRef): string[] {
		const missing: string[] = [];
		if (!ref.toolkit) missing.push('toolkit');
		if (!ref.toolSlug) missing.push('tool_slug');
		if (!ref.userId) missing.push('composio_user_id');
		return missing;
	}

	private async captureScreenshots(
		setState: (stepId: ComposioStepId, status: StepStatus, error?: string) => void,
		request: GenerationRequest,
		execContext: PipelineExecutionOptions['execContext'],
		items: ItemData[],
		facadeOptions: FacadeOptions,
		signal: AbortSignal,
		onProgress: PipelineProgressCallback | undefined,
		logger: { log(...args: unknown[]): void; warn(...args: unknown[]): void }
	): Promise<string[]> {
		const shouldCapture = (request.config || {}).capture_screenshots === true;
		const screenshotFacade = execContext?.screenshotFacade;

		if (!shouldCapture || items.length === 0 || signal.aborted || !screenshotFacade) {
			setState('capture-screenshots', 'skipped' as StepStatus);
			return [];
		}

		if (!screenshotFacade.isAvailable()) {
			setState('capture-screenshots', 'skipped' as StepStatus);
			return ['Screenshot provider is not configured. Enable a screenshot plugin to capture item images.'];
		}

		setState('capture-screenshots', 'running');
		reportProgress(onProgress, 4, 80, 'Capture Screenshots');

		const errors: string[] = [];
		const itemsNeedingImages = items.filter(
			(item) => item.source_url && (!item.images || item.images.length === 0)
		);

		for (const item of itemsNeedingImages) {
			if (signal.aborted) break;

			try {
				const result = await screenshotFacade.getSmartImage(
					{ url: item.source_url, itemName: item.name },
					facadeOptions
				);

				if (result.primaryImage) {
					(item as { images?: string[] }).images = [result.primaryImage, ...(item.images || [])];
				}
			} catch (error) {
				const reason = error instanceof Error ? error.message : 'Unknown error';
				logger.warn(`Failed to capture image for ${item.name}: ${reason}`);
				errors.push(reason);
			}
		}

		setState(
			'capture-screenshots',
			errors.length > 0 && errors.length === itemsNeedingImages.length ? 'failed' : 'completed'
		);

		if (errors.length > 0) {
			const providerName = await screenshotFacade.getActiveProviderName?.(facadeOptions);
			const label = providerName ? `Screenshot capture (${providerName})` : 'Screenshot capture';
			const unique = [...new Set(errors)];
			return [`${label} failed for ${errors.length} item(s): ${unique.join('; ')}`];
		}
		return [];
	}

	private flattenSettings(settings: Record<string, unknown>): Record<string, unknown> {
		const flat: Record<string, unknown> = {};
		for (const [key, entry] of Object.entries(settings)) {
			if (entry && typeof entry === 'object' && 'value' in entry) {
				flat[key] = (entry as { value: unknown }).value;
			} else {
				flat[key] = entry;
			}
		}
		return flat;
	}
}

function trimOrUndefined(value: unknown): string | undefined {
	if (typeof value !== 'string') return undefined;
	const trimmed = value.trim();
	return trimmed === '' ? undefined : trimmed;
}

function safeStringify(value: unknown, maxLength = 500): string {
	try {
		const s = JSON.stringify(value);
		return s.length > maxLength ? `${s.slice(0, maxLength)}…` : s;
	} catch {
		return String(value);
	}
}

function hasApiKey(settings: Record<string, unknown>): boolean {
	return !!trimOrUndefined(settings.apiKey);
}

export default ComposioPlugin;
