import type {
	ConnectionValidationResult,
	DirectoryReference,
	ExistingItems,
	FacadeOptions,
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
	PipelineState,
	PipelineStepDefinition,
	PluginCategory,
	PluginContext,
	PluginHealthCheck,
	PluginManifest,
	ValidationResult,
	ItemData
} from '@ever-works/plugin';
import { buildSuccessPipelineResult, substituteVariables } from '@ever-works/plugin';
import {
	DEFAULT_BINARY_PATH,
	DEFAULT_MAX_TURNS,
	DEFAULT_MODEL,
	DEFAULT_PROFILE,
	DEFAULT_PROVIDER,
	DEFAULT_TOOLSETS,
	HERMES_AGENT_STEP_IDS,
	type HermesAgentStepId
} from './types.js';
import { STEP_DEFINITIONS } from './steps.js';
import {
	DEFAULT_TARGET_ITEMS,
	getDefaultValues as formDefaults,
	getFormFields as formFields,
	getFormGroups as formGroups,
	validateFormInput as formValidate
} from './form-schema.js';
import { PROMPT_KEYS } from './prompt-keys.js';
import {
	buildSystemPromptVariables,
	buildUserPromptVariables,
	DEFAULT_SYSTEM_PROMPT,
	DEFAULT_USER_PROMPT
} from './prompt/system-prompt.js';
import { ensureBinary } from './utils/binary-manager.js';
import {
	buildCancelledResult,
	buildErrorResult,
	buildMetrics,
	finalizeCompletedState,
	initializeState,
	reportProgress,
	resolveHermesRuntimeSettings,
	resolveSettings,
	updateStepState
} from './utils/pipeline-helpers.js';
import { executeHermes, type ExecuteResult } from './utils/process-runner.js';
import {
	cleanupWorkspace,
	collectMetadataFromItems,
	createWorkspace,
	readGeneratedItems,
	seedExistingItems,
	seedMetadata,
	writeResultSchema
} from './utils/workspace-manager.js';
import { captureScreenshots } from './utils/screenshot-capture.js';

const MANIFEST: PluginManifest = {
	id: 'hermes-agent',
	name: 'Hermes Agent',
	version: '1.0.0',
	category: 'pipeline',
	capabilities: ['pipeline', 'form-schema-provider'],
	description: 'Self-managed pipeline plugin that delegates directory generation to Hermes Agent',
	author: { name: 'Ever Works Team' },
	license: 'MIT',
	builtIn: true,
	autoEnable: false,
	visibility: 'public',
	selectableProviderCategories: ['screenshot'],
	uiHints: {
		onboardingWizard: false,
		includeInOnboarding: false,
		setupLink: {
			url: 'https://hermes-agent.nousresearch.com/docs/getting-started/quickstart',
			label: 'Hermes setup guide',
			buttonLabel: 'Open Hermes docs'
		},
		completionFields: ['profile']
	},
	readme: [
		'# Hermes Agent Plugin',
		'',
		'Use a preconfigured Hermes Agent installation on the backend machine as the directory generation engine for Ever Works.',
		'',
		'## How it works',
		'',
		'- Ever Works creates an isolated workspace for the directory run.',
		'- Hermes is launched in one-shot CLI mode against that workspace.',
		'- Hermes researches the topic and writes a structured result file back into the workspace.',
		'- Ever Works validates the result and stores the generated items.',
		'',
		'## Backend prerequisites',
		'',
		'1. Install Hermes Agent on the machine running Ever Works.',
		'2. Run `hermes model` for the profile you want to use.',
		'3. Enter the Hermes profile name in this plugin settings page.',
		'',
		'This plugin does not manage Hermes provider secrets directly in v1. Hermes profile configuration remains the source of truth.'
	].join('\n'),
	homepage: 'https://github.com/NousResearch/hermes-agent',
	icon: {
		type: 'emoji',
		value: '☤'
	}
};

const LOG_MESSAGE_MAX_LENGTH = 500;
const STEP_CONTEXT_BY_ID = new Map(
	STEP_DEFINITIONS.map((definition, index) => [definition.id, { index, name: definition.name }] as const)
);

type HermesGenerationLog = Parameters<NonNullable<PipelineExecutionOptions['onLogEntry']>>[0];

