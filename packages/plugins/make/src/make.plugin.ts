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

import type { MakeStepId, MakeSettings, MakePipelineMetrics, MakeExecutionMode } from './types.js';
import { MAKE_STEP_IDS, DEFAULT_BASE_URL, DEFAULT_POLL_INTERVAL_MS, DEFAULT_MAX_POLL_ATTEMPTS } from './types.js';
import { STEP_DEFINITIONS } from './steps.js';
import { MakeClient, type MakeExecutionResult } from './utils/make-client.js';
import { buildWorkflowPayload } from './utils/payload-builder.js';
import { parseMakeOutput, deduplicateItems } from './utils/result-parser.js';
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
 * Make.com Workflows Plugin
 *
 * Pipeline plugin that delegates directory generation to a Make.com scenario
 * or webhook. The plugin triggers the scenario/webhook at a pipeline stage,
 * polls for completion, and returns structured items ready to be stored.
 */
export class MakePlugin implements IPlugin, IPipelinePlugin, IFormSchemaProvider {
	readonly id = 'make';
	readonly name = 'Make.com Workflows';
	readonly version = '1.0.0';
	readonly category: PluginCategory = 'pipeline';
	readonly capabilities = ['pipeline', 'form-schema-provider'] as const;
	readonly configurationMode = 'user-required' as const;
	readonly handledConfigFields = ['*'] as const;

	readonly settingsSchema: JsonSchema = {
		type: 'object',
		properties: {
			apiKey: {
				type: 'string',
				title: 'Make.com API Key',
				description: 'API token generated from your Make.com dashboard (with all scopes enabled).',
				'x-secret': true,
				'x-scope': 'user',
				'x-envVar': 'MAKE_API_KEY'
			},
			baseUrl: {
				type: 'string',
				title: 'Make.com API Base URL',
				description: 'Zone-specific API base URL (e.g., https://us2.make.com/api/v2).',
				default: DEFAULT_BASE_URL,
				'x-scope': 'user'
			},
			teamId: {
				type: 'string',
				title: 'Team ID',
				description: 'Optional Make.com team ID used to scope scenario and hook queries.',
				'x-scope': 'user'
			},
			organizationId: {
				type: 'string',
				title: 'Organization ID',
				description: 'Optional Make.com organization ID used when no team ID is provided.',
				'x-scope': 'user'
			},
			defaultScenarioId: {
				type: 'string',
				title: 'Default Scenario ID',
				description: 'Default Make.com scenario to run when not specified in the generator form.',
				'x-scope': 'user'
			},
			defaultHookId: {
				type: 'string',
				title: 'Default Hook ID',
				description: 'Optional default Make.com hook (webhook) ID to ping during the pipeline.',
				'x-scope': 'user'
			},
			defaultWebhookUrl: {
				type: 'string',
				title: 'Default Webhook URL',
				description: 'Default webhook URL for webhook-mode execution (e.g. https://hook.us2.make.com/xyz).',
				'x-scope': 'user'
			}
		},
		required: ['apiKey']
	};

	private context: PluginContext | null = null;

	// ── IPlugin lifecycle ──────────────────────────────────────────────

	async onLoad(context: PluginContext): Promise<void> {
		this.context = context;
		context.logger.log('Make.com Workflows plugin loaded');
	}

	async onUnload(): Promise<void> {
		await this.cancel();
		this.context = null;
	}

	async healthCheck(): Promise<PluginHealthCheck> {
		return {
			status: 'healthy',
			message: 'Make.com Workflows plugin is ready',
			checkedAt: Date.now()
		};
	}

	async isAvailable(settings?: Record<string, unknown>): Promise<boolean> {
		const resolved = settings || {};
		const apiKey = resolved.apiKey as string | undefined;
		return !!apiKey && apiKey.trim().length > 0;
	}

	async validateSettings(settings: Record<string, unknown>): Promise<ValidationResult> {
		const apiKey = settings.apiKey as string | undefined;
		if (!apiKey || apiKey.trim() === '') {
			return { valid: false, errors: [{ path: 'apiKey', message: 'Make.com API key is required' }] };
		}
		return { valid: true };
	}

