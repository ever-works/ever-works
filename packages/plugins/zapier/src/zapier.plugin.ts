import type {
	IPlugin,
	IPipelinePlugin,
	IFormSchemaProvider,
	PluginContext,
	PluginCategory,
	JsonSchema,
	ValidationResult,
	ConnectionValidationResult,
	PipelineStepDefinition,
	PipelineState,
	PipelineExecutionOptions,
	PipelineProgressCallback,
	PipelineResult,
	DirectoryReference,
	GenerationRequest,
	ExistingItems,
	PluginManifest,
	PluginHealthCheck,
	StepStatus,
	FormFieldDefinition,
	FormFieldGroup,
	ItemData,
	FacadeOptions
} from '@ever-works/plugin';
import { buildSuccessPipelineResult } from '@ever-works/plugin';

import type {
	ZapierStepId,
	ZapierSettings,
	ZapierPipelineMetrics,
	ZapierActionRef,
	ZapierActionType,
	ZapierResultShape,
	ZapierFieldMapping
} from './types.js';
import { ZAPIER_STEP_IDS, DEFAULT_BASE_URL, ZAPIER_ACTION_TYPES, DEFAULT_TIMEOUT_MS } from './types.js';
import { STEP_DEFINITIONS } from './steps.js';
import { ZapierClient, type ZapierExecutionResult } from './utils/zapier-client.js';
import { buildWorkflowPayload } from './utils/payload-builder.js';
import { parseZapierOutput, deduplicateItems } from './utils/result-parser.js';
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
 * Zapier Automation Plugin
 *
 * Pipeline plugin that triggers a Zapier action during directory generation.
 * Supports two result shapes: a structured `{ items: [...] }` contract for
 * custom Zaps, and a native-record mode where raw Zapier action output is
 * projected onto directory items via a field mapping.
 */
export class ZapierPlugin implements IPlugin, IPipelinePlugin, IFormSchemaProvider {
	readonly id = 'zapier';
	readonly name = 'Zapier Automation';
	readonly version = '1.0.0';
	readonly category: PluginCategory = 'pipeline';
	readonly capabilities = ['pipeline', 'form-schema-provider'] as const;
	readonly configurationMode = 'user-required' as const;
	readonly handledConfigFields = ['*'] as const;

	readonly settingsSchema: JsonSchema = {
		type: 'object',
		properties: {
			clientId: {
				type: 'string',
				title: 'Zapier Client ID',
				description:
					'Long-lived client ID produced by `npx zapier-sdk create-client-credentials`. Recommended for production and CI. Pair with Client Secret.',
				'x-scope': 'user',
				'x-envVar': 'ZAPIER_CREDENTIALS_CLIENT_ID'
			},
			clientSecret: {
				type: 'string',
				title: 'Zapier Client Secret',
				description:
					'Long-lived client secret produced by `npx zapier-sdk create-client-credentials`. Shown only once — store as an env-var secret.',
				'x-secret': true,
				'x-scope': 'user',
				'x-envVar': 'ZAPIER_CREDENTIALS_CLIENT_SECRET'
			},
			accessToken: {
				type: 'string',
				title: 'Zapier Access Token',
				description:
					'Short-lived bearer token from `npx zapier-sdk login`. Use for local development only — prefer Client ID / Secret in production.',
				'x-secret': true,
				'x-scope': 'user',
				'x-envVar': 'ZAPIER_ACCESS_TOKEN'
			},
			baseUrl: {
				type: 'string',
				title: 'Zapier API Base URL',
				description: 'Override the Zapier SDK base URL (leave empty for default).',
				default: DEFAULT_BASE_URL,
				'x-scope': 'user'
			},
			defaultAppKey: {
				type: 'string',
				title: 'Default App Key',
				description: 'Default Zapier app slug (e.g. slack, google_sheets).',
				'x-scope': 'user'
			},
			defaultActionType: {
				type: 'string',
				title: 'Default Action Type',
				description: 'One of search, filter, read, read_bulk, run, search_and_write, search_or_write, write.',
				enum: [...ZAPIER_ACTION_TYPES],
				'x-scope': 'user'
			},
			defaultActionKey: {
				type: 'string',
				title: 'Default Action Key',
				description: 'Default action slug within the app (e.g. send_message).',
				'x-scope': 'user'
			},
			defaultAuthenticationId: {
				type: 'number',
				title: 'Default Authentication ID',
				description: 'Numeric Zapier authentication (connection) ID to use when not overridden in the form.',
				'x-scope': 'user'
			}
		},
		anyOf: [{ required: ['accessToken'] }, { required: ['clientId', 'clientSecret'] }]
	};