function slugifyId(value: string): string {
	return value
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 80);
}

function buildCategoryOutputs(names: readonly string[]) {
	return names.map((name, index) => ({
		id: `generated-category-${slugifyId(name) || index + 1}`,
		name,
		priority: index + 1
	}));
}

function buildTagOutputs(names: readonly string[]) {
	return names.map((name, index) => ({
		id: `generated-tag-${slugifyId(name) || index + 1}`,
		name
	}));
}

function buildBrandOutputs(names: readonly string[]) {
	return names.map((name, index) => ({
		id: `generated-brand-${slugifyId(name) || index + 1}`,
		name
	}));
}

function createExecutionSignal(pluginController: AbortController, externalSignal?: AbortSignal): {
	signal: AbortSignal;
	cleanup: () => void;
} {
	if (!externalSignal) {
		return {
			signal: pluginController.signal,
			cleanup: () => {}
		};
	}

	if (externalSignal.aborted) {
		pluginController.abort((externalSignal as AbortSignal & { reason?: unknown }).reason);
		return {
			signal: pluginController.signal,
			cleanup: () => {}
		};
	}

	const abortFromExternal = () => {
		pluginController.abort((externalSignal as AbortSignal & { reason?: unknown }).reason);
	};

	externalSignal.addEventListener('abort', abortFromExternal, { once: true });

	return {
		signal: pluginController.signal,
		cleanup: () => externalSignal.removeEventListener('abort', abortFromExternal)
	};
}

export class HermesAgentPlugin implements IPlugin, IPipelinePlugin, IFormSchemaProvider {
	readonly id = 'hermes-agent';
	readonly name = 'Hermes Agent';
	readonly version = '1.0.0';
	readonly category: PluginCategory = 'pipeline';
	readonly capabilities = ['pipeline', 'form-schema-provider'] as const;
	readonly configurationMode = 'user-required' as const;
	readonly handledConfigFields = ['*'] as const;

	readonly settingsSchema: JsonSchema = {
		type: 'object',
		properties: {
			profile: {
				type: 'string',
				title: 'Hermes Profile',
				description: 'Hermes profile already configured on the backend machine via `hermes model`.',
				default: DEFAULT_PROFILE,
				'x-scope': 'user'
			},
			provider: {
				type: 'string',
				title: 'Provider Override',
				description: 'Optional Hermes provider override passed to the CLI for each run.',
				default: DEFAULT_PROVIDER,
				'x-hidden': true,
				'x-scope': 'global'
			},
			model: {
				type: 'string',
				title: 'Model Override',
				description: 'Optional Hermes model override passed to the CLI for each run.',
				default: DEFAULT_MODEL,
				'x-scope': 'global'
			},
			toolsets: {
				type: 'string',
				title: 'Toolsets',
				description: 'Comma-separated Hermes toolsets to enable for generation.',
				default: DEFAULT_TOOLSETS,
				'x-hidden': true,
				'x-scope': 'global'
			},
			skills: {
				type: 'string',
				title: 'Skills',
				description: 'Optional comma-separated Hermes skills to preload.',
				'x-hidden': true,
				'x-scope': 'global'
			},
			maxTurns: {
				type: 'integer',
				title: 'Max Turns',
				description: 'Maximum Hermes tool-calling turns per run.',
				default: DEFAULT_MAX_TURNS,
				minimum: 1,
				maximum: 500,
				'x-hidden': true,
				'x-scope': 'global'
			},
			yolo: {
				type: 'boolean',
				title: 'Auto Approve',
				description: 'Bypass Hermes approval prompts for automated runs.',
				default: true,
				'x-hidden': true,
				'x-scope': 'global'
			},
			binaryPath: {
				type: 'string',
				title: 'Binary Path',
				description: 'Override the Hermes CLI executable path if it is not available as `hermes`.',
				default: DEFAULT_BINARY_PATH,
				'x-hidden': true,
				'x-scope': 'global'
			}
		},
		required: ['profile']
	};

	private context: PluginContext | null = null;
	private state: PipelineState<HermesAgentStepId> | null = null;
	private abortController: AbortController | null = null;
	private killProcess: (() => void) | null = null;

