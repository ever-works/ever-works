import type {
	AiModel,
	ConnectionValidationResult,
	FacadeOptions,
	DirectoryReference,
	ExistingItems,
	FormFieldDefinition,
	FormFieldGroup,
	GenerationRequest,
	IFormSchemaProvider,
	IPlugin,
	IPipelinePlugin,
	JsonSchema,
	PipelineExecutionOptions,
	PipelineProgressCallback,
	PipelineResult,
	PipelineStepDefinition,
	PipelineState,
	PluginCategory,
	PluginContext,
	PluginHealthCheck,
	PluginManifest,
	StepStatus,
	ValidationResult
} from '@ever-works/plugin';
import { buildSuccessPipelineResult, lucideIcon } from '@ever-works/plugin';

import type { CodexStepId } from './types.js';
import { DEFAULT_MODEL } from './types.js';
import { STEP_DEFINITIONS } from './steps.js';
import {
	DEFAULT_TARGET_ITEMS,
	getDefaultValues as formDefaults,
	getFormFields as formFields,
	getFormGroups as formGroups,
	validateFormInput as formValidate
} from './form-schema.js';
import { DEFAULT_SYSTEM_PROMPT, DEFAULT_USER_PROMPT } from './prompt/system-prompt.js';
import { executeCodex, type ExecuteResult } from './utils/process-runner.js';
import {
	cleanupWorkspace,
	collectMetadataFromItems,
	createWorkspace,
	readGeneratedItems,
	seedExistingItems,
	seedMetadata
} from './utils/workspace-manager.js';
import { captureScreenshots } from './utils/screenshot-capture.js';
import {
	buildCancelledResult,
	buildErrorResult,
	buildMetrics,
	hasLocalCodexAuth,
	initializeState,
	reportProgress,
	resolveExecutionAuth,
	resolveSettings,
	updateStepState
} from './utils/pipeline-helpers.js';

const CODEX_SUPPORTED_MODELS: readonly AiModel[] = [
	{
		id: 'codex-mini-latest',
		name: 'Codex Mini Latest',
		capabilities: {
			supportsStructuredOutput: true,
			supportsStreaming: true,
			supportsToolCalling: true,
			supportsVision: true,
			maxContextLength: 200000
		}
	},
	{
		id: 'gpt-5.2-codex',
		name: 'GPT-5.2 Codex',
		capabilities: {
			supportsStructuredOutput: true,
			supportsStreaming: true,
			supportsToolCalling: true,
			supportsVision: true,
			maxContextLength: 400000
		}
	}
] as const;

const MANIFEST: PluginManifest = {
	id: 'codex',
	name: 'Codex Generator',
	version: '1.0.0',
	category: 'pipeline',
	capabilities: ['pipeline', 'form-schema-provider'],
	description: 'Full pipeline plugin that delegates the entire generation to Codex',
	author: { name: 'Ever Works Team' },
	license: 'MIT',
	builtIn: true,
	autoEnable: false,
	visibility: 'public',
	icon: lucideIcon('sparkles'),
	uiHints: {
		byok: {
			buttonLabel: 'Bring your own key',
			triggerField: 'apiKey'
		},
		setupLink: {
			url: 'https://platform.openai.com/account/api-keys',
			label: 'OpenAI API keys',
			buttonLabel: 'Get API key',
			showWhenEmpty: ['apiKey']
		}
	}
};

const LOG_MESSAGE_MAX_LENGTH = 500;
const STEP_CONTEXT_BY_ID = new Map(
	STEP_DEFINITIONS.map((step, stepIndex) => [step.id, { stepIndex, stepName: step.name }])
);

