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
	ItemData
} from '@ever-works/plugin';
import { buildSuccessPipelineResult } from '@ever-works/plugin';

import type { SimAiStepId, SimAiSettings, SimAiPipelineMetrics } from './types.js';
import {
	SIM_AI_STEP_IDS,
	DEFAULT_BASE_URL,
	DEFAULT_POLLING_INTERVAL_MS,
	DEFAULT_ASYNC_TIMEOUT_MS,
	DEFAULT_MAX_RETRIES,
	DEFAULT_TARGET_ITEMS
} from './types.js';
import { STEP_DEFINITIONS } from './steps.js';
import { SimClientWrapper } from './utils/sim-client.js';
import { buildWorkflowPayload } from './utils/payload-builder.js';
import { parseSimOutput, deduplicateItems } from './utils/result-parser.js';
import { captureScreenshots } from './utils/screenshot-capture.js';
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
import { registerToken, revokeToken, cleanupExpiredTokens, sanitizeTokenForLog } from './utils/token-manager.js';

/**
 * SIM AI Workflows Plugin
 *
 * Full pipeline plugin that delegates directory generation to SIM AI workflows.
 * SIM AI is an open-source AI agent workflow builder — this plugin triggers
 * deployed SIM workflows and collects structured item results.
 */
export class SimAiPlugin implements IPlugin, IPipelinePlugin, IFormSchemaProvider {
	readonly id = 'sim-ai';
	readonly name = 'SIM AI Workflows';
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
				title: 'SIM API Key',
				description: 'API key from your SIM AI dashboard (generate one when deploying a workflow)',
				'x-secret': true,
				'x-scope': 'user',
				'x-envVar': 'SIM_API_KEY'
			},
			baseUrl: {
				type: 'string',
				title: 'SIM Base URL',
				description: 'Custom SIM instance URL (leave empty for default sim.ai)',
				default: DEFAULT_BASE_URL,
				'x-scope': 'user'
			},
			defaultWorkflowId: {
				type: 'string',
				title: 'Default Workflow ID',
				description: 'Default SIM workflow to use for this directory',
				'x-scope': 'directory'
			},
			executionMode: {
				type: 'string',
				title: 'Execution Mode',
				enum: ['sync', 'async'],
				default: 'async',
				description: 'Sync for fast workflows (<30s), async for long-running workflows',
				'x-scope': 'directory'
			},
			asyncPollingIntervalMs: {
				type: 'integer',
				title: 'Polling Interval (ms)',
				default: DEFAULT_POLLING_INTERVAL_MS,
				minimum: 1000,
				maximum: 30000,
				'x-hidden': true
			},
			asyncTimeoutMs: {
				type: 'integer',
				title: 'Async Timeout (ms)',
				default: DEFAULT_ASYNC_TIMEOUT_MS,
				minimum: 30000,
				maximum: 3600000,
				description: 'Maximum wait time for async workflow completion',
				'x-hidden': true
			},
			maxRetries: {
				type: 'integer',
				title: 'Max Retries',
				default: DEFAULT_MAX_RETRIES,
				minimum: 0,
				maximum: 10,
				'x-hidden': true
			},
			eventTriggers: {
				type: 'object',
				title: 'Event Triggers',
				description: 'Trigger SIM workflows on Ever Works events',
				'x-scope': 'directory',
				properties: {
					onGenerationCompleted: {
						type: 'object',
						title: 'On Generation Completed',
						properties: {
							workflowId: { type: 'string', title: 'Workflow ID' },
							enabled: { type: 'boolean', default: false }
						}
					},
					onDirectoryDeployed: {
						type: 'object',
						title: 'On Directory Deployed',
						properties: {
							workflowId: { type: 'string', title: 'Workflow ID' },
							enabled: { type: 'boolean', default: false }
						}
					}
				}
			}
		},
		required: ['apiKey']
	};

	private context: PluginContext | null = null;

	// ── IPlugin lifecycle ──────────────────────────────────────────────

	async onLoad(context: PluginContext): Promise<void> {
		this.context = context;
		context.logger.log('SIM AI Workflows plugin loaded');
	}

	async onUnload(): Promise<void> {
		await this.cancel();
		this.context = null;
	}

	async healthCheck(): Promise<PluginHealthCheck> {
		cleanupExpiredTokens();
		return {
			status: 'healthy',
			message: 'SIM AI Workflows plugin is ready',
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
			return { valid: false, errors: [{ path: 'apiKey', message: 'SIM API key is required' }] };
		}
		return { valid: true };
	}

	async validateConnection(settings: Record<string, unknown>): Promise<ConnectionValidationResult> {
		const apiKey = settings.apiKey as string | undefined;
		if (!apiKey) {
			return { success: false, message: 'SIM API key is required' };
		}

		try {
			const baseUrl = (settings.baseUrl as string) || DEFAULT_BASE_URL;
			const client = new SimClientWrapper({
				apiKey,
				baseUrl,
				logger: this.context?.logger ?? console
			});

			// If a default workflow ID is set, validate it
			const workflowId = settings.defaultWorkflowId as string | undefined;
			if (workflowId) {
				await client.validateWorkflow(workflowId);
				return { success: true, message: `Connected to SIM. Workflow "${workflowId}" is deployed and ready.` };
			}

			return { success: true, message: 'Connected to SIM successfully.' };
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
			description: 'Pipeline plugin that delegates directory generation to SIM AI workflows',
			category: this.category,
			capabilities: [...this.capabilities],
			author: { name: 'Ever Works Team' },
			license: 'MIT',
			builtIn: true,
			autoEnable: false,
			visibility: 'public',
			selectableProviderCategories: ['screenshot'],
			uiHints: {
				onboardingWizard: true,
				validateOnSave: true,
				includeInOnboarding: true,
				onboardingPriority: 2,
				completionFields: ['apiKey'],
				onboardingDescription: 'Connect SIM AI to delegate directory generation to visual AI agent workflows.'
			},
			readme: [
				'# SIM AI Workflows Plugin',
				'',
				'Pipeline plugin that delegates the entire directory generation to [SIM AI](https://sim.ai) workflows.',
				'SIM AI is an open-source visual workflow builder for building and deploying AI agent workflows.',
				'',
				'## How it works',
				'',
				'1. **Validate** - Checks API key and verifies the SIM workflow is deployed',
				'2. **Prepare Payload** - Builds the input payload with directory context and existing items',
				'3. **Execute Workflow** - Calls the SIM API (sync or async with polling)',
				'4. **Collect Results** - Parses and validates the workflow output as directory items',
				'5. **Capture Screenshots** - Optionally captures screenshots for generated items',
				'6. **Cleanup** - Releases resources',
				'',
				'## Settings',
				'',
				'| Setting     | Description                |',
				'| ----------- | -------------------------- |',
				'| `apiKey`    | SIM AI API key (required)  |',
				'| `baseUrl`   | Custom SIM instance URL    |',
				'',
				'## Data Passing',
				'',
				'The plugin supports two strategies for passing data to SIM workflows:',
				'',
				'- **Inline** (default): Directory metadata and item summary sent in workflow input',
				'- **GitHub Repo**: Pass a repository URL and access token for large datasets'
			].join('\n'),
			homepage: 'https://sim.ai',
			icon: {
				type: 'url',
				value: 'https://sim.ai/favicon.ico'
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

	/** Per-execution state — stored for getState() but scoped per call via closures */
	private _lastState: PipelineState<SimAiStepId> | null = null;
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
		const signal = options?.signal ?? abortController.signal;

		let state = initializeState();

		// Expose to getState()/cancel() — last execution wins
		this._lastState = state;
		this._lastAbortController = abortController;

		const setState = (stepId: SimAiStepId, status: StepStatus, error?: string): void => {
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

		const executionId = `${directory.id}-${Date.now()}`;

		try {
			const pluginSettings = await resolveSettings(this.context, userId, directory.id);
			const config = (request.config || {}) as Record<string, unknown>;

			const simSettings = this.resolveSimSettings(pluginSettings, config);
			const workflowId = this.resolveWorkflowId(config, simSettings);

			if (!workflowId) {
				return handleError(
					new Error(
						'No SIM workflow ID provided. Set it in the generator form or in plugin settings (defaultWorkflowId).'
					)
				);
			}

			const simClient = new SimClientWrapper({
				apiKey: simSettings.apiKey,
				baseUrl: simSettings.baseUrl,
				logger
			});

			// ── Step 1: Validate SIM ──────────────────────────────────
			setState('validate-sim', 'running');
			reportProgress(onProgress, 0, 5, 'Validate SIM Connection');

			await simClient.validateWorkflow(workflowId);
			setState('validate-sim', 'completed');

			if (signal.aborted) return handleCancel();

			// ── Step 2: Prepare Payload ───────────────────────────────
			setState('prepare-payload', 'running');
			reportProgress(onProgress, 1, 10, 'Prepare Workflow Payload');

			const payload = buildWorkflowPayload({ directory, request, existing, config });

			// Track repo access tokens for cleanup
			if (payload.dataSource?.type === 'github-repo' && payload.dataSource.accessToken) {
				registerToken(executionId, {
					token: payload.dataSource.accessToken,
					repoUrl: payload.dataSource.repoUrl || '',
					expiresAt: Date.now() + 3600_000 // 1 hour
				});
				logger.log(
					`Registered repo access token ${sanitizeTokenForLog(payload.dataSource.accessToken)} ` +
						`for ${payload.dataSource.repoUrl}`
				);
			}

			logger.log(
				`Payload prepared: ${payload.metadata.targetItems} target items, ` +
					`${payload.existingSummary?.totalItems ?? 0} existing items, ` +
					`dataSource=${payload.dataSource?.type ?? 'none'}`
			);
			setState('prepare-payload', 'completed');

			if (signal.aborted) return handleCancel();

			// ── Step 3: Execute SIM Workflow ──────────────────────────
			setState('execute-workflow', 'running');
			reportProgress(onProgress, 2, 15, 'Execute SIM Workflow', `Starting workflow "${workflowId}"...`);

			const execResult = await simClient.executeWorkflow(
				workflowId,
				payload,
				simSettings,
				(attempt, status) => {
					const percent = Math.min(15 + Math.round((attempt / 60) * 55), 70);
					reportProgress(
						onProgress,
						2,
						percent,
						'Execute SIM Workflow',
						`Workflow ${status} (poll #${attempt})...`
					);
				},
				signal
			);

			logger.log(
				`SIM workflow completed. Polling attempts: ${execResult.pollingAttempts}, ` +
					`duration: ${execResult.simDuration ?? 'unknown'}ms`
			);
			setState('execute-workflow', 'completed');

			if (signal.aborted) return handleCancel();

			// ── Step 4: Collect & Validate Results ────────────────────
			setState('collect-results', 'running');
			reportProgress(onProgress, 3, 75, 'Collect & Validate Results');

			const parsed = parseSimOutput(execResult.output);

			// Deduplicate against existing items
			const existingNames = existing.items.map((i) => i.name);
			const items = deduplicateItems(parsed.items, existingNames);

			logger.log(
				`Collected ${parsed.items.length} items from SIM, ` +
					`${parsed.items.length - items.length} duplicates removed, ` +
					`${items.length} new items`
			);
			setState('collect-results', 'completed');

			// ── Step 5: Capture Screenshots ───────────────────────────
			const screenshotWarnings = await this.runScreenshotCapture(
				setState,
				request,
				options?.execContext,
				items,
				userId,
				directory.id,
				signal,
				onProgress,
				logger
			);

			// ── Step 6: Cleanup ───────────────────────────────────────
			setState('cleanup', 'running');
			reportProgress(onProgress, 5, 95, 'Cleanup');

			// Revoke tracked repo access tokens
			const revokedToken = revokeToken(executionId);
			if (revokedToken) {
				logger.log(`Revoked repo access token for ${revokedToken.repoUrl}`);
			}

			setState('cleanup', 'completed');

			// ── Build result ──────────────────────────────────────────
			reportProgress(onProgress, 6, 100, 'Complete');

			const duration = Date.now() - startTime;
			const simMetrics: SimAiPipelineMetrics = {
				workflowId,
				executionMode: simSettings.executionMode,
				taskId: execResult.taskId,
				pollingAttempts: execResult.pollingAttempts,
				simDuration: execResult.simDuration
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
					metrics: buildMetrics(startTime, duration, items.length, simMetrics),
					duration,
					stepsCompleted: state.completedSteps.length,
					totalSteps: SIM_AI_STEP_IDS.length,
					state,
					warnings: screenshotWarnings.length > 0 ? screenshotWarnings : undefined
				}
			);
		} catch (error) {
			const err = error instanceof Error ? error : new Error(String(error));
			logger.error(`SIM AI pipeline failed: ${err.message}`);

			// Ensure token cleanup even on error
			const revokedToken = revokeToken(executionId);
			if (revokedToken) {
				logger.log(`Revoked repo access token for ${revokedToken.repoUrl} (error path)`);
			}

			return handleError(err);
		}
	}

	async cancel(): Promise<void> {
		this._lastAbortController?.abort();
	}

	getState(): PipelineState<SimAiStepId> | null {
		return this._lastState;
	}

	// ── Private helpers ────────────────────────────────────────────────

	private resolveSimSettings(
		pluginSettings: Record<string, unknown>,
		config: Record<string, unknown>
	): SimAiSettings {
		const apiKey = pluginSettings.apiKey as string;
		if (!apiKey) {
			throw new Error('SIM API key is not configured. Please set it in plugin settings.');
		}

		return {
			apiKey,
			baseUrl: (pluginSettings.baseUrl as string) || DEFAULT_BASE_URL,
			defaultWorkflowId: pluginSettings.defaultWorkflowId as string | undefined,
			executionMode: ((config.execution_mode as string) ||
				(pluginSettings.executionMode as string) ||
				'async') as 'sync' | 'async',
			asyncPollingIntervalMs: (pluginSettings.asyncPollingIntervalMs as number) ?? DEFAULT_POLLING_INTERVAL_MS,
			asyncTimeoutMs: (pluginSettings.asyncTimeoutMs as number) ?? DEFAULT_ASYNC_TIMEOUT_MS,
			maxRetries: (pluginSettings.maxRetries as number) ?? DEFAULT_MAX_RETRIES,
			eventTriggers: pluginSettings.eventTriggers as SimAiSettings['eventTriggers']
		};
	}

	private resolveWorkflowId(config: Record<string, unknown>, settings: SimAiSettings): string | undefined {
		// Form field takes precedence over default setting
		const fromConfig = config.workflow_id as string | undefined;
		if (fromConfig && fromConfig.trim()) return fromConfig.trim();
		return settings.defaultWorkflowId;
	}

	private async runScreenshotCapture(
		setState: (stepId: SimAiStepId, status: StepStatus, error?: string) => void,
		request: GenerationRequest,
		execContext: PipelineExecutionOptions['execContext'],
		items: ItemData[],
		userId: string,
		directoryId: string,
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

		const { status, errors } = await captureScreenshots(items, {
			screenshotFacade,
			facadeOptions: { userId, directoryId },
			signal,
			logger
		});
		setState('capture-screenshots', status);

		if (errors.length > 0) {
			const providerName = await screenshotFacade.getActiveProviderName?.({ userId, directoryId });
			const label = providerName ? `Screenshot capture (${providerName})` : 'Screenshot capture';
			const unique = [...new Set(errors)];
			return [`${label} failed for ${errors.length} item(s): ${unique.join('; ')}`];
		}
		return [];
	}
}

export default SimAiPlugin;