	async onLoad(context: PluginContext): Promise<void> {
		this.context = context;
		context.logger.log('Hermes Agent plugin loaded');
	}

	async onUnload(): Promise<void> {
		await this.cancel();
		this.context = null;
	}

	async healthCheck(): Promise<PluginHealthCheck> {
		return {
			status: 'healthy',
			message: 'Hermes Agent plugin is ready',
			checkedAt: Date.now()
		};
	}

	getManifest(): PluginManifest {
		return MANIFEST;
	}

	validateSettings(settings: Record<string, unknown>): ValidationResult {
		const errors: Array<{ path: string; message: string }> = [];

		if (typeof settings.profile !== 'string' || !settings.profile.trim()) {
			errors.push({ path: 'profile', message: 'Hermes Profile is required' });
		}

		if (settings.maxTurns !== undefined && (typeof settings.maxTurns !== 'number' || settings.maxTurns < 1)) {
			errors.push({ path: 'maxTurns', message: 'Max Turns must be a positive number' });
		}

		return errors.length > 0 ? { valid: false, errors } : { valid: true };
	}

	async validateConnection(settings: Record<string, unknown>): Promise<ConnectionValidationResult> {
		try {
			await ensureBinary(resolveHermesRuntimeSettings(settings), this.context?.logger ?? console);
		} catch (error) {
			return {
				success: false,
				message: error instanceof Error ? error.message : 'Hermes CLI is not available.'
			};
		}

		return {
			success: true,
			message:
				'Hermes CLI is available. Make sure the selected Hermes profile has already been configured on the backend machine.'
		};
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

	getStepDefinitions(): readonly PipelineStepDefinition<HermesAgentStepId>[] {
		return STEP_DEFINITIONS;
	}

	async execute(
		directory: DirectoryReference,
		request: GenerationRequest,
		existing: ExistingItems,
		options?: PipelineExecutionOptions,
		onProgress?: PipelineProgressCallback
	): Promise<PipelineResult> {
		const startTime = Date.now();
		const abortController = new AbortController();
		const { signal, cleanup: cleanupSignal } = createExecutionSignal(abortController, options?.signal);
		const logger = this.context?.logger ?? console;
		const onLogEntry = options?.onLogEntry;
		const userId = directory.user?.id;

		if (!userId) {
			return this.handleError(new Error('User ID is required for Hermes generation'), startTime);
		}

		this.abortController = abortController;
		this.state = initializeState();

		let workspacePath: string | null = null;

		try {
			const settings = await resolveSettings(this.context, userId, directory.id);
			const runtimeSettings = resolveHermesRuntimeSettings(settings);
			const binaryPath = await this.runSetupStep(runtimeSettings, logger, onProgress, onLogEntry);

			if (signal.aborted) {
				return this.handleCancel(startTime);
			}

			workspacePath = await this.runPrepareContextStep(
				directory,
				request,
				existing,
				userId,
				onProgress,
				onLogEntry
			);

			if (signal.aborted) {
				if (workspacePath) {
					await cleanupWorkspace(workspacePath);
				}
				return this.handleCancel(startTime);
			}

			const facadeOptions: FacadeOptions = { userId, directoryId: directory.id };
			const execResult = await this.runGenerationStep(
				binaryPath,
				runtimeSettings,
				directory,
				request,
				existing,
				workspacePath,
				signal,
				options?.execContext,
				facadeOptions,
				onProgress,
				onLogEntry
			);

			if (execResult.killed || signal.aborted) {
				if (workspacePath) {
					await cleanupWorkspace(workspacePath);
				}
				return this.handleCancel(startTime);
			}

			const generationWarning =
				execResult.exitCode === 0
					? undefined
					: `Hermes finished with exit code ${execResult.exitCode}. Parsed result file will be used if valid.`;

			const items = await this.runCollectResultsStep(workspacePath, logger, onProgress, onLogEntry, execResult);
			const metadata = collectMetadataFromItems(items);

			const screenshotWarnings = await this.runScreenshotCapture(
				request,
				options?.execContext,
				items,
				userId,
				directory.id,
				signal,
				onProgress,
				logger,
				onLogEntry
			);

			await this.runCleanupStep(workspacePath, onProgress, onLogEntry);
			workspacePath = null;

			const duration = Date.now() - startTime;
			const warnings = [...(generationWarning ? [generationWarning] : []), ...screenshotWarnings];
			const completedState = finalizeCompletedState(this.state ?? initializeState());
			this.state = completedState;

			reportProgress(onProgress, 6, 100, 'Complete');

			return buildSuccessPipelineResult(
				{
					items,
					categories: buildCategoryOutputs(metadata.categories),
					tags: buildTagOutputs(metadata.tags),
					brands: buildBrandOutputs(metadata.brands),
					collections: []
				},
				{
					metrics: buildMetrics(startTime, duration, items.length),
					duration,
					stepsCompleted: completedState.completedSteps.length,
					totalSteps: HERMES_AGENT_STEP_IDS.length,
					state: completedState,
					warnings: warnings.length > 0 ? warnings : undefined
				}
			);
		} catch (error) {
			const err = error instanceof Error ? error : new Error(String(error));
			const runningStepId = this.getRunningStepId();
			if (runningStepId) {
				this.failStep(runningStepId, err, onLogEntry);
			}
			logger.error(`Hermes Agent pipeline failed: ${err.message}`);
			if (workspacePath) {
				await cleanupWorkspace(workspacePath);
			}
			return this.handleError(err, startTime);
		} finally {
			cleanupSignal();
			if (this.abortController === abortController) {
				this.abortController = null;
				this.killProcess = null;
			}
		}
	}

	async cancel(): Promise<void> {
		this.abortController?.abort();
		this.killProcess?.();
		this.killProcess = null;
	}

	getState(): PipelineState<HermesAgentStepId> | null {
		return this.state;
	}

	private async runSetupStep(
		runtimeSettings: ReturnType<typeof resolveHermesRuntimeSettings>,
		logger: { log(message: string, ...args: unknown[]): void },
		onProgress: PipelineProgressCallback | undefined,
		onLogEntry?: PipelineExecutionOptions['onLogEntry']
	): Promise<string> {
		const startedAt = this.startStep('setup-hermes', onLogEntry);
		reportProgress(onProgress, 0, 0, 'Setup Hermes');
		const binaryPath = await ensureBinary(runtimeSettings, logger);
		this.completeStep('setup-hermes', startedAt, onLogEntry);
		return binaryPath;
	}

	private async runPrepareContextStep(
		directory: DirectoryReference,
		request: GenerationRequest,
		existing: ExistingItems,
		userId: string,
		onProgress: PipelineProgressCallback | undefined,
		onLogEntry?: PipelineExecutionOptions['onLogEntry']
	): Promise<string> {
		const startedAt = this.startStep('prepare-context', onLogEntry);
		reportProgress(onProgress, 1, 20, 'Prepare Context');

		const workspacePath = await createWorkspace(userId, directory.id);
		await seedExistingItems(workspacePath, existing.items);
		await seedMetadata(workspacePath, {
			directory: { name: directory.name, description: directory.description },
			request: { prompt: request.prompt, name: request.name },
			categories: existing.categories,
			tags: existing.tags,
			brands: existing.brands
		});
		await writeResultSchema(workspacePath);

		this.completeStep('prepare-context', startedAt, onLogEntry);
		return workspacePath;
	}

	private async runGenerationStep(
		binaryPath: string,
		runtimeSettings: ReturnType<typeof resolveHermesRuntimeSettings>,
		directory: DirectoryReference,
		request: GenerationRequest,
		existing: ExistingItems,
		workspacePath: string,
		signal: AbortSignal,
		execContext: PipelineExecutionOptions['execContext'],
		facadeOptions: FacadeOptions,
		onProgress: PipelineProgressCallback | undefined,
		onLogEntry?: PipelineExecutionOptions['onLogEntry']
	): Promise<ExecuteResult> {
		const startedAt = this.startStep('generate-items', onLogEntry);
		reportProgress(onProgress, 2, 30, 'Generate Items');

		const promptFacade = execContext?.promptFacade;
		const promptInput = { directory, request, existing };

		const sysTemplate = promptFacade
			? ((await promptFacade.getPrompt(PROMPT_KEYS.SYSTEM, DEFAULT_SYSTEM_PROMPT, facadeOptions)) as string)
			: DEFAULT_SYSTEM_PROMPT;
		const systemPrompt = substituteVariables(sysTemplate, buildSystemPromptVariables(promptInput));

		const userTemplate = promptFacade
			? ((await promptFacade.getPrompt(PROMPT_KEYS.USER, DEFAULT_USER_PROMPT, facadeOptions)) as string)
			: DEFAULT_USER_PROMPT;
		const userPrompt = substituteVariables(userTemplate, buildUserPromptVariables(promptInput));

		const { promise, kill } = executeHermes({
			binaryPath,
			prompt: this.buildCombinedPrompt(systemPrompt, userPrompt),
			cwd: workspacePath,
			profile: runtimeSettings.profile,
			toolsets: runtimeSettings.toolsets,
			provider: runtimeSettings.provider,
			model: runtimeSettings.model,
			skills: runtimeSettings.skills,
			maxTurns: runtimeSettings.maxTurns,
			yolo: runtimeSettings.yolo,
			signal,
			onStdoutLine: (line) => this.emitLine(onLogEntry, 'info', line),
			onStderrLine: (line) => this.emitLine(onLogEntry, 'warn', line)
		});

		this.killProcess = kill;
		const result = await promise;
		this.killProcess = null;
		this.completeStep('generate-items', startedAt, onLogEntry);
		return result;
	}

	private async runCollectResultsStep(
		workspacePath: string,
		logger: { warn(message: string, ...args: unknown[]): void },
		onProgress: PipelineProgressCallback | undefined,
		onLogEntry: PipelineExecutionOptions['onLogEntry'] | undefined,
		execResult: ExecuteResult
	): Promise<ItemData[]> {
		const startedAt = this.startStep('collect-results', onLogEntry);
		reportProgress(onProgress, 3, 85, 'Collect Results');

		const items = await readGeneratedItems(workspacePath, logger);
		if (items.length === 0) {
			const stderrExcerpt = execResult.stderr.trim().split('\n').slice(0, 5).join('\n');
			const stdoutExcerpt = execResult.stdout.trim().split('\n').slice(-5).join('\n');
			const detail = stderrExcerpt || stdoutExcerpt || `exit code ${execResult.exitCode}`;
			throw new Error(`Hermes completed but produced no valid items. CLI output:\n${detail}`);
		}

		this.completeStep('collect-results', startedAt, onLogEntry);
		return items;
	}

	private async runScreenshotCapture(
		request: GenerationRequest,
		execContext: PipelineExecutionOptions['execContext'],
		items: ItemData[],
		userId: string,
		directoryId: string,
		signal: AbortSignal,
		onProgress: PipelineProgressCallback | undefined,
		logger: { log(...args: unknown[]): void; warn(...args: unknown[]): void },
		onLogEntry?: PipelineExecutionOptions['onLogEntry']
	): Promise<string[]> {
		const shouldCapture = Boolean((request.config || {}).capture_screenshots);
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
			return ['Screenshot provider is not configured. Enable a screenshot plugin to capture item images.'];
		}

		const startedAt = this.startStep('capture-screenshots', onLogEntry);
		reportProgress(onProgress, 4, 90, 'Capture Screenshots');

		const { status, errors } = await captureScreenshots(items, {
			screenshotFacade,
			facadeOptions: { userId, directoryId },
			signal,
			logger
		});

		if (status === 'failed') {
			this.failStep('capture-screenshots', new Error(errors[0] || 'Screenshot capture failed'), onLogEntry);
		} else {
			this.completeStep('capture-screenshots', startedAt, onLogEntry);
		}

		if (errors.length > 0) {
			return [`Screenshot capture failed for ${errors.length} item(s): ${[...new Set(errors)].join('; ')}`];
		}

		return [];
	}