	async validateConnection(rawSettings: Record<string, unknown>): Promise<ConnectionValidationResult> {
		const settings = this.flattenSettings(rawSettings);
		const apiKey = settings.apiKey as string | undefined;
		if (!apiKey) {
			return { success: false, message: 'Make.com API key is required' };
		}

		try {
			const baseUrl = (settings.baseUrl as string) || DEFAULT_BASE_URL;
			const client = new MakeClient({
				apiKey,
				baseUrl,
				teamId: settings.teamId as string | undefined,
				organizationId: settings.organizationId as string | undefined,
				logger: this.context?.logger ?? console
			});

			const scenarioId = settings.defaultScenarioId as string | undefined;
			if (scenarioId) {
				await client.validateScenario(scenarioId);
				return {
					success: true,
					message: `Connected to Make.com. Scenario "${scenarioId}" is active and ready.`
				};
			}

			await client.whoAmI();
			return { success: true, message: 'Connected to Make.com successfully.' };
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
			description: 'Pipeline plugin that delegates directory generation to Make.com scenarios and webhooks',
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
				completionFields: ['apiKey'],
				onboardingDescription:
					'Connect Make.com to delegate directory generation to visual automation scenarios and webhooks.'
			},
			readme: README,
			homepage: 'https://developers.make.com/api-documentation',
			icon: {
				type: 'url',
				value: 'https://www.make.com/favicon.ico'
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

	private _lastState: PipelineState<MakeStepId> | null = null;
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

		const setState = (stepId: MakeStepId, status: StepStatus, error?: string): void => {
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

			const makeSettings = this.resolveMakeSettings(pluginSettings, config);
			const { mode, scenarioId, hookId, webhookUrl } = this.resolveExecutionTarget(config, makeSettings);

			if (mode === 'scenario' && !scenarioId) {
				return handleError(
					new Error(
						'No Make.com scenario ID provided. Set it in the generator form or in plugin settings (defaultScenarioId).'
					)
				);
			}
			if (mode === 'webhook' && !webhookUrl) {
				return handleError(
					new Error(
						'No Make.com webhook URL provided. Set it in the generator form or in plugin settings (defaultWebhookUrl).'
					)
				);
			}

			const client = new MakeClient({
				apiKey: makeSettings.apiKey,
				baseUrl: makeSettings.baseUrl,
				teamId: makeSettings.teamId,
				organizationId: makeSettings.organizationId,
				logger
			});

			// ── Step 1: Validate Make.com ─────────────────────────────
			setState('validate-make', 'running');
			reportProgress(onProgress, 0, 5, 'Validate Make.com Connection');

			if (mode === 'scenario' && scenarioId) {
				await client.validateScenario(scenarioId, signal);
			} else if (mode === 'webhook') {
				await client.whoAmI(signal);
			}

			if (hookId) {
				try {
					await client.pingHook(hookId, signal);
				} catch (error) {
					const reason = error instanceof Error ? error.message : 'Unknown error';
					logger.warn(`Make.com hook ping failed for "${hookId}": ${reason}`);
				}
			}

			setState('validate-make', 'completed');

			if (signal.aborted) return handleCancel();

			// ── Step 2: Prepare Payload ───────────────────────────────
			setState('prepare-payload', 'running');
			reportProgress(onProgress, 1, 10, 'Prepare Scenario Payload');

			const payload = buildWorkflowPayload({ directory, request, existing, config });

			logger.log(
				`Payload prepared: ${payload.metadata.targetItems} target items, ` +
					`${payload.existingSummary?.totalItems ?? 0} existing items, ` +
					`dataSource=${payload.dataSource?.type ?? 'none'}`
			);
			setState('prepare-payload', 'completed');

			if (signal.aborted) return handleCancel();

			// ── Step 3: Execute Scenario / Webhook ────────────────────
			setState('execute-scenario', 'running');

			let execResult: MakeExecutionResult;

			if (mode === 'scenario' && scenarioId) {
				reportProgress(onProgress, 2, 15, 'Execute Make.com Scenario', `Starting scenario "${scenarioId}"...`);

				const runStart = Date.now();
				const run = await client.runScenario(scenarioId, payload, signal);
				const executionId = run.executionId ?? this.extractExecutionId(run as Record<string, unknown>);

				if (executionId) {
					const { status, attempts } = await client.pollExecution(
						scenarioId,
						executionId,
						makeSettings,
						(attempt, statusName) => {
							const percent = Math.min(15 + Math.round((attempt / 60) * 55), 70);
							reportProgress(
								onProgress,
								2,
								percent,
								'Execute Make.com Scenario',
								`Execution ${statusName} (poll #${attempt})...`
							);
						},
						signal
					);
					execResult = {
						output: status.output ?? status.result ?? status.data ?? status,
						pollingAttempts: attempts,
						makeDuration: Date.now() - runStart,
						executionId
					};
				} else {
					execResult = {
						output: run.output ?? run.result ?? run.data ?? run,
						pollingAttempts: 0,
						makeDuration: Date.now() - runStart
					};
				}
			} else {
				reportProgress(onProgress, 2, 15, 'Execute Make.com Scenario', 'Invoking webhook...');
				const runStart = Date.now();
				const output = await client.invokeWebhook(webhookUrl as string, payload, signal);
				execResult = {
					output,
					pollingAttempts: 0,
					makeDuration: Date.now() - runStart
				};
			}

			logger.log(
				`Make.com execution completed. Mode: ${mode}, duration: ${execResult.makeDuration ?? 'unknown'}ms`
			);
			setState('execute-scenario', 'completed');

			if (signal.aborted) return handleCancel();

			// ── Step 4: Collect & Validate Results ────────────────────
			setState('collect-results', 'running');
			reportProgress(onProgress, 3, 75, 'Collect & Validate Results');

			logger.log(`Received Make.com output (${describeOutputShape(execResult.output)})`);

			const parsed = parseMakeOutput(execResult.output);

			const existingNames = existing.items.map((i) => i.name);
			const items = deduplicateItems(parsed.items, existingNames);

			logger.log(
				`Collected ${parsed.items.length} items from Make.com, ` +
					`${parsed.items.length - items.length} duplicates removed, ` +
					`${items.length} new items`
			);
			setState('collect-results', 'completed');

			// ── Step 5: Capture Screenshots ───────────────────────────
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
			const metrics: MakePipelineMetrics = {
				executionMode: mode,
				scenarioId: scenarioId,
				hookId: hookId,
				executionId: execResult.executionId,
				makeDuration: execResult.makeDuration
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
					metrics: buildMetrics(startTime, duration, items.length, metrics),
					duration,
					stepsCompleted: state.completedSteps.length,
					totalSteps: MAKE_STEP_IDS.length,
					state,
					warnings: screenshotWarnings.length > 0 ? screenshotWarnings : undefined
				}
			);
		} catch (error) {
			const err = error instanceof Error ? error : new Error(String(error));
			logger.error(`Make.com pipeline failed: ${err.message}`);
			return handleError(err);
		}
	}