	private context: PluginContext | null = null;

	// ── IPlugin lifecycle ──────────────────────────────────────────────

	async onLoad(context: PluginContext): Promise<void> {
		this.context = context;
		context.logger.log('Zapier Automation plugin loaded');
	}

	async onUnload(): Promise<void> {
		await this.cancel();
		this.context = null;
	}

	async healthCheck(): Promise<PluginHealthCheck> {
		return {
			status: 'healthy',
			message: 'Zapier Automation plugin is ready',
			checkedAt: Date.now()
		};
	}

	async isAvailable(settings?: Record<string, unknown>): Promise<boolean> {
		return hasAnyAuth(settings ?? {});
	}

	async validateSettings(settings: Record<string, unknown>): Promise<ValidationResult> {
		if (hasClientCredentials(settings) || hasAccessToken(settings)) {
			return { valid: true };
		}
		return {
			valid: false,
			errors: [
				{
					path: 'clientId',
					message:
						'Either Zapier Client ID + Client Secret (production) or Access Token (local dev) is required.'
				}
			]
		};
	}

	async validateConnection(rawSettings: Record<string, unknown>): Promise<ConnectionValidationResult> {
		const settings = this.flattenSettings(rawSettings);
		if (!hasAnyAuth(settings)) {
			return {
				success: false,
				message:
					'Zapier authentication is not configured. Provide either Client ID + Client Secret or an Access Token.'
			};
		}

		try {
			const client = new ZapierClient({
				accessToken: trimOrUndefined(settings.accessToken),
				credentials: readCredentials(settings),
				baseUrl: (settings.baseUrl as string) || undefined,
				logger: this.context?.logger ?? console
			});

			const appKey = settings.defaultAppKey as string | undefined;
			const actionType = settings.defaultActionType as ZapierActionType | undefined;
			const actionKey = settings.defaultActionKey as string | undefined;
			const authenticationId = normalizeAuthId(settings.defaultAuthenticationId);

			if (appKey && actionType && actionKey) {
				await client.validateAction({
					appKey,
					actionType,
					actionKey,
					// validateAction ignores authenticationId but the type requires it
					authenticationId: authenticationId ?? 0
				});
				return {
					success: true,
					message: `Connected to Zapier. Action "${appKey}.${actionType}.${actionKey}" is reachable.`
				};
			}

			return {
				success: true,
				message: 'Connected to Zapier successfully. Set a default action to verify action access.'
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
			description: 'Pipeline plugin that triggers Zapier actions during directory generation',
			category: this.category,
			capabilities: [...this.capabilities],
			author: { name: 'Ever Works Team' },
			license: 'MIT',
			builtIn: true,
			autoEnable: false,
			visibility: 'public',
			selectableProviderCategories: ['screenshot'],
			uiHints: {
				includeInOnboarding: true,
				onboardingPriority: 2,
				completionFields: ['clientId', 'clientSecret'],
				onboardingDescription:
					'Connect Zapier to trigger actions across 9,000+ apps during directory generation.'
			},
			readme: README,
			homepage: 'https://docs.zapier.com/sdk',
			icon: {
				type: 'url',
				value: 'https://zapier.com/favicon.ico'
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

	// ── IPipelinePlugin ─────────────────────────────────────────────────

	getStepDefinitions(): readonly PipelineStepDefinition[] {
		return STEP_DEFINITIONS;
	}

	private _lastState: PipelineState<ZapierStepId> | null = null;
	private _lastAbortController: AbortController | null = null;

	async execute(
		directory: DirectoryReference,
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

		const setState = (stepId: ZapierStepId, status: StepStatus, error?: string): void => {
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
		const userId = directory.user?.id;

		if (!userId) {
			return handleError(new Error('User ID is required'));
		}

		try {
			const pluginSettings = await resolveSettings(this.context, userId, directory.id);
			const config = (request.config || {}) as Record<string, unknown>;

			const zapierSettings = this.resolveZapierSettings(pluginSettings, config);
			const actionRef = this.resolveActionRef(config, zapierSettings);

			const missing = this.collectMissingActionFields(actionRef);
			if (missing.length > 0) {
				return handleError(
					new Error(
						`Zapier action is not fully configured. Missing: ${missing.join(', ')}. ` +
							'Provide the values in the generator form or in plugin settings.'
					)
				);
			}

			const client = new ZapierClient({
				accessToken: zapierSettings.accessToken,
				credentials:
					zapierSettings.clientId && zapierSettings.clientSecret
						? { clientId: zapierSettings.clientId, clientSecret: zapierSettings.clientSecret }
						: undefined,
				baseUrl: zapierSettings.baseUrl,
				logger
			});

			// ── Step 1: Validate Zapier connection ────────────────────
			setState('validate-zapier', 'running');
			reportProgress(onProgress, 0, 5, 'Validate Zapier Connection');

			await client.validateAction(actionRef);
			setState('validate-zapier', 'completed');

			if (signal.aborted) return handleCancel();

			// ── Step 2: Prepare payload ───────────────────────────────
			setState('prepare-payload', 'running');
			reportProgress(onProgress, 1, 10, 'Prepare Action Payload');

			const payload = buildWorkflowPayload({ directory, request, existing, config });

			logger.log(
				`Payload prepared: ${payload.metadata.targetItems} target items, ` +
					`${payload.existingSummary?.totalItems ?? 0} existing items, ` +
					`dataSource=${payload.dataSource?.type ?? 'none'}`
			);
			setState('prepare-payload', 'completed');

			if (signal.aborted) return handleCancel();

			// ── Step 3: Execute Zapier action ─────────────────────────
			setState('execute-action', 'running');
			reportProgress(
				onProgress,
				2,
				15,
				'Execute Zapier Action',
				`Starting action "${actionRef.appKey}.${actionRef.actionType}.${actionRef.actionKey}"...`
			);

			const execResult: ZapierExecutionResult = await client.executeAction(
				actionRef,
				payload as unknown as Record<string, unknown>,
				signal
			);

			reportProgress(onProgress, 2, 70, 'Execute Zapier Action', 'Action completed.');

			logger.log(`Zapier action completed. Duration: ${execResult.zapierDuration}ms`);
			setState('execute-action', 'completed');

			if (signal.aborted) return handleCancel();

			// ── Step 4: Collect & validate results ────────────────────
			setState('collect-results', 'running');
			reportProgress(onProgress, 3, 75, 'Collect & Validate Results');

			const parsed = parseZapierOutput(execResult.data, zapierSettings.resultShape, zapierSettings.fieldMapping);

			const existingNames = existing.items.map((i) => i.name);
			const items = deduplicateItems(parsed.items, existingNames);

			logger.log(
				`Collected ${parsed.items.length} items from Zapier, ` +
					`${parsed.items.length - items.length} duplicates removed, ` +
					`${items.length} new items`
			);
			setState('collect-results', 'completed');

			// ── Step 5: Capture screenshots ───────────────────────────
			const screenshotWarnings = await this.captureScreenshots(
				setState,
				request,
				options?.execContext,
				items,
				{ userId, directoryId: directory.id },
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
			const zapierMetrics: ZapierPipelineMetrics = {
				appKey: actionRef.appKey,
				actionType: actionRef.actionType,
				actionKey: actionRef.actionKey,
				authenticationId: actionRef.authenticationId,
				resultShape: zapierSettings.resultShape,
				zapierDuration: execResult.zapierDuration,
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
					metrics: buildMetrics(startTime, duration, items.length, zapierMetrics),
					duration,
					stepsCompleted: state.completedSteps.length,
					totalSteps: ZAPIER_STEP_IDS.length,
					state,
					warnings: screenshotWarnings.length > 0 ? screenshotWarnings : undefined
				}
			);
		} catch (error) {
			const err = error instanceof Error ? error : new Error(String(error));
			logger.error(`Zapier pipeline failed: ${err.message}`);
			return handleError(err);
		}
	}

	async cancel(): Promise<void> {
		this._lastAbortController?.abort();
	}

	getState(): PipelineState<ZapierStepId> | null {
		return this._lastState;
	}

	// ── Private helpers ────────────────────────────────────────────────

	private resolveZapierSettings(
		pluginSettings: Record<string, unknown>,
		config: Record<string, unknown>
	): ZapierSettings {
		const accessToken = trimOrUndefined(pluginSettings.accessToken);
		const clientId = trimOrUndefined(pluginSettings.clientId);
		const clientSecret = trimOrUndefined(pluginSettings.clientSecret);

		if (!accessToken && !(clientId && clientSecret)) {
			throw new Error(
				'Zapier authentication is not configured. Provide either clientId + clientSecret (production) or accessToken (local dev) in plugin settings.'
			);
		}

		const timeoutMinutes = (config.action_timeout as number) || 10;
		const resultShape = ((config.result_shape as string) || 'structured') as ZapierResultShape;

		const fieldMapping: ZapierFieldMapping = {
			nameField: (config.name_field as string) || 'name',
			urlField: trimOrUndefined(config.url_field),
			descriptionField: trimOrUndefined(config.description_field),
			categoryField: trimOrUndefined(config.category_field),
			tagsField: trimOrUndefined(config.tags_field),
			imageField: trimOrUndefined(config.image_field),
			brandField: trimOrUndefined(config.brand_field),
			contentField: trimOrUndefined(config.content_field)
		};

		return {
			accessToken,
			clientId,
			clientSecret,
			baseUrl: trimOrUndefined(pluginSettings.baseUrl),
			defaultAppKey: trimOrUndefined(pluginSettings.defaultAppKey),
			defaultActionType: (pluginSettings.defaultActionType as ZapierActionType) || undefined,
			defaultActionKey: trimOrUndefined(pluginSettings.defaultActionKey),
			defaultAuthenticationId: normalizeAuthId(pluginSettings.defaultAuthenticationId),
			timeoutMs: Math.max(60_000, timeoutMinutes * 60 * 1000) || DEFAULT_TIMEOUT_MS,
			resultShape,
			fieldMapping
		};
	}

	private resolveActionRef(config: Record<string, unknown>, settings: ZapierSettings): ZapierActionRef {
		const appKey = (trimOrUndefined(config.app_key) || settings.defaultAppKey || '').trim();
		const actionType = ((config.action_type as ZapierActionType) || settings.defaultActionType) as ZapierActionType;
		const actionKey = (trimOrUndefined(config.action_key) || settings.defaultActionKey || '').trim();
		const authenticationId =
			normalizeAuthId(config.authentication_id) ?? settings.defaultAuthenticationId ?? Number.NaN;

		return {
			appKey,
			actionType,
			actionKey,
			authenticationId
		};
	}

	private collectMissingActionFields(ref: ZapierActionRef): string[] {
		const missing: string[] = [];
		if (!ref.appKey) missing.push('app_key');
		if (!ref.actionType) missing.push('action_type');
		if (!ref.actionKey) missing.push('action_key');
		if (!Number.isFinite(ref.authenticationId) || ref.authenticationId <= 0) {
			missing.push('authentication_id');
		}
		return missing;
	}

	private async captureScreenshots(
		setState: (stepId: ZapierStepId, status: StepStatus, error?: string) => void,
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

function normalizeAuthId(value: unknown): number | undefined {
	if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
	if (typeof value === 'string' && value.trim() !== '') {
		const parsed = Number(value);
		if (Number.isFinite(parsed) && parsed > 0) return parsed;
	}
	return undefined;
}

function hasAccessToken(settings: Record<string, unknown>): boolean {
	return !!trimOrUndefined(settings.accessToken);
}

function hasClientCredentials(settings: Record<string, unknown>): boolean {
	return !!trimOrUndefined(settings.clientId) && !!trimOrUndefined(settings.clientSecret);
}

function hasAnyAuth(settings: Record<string, unknown>): boolean {
	return hasAccessToken(settings) || hasClientCredentials(settings);
}

function readCredentials(settings: Record<string, unknown>): { clientId: string; clientSecret: string } | undefined {
	const clientId = trimOrUndefined(settings.clientId);
	const clientSecret = trimOrUndefined(settings.clientSecret);
	return clientId && clientSecret ? { clientId, clientSecret } : undefined;
}

export default ZapierPlugin;