	private async runCleanupStep(
		workspacePath: string,
		onProgress: PipelineProgressCallback | undefined,
		onLogEntry?: PipelineExecutionOptions['onLogEntry']
	): Promise<void> {
		const startedAt = this.startStep('cleanup', onLogEntry);
		reportProgress(onProgress, 5, 95, 'Cleanup');
		await cleanupWorkspace(workspacePath);
		this.completeStep('cleanup', startedAt, onLogEntry);
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

	private buildCombinedPrompt(systemPrompt: string, userPrompt: string): string {
		return [
			'You must follow the system instructions below exactly.',
			'',
			'<system_instructions>',
			systemPrompt,
			'</system_instructions>',
			'',
			'<user_request>',
			userPrompt,
			'</user_request>'
		].join('\n');
	}

	private emitLine(
		onLogEntry: PipelineExecutionOptions['onLogEntry'] | undefined,
		level: HermesGenerationLog['level'],
		line: string
	): void {
		if (!onLogEntry) {
			return;
		}

		const message = line.trim();
		if (!message) {
			return;
		}

		onLogEntry({
			timestamp: new Date().toISOString(),
			source: 'pipeline',
			level,
			event: 'message',
			stepIndex: STEP_CONTEXT_BY_ID.get('generate-items')?.index ?? null,
			stepName: STEP_CONTEXT_BY_ID.get('generate-items')?.name ?? null,
			message: this.truncateLogMessage(message)
		});
	}

	private startStep(
		stepId: HermesAgentStepId,
		onLogEntry?: PipelineExecutionOptions['onLogEntry']
	): number {
		if (this.state) {
			this.state = updateStepState(this.state, stepId, 'running');
		}

		const stepContext = STEP_CONTEXT_BY_ID.get(stepId);

		onLogEntry?.({
			timestamp: new Date().toISOString(),
			source: 'pipeline',
			level: 'info',
			event: 'step_started',
			stepIndex: stepContext?.index ?? null,
			stepName: stepContext?.name ?? stepId,
			message: `Step started: ${stepContext?.name ?? stepId}`
		});

		return Date.now();
	}

	private completeStep(
		stepId: HermesAgentStepId,
		stepStartedAt: number,
		onLogEntry?: PipelineExecutionOptions['onLogEntry']
	): void {
		if (this.state) {
			this.state = updateStepState(this.state, stepId, 'completed');
		}

		const stepContext = STEP_CONTEXT_BY_ID.get(stepId);

		onLogEntry?.({
			timestamp: new Date().toISOString(),
			source: 'pipeline',
			level: 'info',
			event: 'step_completed',
			stepIndex: stepContext?.index ?? null,
			stepName: stepContext?.name ?? stepId,
			message: `Step completed: ${stepContext?.name ?? stepId}`,
			durationMs: Date.now() - stepStartedAt
		});
	}

	private failStep(
		stepId: HermesAgentStepId,
		error: Error,
		onLogEntry?: PipelineExecutionOptions['onLogEntry']
	): void {
		if (this.state) {
			this.state = updateStepState(this.state, stepId, 'failed', error.message);
		}

		const stepContext = STEP_CONTEXT_BY_ID.get(stepId);

		onLogEntry?.({
			timestamp: new Date().toISOString(),
			source: 'pipeline',
			level: 'error',
			event: 'step_failed',
			stepIndex: stepContext?.index ?? null,
			stepName: stepContext?.name ?? stepId,
			message: error.message
		});
	}

	private skipStep(
		stepId: HermesAgentStepId,
		message: string,
		onLogEntry?: PipelineExecutionOptions['onLogEntry']
	): void {
		if (this.state) {
			this.state = updateStepState(this.state, stepId, 'skipped');
		}

		const stepContext = STEP_CONTEXT_BY_ID.get(stepId);

		onLogEntry?.({
			timestamp: new Date().toISOString(),
			source: 'pipeline',
			level: 'info',
			event: 'message',
			stepIndex: stepContext?.index ?? null,
			stepName: stepContext?.name ?? stepId,
			message
		});
	}

	private getRunningStepId(): HermesAgentStepId | null {
		if (!this.state?.currentStep) {
			return null;
		}
		return this.state.currentStep as HermesAgentStepId;
	}

	private truncateLogMessage(message: string): string {
		if (message.length <= LOG_MESSAGE_MAX_LENGTH) {
			return message;
		}
		return `${message.slice(0, LOG_MESSAGE_MAX_LENGTH - 3)}...`;
	}
}

export default HermesAgentPlugin;