	async cancel(): Promise<void> {
		this._lastAbortController?.abort();
	}

	getState(): PipelineState<MakeStepId> | null {
		return this._lastState;
	}

	// ── Private helpers ────────────────────────────────────────────────

	private resolveMakeSettings(
		pluginSettings: Record<string, unknown>,
		config: Record<string, unknown>
	): MakeSettings {
		const apiKey = pluginSettings.apiKey as string;
		if (!apiKey) {
			throw new Error('Make.com API key is not configured. Please set it in plugin settings.');
		}

		const timeoutMinutes = (config.scenario_timeout as number) || 30;
		const mode = ((config.execution_mode as string) || 'scenario') as MakeExecutionMode;

		return {
			apiKey,
			baseUrl: (pluginSettings.baseUrl as string) || DEFAULT_BASE_URL,
			teamId: (pluginSettings.teamId as string) || undefined,
			organizationId: (pluginSettings.organizationId as string) || undefined,
			defaultScenarioId: pluginSettings.defaultScenarioId as string | undefined,
			defaultHookId: pluginSettings.defaultHookId as string | undefined,
			defaultWebhookUrl: pluginSettings.defaultWebhookUrl as string | undefined,
			executionMode: mode,
			timeoutMs: timeoutMinutes * 60 * 1000,
			pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
			maxPollAttempts: DEFAULT_MAX_POLL_ATTEMPTS
		};
	}

	private resolveExecutionTarget(
		config: Record<string, unknown>,
		settings: MakeSettings
	): { mode: MakeExecutionMode; scenarioId?: string; hookId?: string; webhookUrl?: string } {
		const mode = ((config.execution_mode as string) || settings.executionMode || 'scenario') as MakeExecutionMode;

		const scenarioFromConfig = (config.scenario_id as string | undefined)?.trim();
		const hookFromConfig = (config.hook_id as string | undefined)?.trim();
		const webhookFromConfig = (config.webhook_url as string | undefined)?.trim();

		return {
			mode,
			scenarioId: scenarioFromConfig || settings.defaultScenarioId,
			hookId: hookFromConfig || settings.defaultHookId,
			webhookUrl: webhookFromConfig || settings.defaultWebhookUrl
		};
	}

	private extractExecutionId(run: Record<string, unknown>): string | undefined {
		const candidates = ['executionId', 'execution_id', 'imtId', 'id'];
		for (const key of candidates) {
			const value = run[key];
			if (typeof value === 'string' && value.trim()) return value;
			if (typeof value === 'number') return String(value);
		}
		const execution = run.execution as Record<string, unknown> | undefined;
		if (execution) {
			const nested = execution.id ?? execution.imtId ?? execution.executionId;
			if (typeof nested === 'string' && nested.trim()) return nested;
			if (typeof nested === 'number') return String(nested);
		}
		return undefined;
	}

	private async captureScreenshots(
		setState: (stepId: MakeStepId, status: StepStatus, error?: string) => void,
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
			setState('capture-screenshots', 'skipped');
			return [];
		}

		if (!screenshotFacade.isAvailable()) {
			setState('capture-screenshots', 'skipped');
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

	/**
	 * Flatten a ResolvedSettings map into plain key->value pairs.
	 */
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

/**
 * Describes the shape of a Make.com response without serializing its values.
 * We avoid JSON.stringify because the output may contain circular references
 * (which would throw and fail the pipeline after a successful run) or echo
 * sensitive inputs like repo access tokens into logs.
 */
function describeOutputShape(output: unknown): string {
	if (output === null) return 'type=null';
	if (output === undefined) return 'type=undefined';
	if (Array.isArray(output)) return `type=array, length=${output.length}`;
	if (typeof output === 'string') return `type=string, length=${output.length}`;
	if (typeof output === 'object') {
		const keys = Object.keys(output as Record<string, unknown>);
		return `type=object, keys=[${keys.slice(0, 10).join(', ')}${keys.length > 10 ? ', …' : ''}]`;
	}
	return `type=${typeof output}`;
}

export default MakePlugin;