export class CodexPlugin implements IPlugin, IPipelinePlugin, IFormSchemaProvider {
	readonly id = 'codex';
	readonly name = 'Codex Generator';
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
				title: 'API Key',
				description: 'OpenAI API key for Codex CLI execution',
				'x-secret': true,
				'x-scope': 'user',
				'x-envVar': 'OPENAI_API_KEY'
			},
			model: {
				type: 'string',
				title: 'Model',
				'x-scope': 'global',
				'x-widget': 'model-select',
				default: DEFAULT_MODEL,
				description: 'Model to use for Codex generation'
			}
		}
	};

	private context: PluginContext | null = null;
	private state: PipelineState<CodexStepId> | null = null;
	private abortController: AbortController | null = null;
	private killProcess: (() => void) | null = null;

	async onLoad(context: PluginContext): Promise<void> {
		this.context = context;
		this.state = initializeState();
		context.logger.log('Codex Generator plugin loaded');
	}

	async onUnload(): Promise<void> {
		await this.cancel();
		this.state = null;
		this.context = null;
	}

	async healthCheck(): Promise<PluginHealthCheck> {
		return {
			status: 'healthy',
			message: 'Codex Generator plugin scaffold is loaded',
			checkedAt: Date.now()
		};
	}

	getManifest(): PluginManifest {
		return MANIFEST;
	}

	async listModels(): Promise<readonly AiModel[]> {
		return CODEX_SUPPORTED_MODELS;
	}

	getStepDefinitions(): readonly PipelineStepDefinition<CodexStepId>[] {
		return STEP_DEFINITIONS;
	}

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

	validateSettings(settings: Record<string, unknown>): ValidationResult {
		if (typeof settings.apiKey !== 'string' || settings.apiKey.trim().length === 0) {
			return {
				valid: false,
				errors: [
					{
						path: 'apiKey',
						message: 'OpenAI API key is required for the Codex plugin'
					}
				]
			};
		}

		return { valid: true };
	}

	async validateConnection(settings: Record<string, unknown>): Promise<ConnectionValidationResult> {
		const apiKey = typeof settings.apiKey === 'string' ? settings.apiKey.trim() : '';
		if (apiKey) {
			return {
				success: true,
				message: 'Codex API key is configured'
			};
		}

		if (await hasLocalCodexAuth(settings)) {
			return {
				success: true,
				message: 'Local Codex CLI auth is available'
			};
		}

		return {
			success: false,
			message: 'Configure an OpenAI API key or sign in locally with Codex CLI first'
		};
	}

	async execute(
		directory: DirectoryReference,
		request: GenerationRequest,
		existing: ExistingItems,
		options?: PipelineExecutionOptions,
		onProgress?: PipelineProgressCallback
	): Promise<PipelineResult> {
		const startTime = Date.now();
		this.state = initializeState();
		this.abortController = new AbortController();

		if (options?.signal) {
			if (options.signal.aborted) {
				this.abortController.abort();
			} else {
				options.signal.addEventListener('abort', () => this.abortController?.abort(), { once: true });
			}
		}

		const signal = this.abortController.signal;
		const onLogEntry = options?.onLogEntry;
		const logger = this.context?.logger ?? console;
		const userId = directory.user?.id ?? 'system';

		let workspaceCreated = false;

		try {
			const setupStartedAt = this.startStep('setup-codex', onLogEntry);
			reportProgress(onProgress, 0, 5, 'Setup Codex');

			const settings = await resolveSettings(this.context, userId, directory.id);
			const executionAuth = await resolveExecutionAuth(settings);
			if (!executionAuth) {
				throw new Error(
					'No Codex authentication available. Configure an OpenAI API key or sign in locally with Codex CLI.'
				);
			}

			this.emitCodexLog({
				onLogEntry,
				stepId: 'setup-codex',
				event: 'message',
				level: 'info',
				message: `Using Codex ${executionAuth.mode === 'api-key' ? 'API key' : 'local auth'} mode`
			});
			this.completeStep('setup-codex', setupStartedAt, onLogEntry);

			const prepareStartedAt = this.startStep('prepare-context', onLogEntry);
			reportProgress(onProgress, 1, 15, 'Prepare Context');

			const workspacePath = await createWorkspace(userId, directory.id);
			workspaceCreated = true;
			await seedExistingItems(workspacePath, existing.items);
			await seedMetadata(workspacePath, {
				directory: { name: directory.name, description: directory.description },
				request: { prompt: request.prompt, name: request.name },
				categories: existing.categories,
				tags: existing.tags,
				brands: existing.brands
			});
			this.completeStep('prepare-context', prepareStartedAt, onLogEntry);

			const generateStartedAt = this.startStep('generate-items', onLogEntry);
			reportProgress(onProgress, 2, 30, 'Generate Items');

			const prompt = this.buildExecutionPrompt(directory, request);
			const { promise, kill } = executeCodex({
				command: 'codex',
				cwd: workspacePath,
				env: executionAuth.env,
				model: typeof settings.model === 'string' ? settings.model : DEFAULT_MODEL,
				prompt,
				signal,
				onStdoutLine: (line) => {
					this.emitCodexLog({
						onLogEntry,
						stepId: 'generate-items',
						event: 'message',
						level: 'info',
						message: line
					});
				},
				onStderrLine: (line) => {
					this.emitCodexLog({
						onLogEntry,
						stepId: 'generate-items',
						event: 'message',
						level: 'warn',
						message: line
					});
				}
			});
			this.killProcess = kill;
			const executionResult = await promise;
			this.killProcess = null;

			if (signal.aborted || executionResult.killed) {
				return this.handleCancel(startTime);
			}

			if (executionResult.exitCode !== 0) {
				throw new Error(this.extractErrorDetail(executionResult));
			}

			reportProgress(onProgress, 2, 80, 'Generate Items', 'Codex execution finished');
			this.completeStep('generate-items', generateStartedAt, onLogEntry);

			const collectStartedAt = this.startStep('collect-results', onLogEntry);
			reportProgress(onProgress, 3, 85, 'Collect Results');

			const items = await readGeneratedItems(workspacePath, logger);
			const metadata = collectMetadataFromItems(items);
			this.completeStep('collect-results', collectStartedAt, onLogEntry);

			const screenshotWarnings = await this.runScreenshotCapture(
				request,
				options?.execContext,
				items as never[],
				userId,
				directory.id,
				signal,
				onProgress,
				logger,
				onLogEntry
			);

			const cleanupStartedAt = this.startStep('cleanup', onLogEntry);
			reportProgress(onProgress, 5, 95, 'Cleanup');
			await cleanupWorkspace(userId, directory.id);
			workspaceCreated = false;
			this.completeStep('cleanup', cleanupStartedAt, onLogEntry);

			reportProgress(onProgress, 6, 100, 'Complete');
			const duration = Date.now() - startTime;

			return buildSuccessPipelineResult(
				{
					items,
					categories: metadata.categories,
					tags: metadata.tags,
					brands: metadata.brands,
					collections: metadata.collections || []
				},
				{
					metrics: buildMetrics(startTime, duration, items.length),
					duration,
					stepsCompleted: this.state?.completedSteps.length ?? 0,
					totalSteps: STEP_DEFINITIONS.length,
					state: this.state ?? undefined,
					warnings: screenshotWarnings.length > 0 ? screenshotWarnings : undefined
				}
			);
		} catch (error) {
			const err = error instanceof Error ? error : new Error(String(error));
			const runningStepId = this.getRunningStepId();
			if (runningStepId) {
				this.failStep(runningStepId, err, onLogEntry);
			}
			if (workspaceCreated) {
				await cleanupWorkspace(userId, directory.id);
			}
			return this.handleError(err, startTime);
		}
	}

	async cancel(): Promise<void> {
		this.abortController?.abort();
		this.killProcess?.();
		this.killProcess = null;
	}

	getState(): PipelineState<CodexStepId> | null {
		return this.state;
	}

	private buildExecutionPrompt(directory: DirectoryReference, request: GenerationRequest): string {
		const targetItems = Number(request.config?.target_items ?? DEFAULT_TARGET_ITEMS);
		const topic = request.prompt || request.name || directory.name;

		return [
			DEFAULT_SYSTEM_PROMPT.trim(),
			'',
			DEFAULT_USER_PROMPT.trim(),
			'',
			`Directory name: ${directory.name}`,
			`Directory slug: ${directory.slug}`,
			directory.description ? `Directory description: ${directory.description}` : '',
			topic ? `Generation topic: ${topic}` : '',
			`Target new items: ${targetItems}`,
			'',
			'Workspace contract:',
			'- Read existing item JSON files in the workspace root.',
			'- Read metadata from the `_meta` directory.',
			'- Create or update item JSON files in the workspace root only.',
			'- Each generated item JSON must include at least: name, description, source_url, category.',
			'- Avoid duplicates with existing items unless the request explicitly asks for updates.',
			'- Do not delete metadata files under `_meta`.'
		]
			.filter(Boolean)
			.join('\n');
	}

	private startStep(stepId: CodexStepId, onLogEntry?: PipelineExecutionOptions['onLogEntry']): number {
		this.setState(stepId, 'running');
		this.emitCodexLog({
			onLogEntry,
			stepId,
			event: 'step_started',
			level: 'info',
			message: this.getStepName(stepId)
		});
		return Date.now();
	}

	private completeStep(
		stepId: CodexStepId,
		startedAt: number,
		onLogEntry?: PipelineExecutionOptions['onLogEntry']
	): void {
		this.setState(stepId, 'completed');
		this.emitCodexLog({
			onLogEntry,
			stepId,
			event: 'step_completed',
			level: 'info',
			message: this.getStepName(stepId),
			durationMs: Date.now() - startedAt
		});
	}

	private failStep(stepId: CodexStepId, error: Error, onLogEntry?: PipelineExecutionOptions['onLogEntry']): void {
		this.setState(stepId, 'failed', error.message);
		this.emitCodexLog({
			onLogEntry,
			stepId,
			event: 'step_failed',
			level: 'error',
			message: `${this.getStepName(stepId)}: ${this.truncateLogMessage(error.message)}`
		});
	}

	private skipStep(
		stepId: CodexStepId,
		message: string,
		onLogEntry?: PipelineExecutionOptions['onLogEntry']
	): void {
		this.setState(stepId, 'skipped' as StepStatus);
		this.emitCodexLog({
			onLogEntry,
			stepId,
			event: 'step_skipped',
			level: 'info',
			message
		});
	}

	private emitCodexLog({
		onLogEntry,
		stepId,
		message,
		...log
	}: {
		readonly onLogEntry?: PipelineExecutionOptions['onLogEntry'];
		readonly stepId?: CodexStepId;
		readonly event: 'step_started' | 'step_completed' | 'step_failed' | 'step_skipped' | 'message';
		readonly level: 'info' | 'warn' | 'error' | 'debug';
		readonly message: string;
		readonly durationMs?: number;
	}): void {
		if (!onLogEntry) {
			return;
		}

		const stepContext = stepId ? STEP_CONTEXT_BY_ID.get(stepId) : undefined;
		onLogEntry({
			timestamp: new Date().toISOString(),
			source: 'pipeline',
			stepIndex: stepContext?.stepIndex ?? null,
			stepName: stepContext?.stepName ?? null,
			message: this.truncateLogMessage(message),
			...log
		});
	}

	private getStepName(stepId: CodexStepId): string {
		return STEP_CONTEXT_BY_ID.get(stepId)?.stepName ?? stepId;
	}

	private getRunningStepId(): CodexStepId | undefined {
		if (!this.state) {
			return undefined;
		}

		for (const stepId of STEP_DEFINITIONS.map((step) => step.id)) {
			if (this.state.steps.get(stepId)?.status === 'running') {
				return stepId;
			}
		}
		return undefined;
	}

	private setState(stepId: CodexStepId, status: StepStatus, error?: string): void {
		if (this.state) {
			this.state = updateStepState(this.state, stepId, status, error);
		}
	}

	private truncateLogMessage(message: string): string {
		return message.trim().slice(0, LOG_MESSAGE_MAX_LENGTH);
	}

	private extractErrorDetail(result: ExecuteResult): string {
		if (result.stderr?.trim()) {
			return result.stderr.trim().split('\n')[0].slice(0, LOG_MESSAGE_MAX_LENGTH);
		}
		if (result.stdout?.trim()) {
			return result.stdout.trim().split('\n')[0].slice(0, LOG_MESSAGE_MAX_LENGTH);
		}
		return `exit code ${result.exitCode}`;
	}

	private handleError(error: Error, startTime: number): PipelineResult {
		const { result, state } = buildErrorResult(this.state, error, startTime);
		this.state = state;
		return result;
	}

	private handleCancel(startTime: number): PipelineResult {
		const { result, state } = buildCancelledResult(this.state, startTime);
		this.state = state;
		return result;
	}

	private async runScreenshotCapture(
		request: GenerationRequest,
		execContext: PipelineExecutionOptions['execContext'],
		items: { name: string; source_url?: string; images?: string[] }[],
		userId: string,
		directoryId: string,
		signal: AbortSignal,
		onProgress: PipelineProgressCallback | undefined,
		logger: { warn(...args: unknown[]): void },
		onLogEntry?: PipelineExecutionOptions['onLogEntry']
	): Promise<string[]> {
		const shouldCapture = (request.config || {}).capture_screenshots !== false;
		const screenshotFacade = execContext?.screenshotFacade;

		if (!shouldCapture || items.length === 0 || signal.aborted || !screenshotFacade) {
			this.skipStep('capture-screenshots', 'Screenshot capture skipped', onLogEntry);
			return [];
		}

		if (!screenshotFacade.isAvailable()) {
			this.skipStep(
				'capture-screenshots',
				'Screenshot provider is not configured. Enable a screenshot plugin to capture item images.',
				onLogEntry
			);
			return [];
		}

		const startedAt = this.startStep('capture-screenshots', onLogEntry);
		reportProgress(onProgress, 4, 90, 'Capture Screenshots');

		const facadeOptions: FacadeOptions = {
			userId,
			directoryId
		};

		const result = await captureScreenshots(items as never[], {
			screenshotFacade,
			facadeOptions,
			signal,
			logger
		});

		if (result.status === 'failed') {
			this.failStep('capture-screenshots', new Error('Screenshot capture failed'), onLogEntry);
		} else {
			this.completeStep('capture-screenshots', startedAt, onLogEntry);
		}

		return result.errors;
	}
}

export default CodexPlugin;
