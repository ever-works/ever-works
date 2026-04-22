import type {
	IPlugin,
	IPipelinePlugin,
	IFormSchemaProvider,
	PluginContext,
	PluginCategory,
	JsonSchema,
	ValidationResult,
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
	ConnectionValidationResult,
	FacadeOptions
} from '@ever-works/plugin';
import { buildSuccessPipelineResult, substituteVariables } from '@ever-works/plugin';

import type { OpenCodeStepId } from './types.js';
import { OPENCODE_STEP_IDS, DEFAULT_CLI_VERSION } from './types.js';
import { STEP_DEFINITIONS } from './steps.js';
import { ensureBinary } from './utils/binary-manager.js';
import {
	createWorkspace,
	seedExistingItems,
	seedMetadata,
	readGeneratedItems,
	collectMetadataFromItems,
	cleanupWorkspace
} from './utils/workspace-manager.js';
import { executeOpenCode, type ExecuteResult } from './utils/process-runner.js';
import {
	buildSystemPromptVariables,
	buildUserPromptVariables,
	DEFAULT_SYSTEM_PROMPT,
	DEFAULT_USER_PROMPT
} from './prompt/system-prompt.js';
import { PROMPT_KEYS } from './prompt-keys.js';
import { startTaxonomyWatcher } from './utils/taxonomy-watcher.js';
import { captureScreenshots } from './utils/screenshot-capture.js';
import {
	initializeState,
	updateStepState,
	reportProgress,
	reportItemProgress,
	resolveSettings,
	buildMetrics,
	buildErrorResult,
	buildCancelledResult,
	finalizeCompletedState
} from './utils/pipeline-helpers.js';
import { prepareOpenCodeSessionConfig, cleanupOpenCodeSessionConfig } from './utils/opencode-config.js';
import {
	getFormFields as formFields,
	getFormGroups as formGroups,
	validateFormInput as formValidate,
	getDefaultValues as formDefaults,
	DEFAULT_TARGET_ITEMS
} from './form-schema.js';

const LOG_MESSAGE_MAX_LENGTH = 500;
const STEP_CONTEXT_BY_ID = new Map(
	STEP_DEFINITIONS.map((step, stepIndex) => [step.id, { stepIndex, stepName: step.name }])
);
type OpenCodeGenerationLog = Parameters<NonNullable<PipelineExecutionOptions['onLogEntry']>>[0];

interface OpenCodeLogOptions {
	readonly onLogEntry?: PipelineExecutionOptions['onLogEntry'];
	readonly event: OpenCodeGenerationLog['event'];
	readonly level: OpenCodeGenerationLog['level'];
	readonly message: string;
	readonly stepId?: OpenCodeStepId;
	readonly durationMs?: number;
}

/**
 * OpenCode Generator Plugin
 *
 * Full pipeline plugin that delegates the entire generation to OpenCode.
 * Runs a single OpenCode session that handles web search,
 * content creation, and file generation autonomously.
 */
export class OpenCodePlugin implements IPlugin, IPipelinePlugin, IFormSchemaProvider {
	readonly id = 'opencode';
	readonly name = 'OpenCode Generator';
	readonly version = '1.0.0';
	readonly category: PluginCategory = 'pipeline';
	readonly capabilities = ['pipeline', 'form-schema-provider'] as const;
	readonly configurationMode = 'user-required' as const;
	readonly handledConfigFields = ['*'] as const;

	readonly settingsSchema: JsonSchema = {
		type: 'object',
		properties: {
			version: {
				type: 'string',
				title: 'CLI Version',
				description: 'OpenCode CLI version to use',
				default: DEFAULT_CLI_VERSION,
				'x-hidden': true
			}
		}
	};

	private context: PluginContext | null = null;
	private state: PipelineState<OpenCodeStepId> | null = null;
	private abortController: AbortController | null = null;
	private killProcess: (() => void) | null = null;

	// ── IPlugin lifecycle ──────────────────────────────────────────────

	async onLoad(context: PluginContext): Promise<void> {
		this.context = context;
		context.logger.log('OpenCode Generator plugin loaded');
	}

	async onUnload(): Promise<void> {
		await this.cancel();
		this.context = null;
	}

	async healthCheck(): Promise<PluginHealthCheck> {
		return {
			status: 'healthy',
			message: 'OpenCode Generator plugin is ready',
			checkedAt: Date.now()
		};
	}

	async listModels(): Promise<readonly []> {
		return [];
	}

	async isAvailable(settings?: Record<string, unknown>): Promise<boolean> {
		return typeof settings?.version === 'undefined' || typeof settings.version === 'string';
	}

	async validateConnection(settings: Record<string, unknown>): Promise<ConnectionValidationResult> {
		if (settings.version !== undefined && typeof settings.version !== 'string') {
			return { success: false, message: 'CLI Version must be a string when provided.' };
		}

		return {
			success: false,
			message:
				'OpenCode uses the active directory AI provider for credentials and model routing. Verify the directory AI provider configuration to confirm this pipeline is runnable.'
		};
	}

	validateSettings(settings: Record<string, unknown>): ValidationResult {
		if (settings.version !== undefined && (typeof settings.version !== 'string' || !settings.version.trim())) {
			return {
				valid: false,
				errors: [
					{
						path: 'version',
						message: 'CLI Version must be a non-empty string when provided.'
					}
				]
			};
		}
		return { valid: true };
	}

	getManifest(): PluginManifest {
		return {
			id: this.id,
			name: this.name,
			version: this.version,
			description: 'Full pipeline plugin that delegates the entire generation to OpenCode',
			category: this.category,
			capabilities: [...this.capabilities],
			author: { name: 'Ever Works Team' },
			license: 'MIT',
			builtIn: true,
			autoEnable: false,
			visibility: 'public',
			selectableProviderCategories: ['ai-provider', 'screenshot'],
			uiHints: {
				onboardingWizard: false,
				includeInOnboarding: false
			},
			readme: [
				'# OpenCode Generator Plugin',
				'',
				'Use OpenCode as the pipeline engine for directory generation inside Ever Works.',
				'',
				'OpenCode researches sources and generates structured directory items by using the AI provider configured for the directory in Ever Works.',
				'',
				'Choose this plugin when you want OpenCode-style generation while keeping provider credentials managed by your existing Ever Works AI provider setup.',
				'',
				'## What It Does',
				'',
				'- Researches sources for the current directory topic.',
				'- Generates structured item data for Ever Works.',
				'- Reuses your directory context and existing items during generation.',
				'- Can work with screenshot providers for item imagery.',
				'',
				'## Provider Model',
				'',
				'OpenCode does not ask for its own API key in plugin settings.',
				'It uses the active Ever Works `ai-provider` configured for the directory.',
				'',
				'## Usage',
				'',
				'1. Configure an `ai-provider` for the directory.',
				'2. Enable the OpenCode plugin.',
				'3. Select `opencode` as the pipeline provider for generation.'
			].join('\n'),
			homepage: 'https://opencode.ai/docs/cli/',
			icon: {
				type: 'svg',
				value: `<svg width='240' height='300' viewBox='0 0 240 300' fill='none' xmlns='http://www.w3.org/2000/svg'><g clip-path='url(#clip0_1401_86283)'><mask id='mask0_1401_86283' style='mask-type:luminance' maskUnits='userSpaceOnUse' x='0' y='0' width='240' height='300'><path d='M240 0H0V300H240V0Z' fill='white'/></mask><g mask='url(#mask0_1401_86283)'><path d='M180 240H60V120H180V240Z' fill='#4B4646'/><path d='M180 60H60V240H180V60ZM240 300H0V0H240V300Z' fill='#F1ECEC'/></g></g><defs><clipPath id='clip0_1401_86283'><rect width='240' height='300' fill='white'/></clipPath></defs></svg>`
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

	async execute(
		directory: DirectoryReference,
		request: GenerationRequest,
		existing: ExistingItems,
		options?: PipelineExecutionOptions,
		onProgress?: PipelineProgressCallback
	): Promise<PipelineResult> {
		const startTime = Date.now();
		const execContext = options?.execContext;
		if (!execContext) {
			return this.handleError(new Error('Execution context (execContext) is required for opencode'), startTime);
		}

		const userId = execContext.user?.id ?? directory.user?.id;
		if (!userId) {
			return this.handleError(new Error('User ID is required'), startTime);
		}

		if (this.abortController) {
			return this.handleError(
				new Error(
					'OpenCode Generator is already executing another generation. Wait for it to finish or cancel it first.'
				),
				startTime
			);
		}

		const abortController = new AbortController();
		this.abortController = abortController;
		const signal = options?.signal ?? abortController.signal;
		const onLogEntry = options?.onLogEntry;

		this.state = initializeState();

		const logger = this.context?.logger ?? console;
		const facadeOptions: FacadeOptions = { userId, directoryId: directory.id };
		let sessionConfig: Awaited<ReturnType<typeof prepareOpenCodeSessionConfig>> | null = null;
		let workspacePath: string | null = null;

		try {
			const settings = await resolveSettings(this.context, userId, directory.id);
			const version = (settings.version as string) || DEFAULT_CLI_VERSION;
			const { providerConfig, modelName } = await this.resolveAiProvider(execContext, facadeOptions);

			if (!providerConfig || !modelName) {
				return this.handleError(
					new Error(
						providerConfig
							? `AI provider "${providerConfig.providerId}" has no model configured. Set a defaultModel or complexModel in provider settings.`
							: 'AI provider missing baseUrl or apiKey. Please configure the AI provider settings.'
					),
					startTime
				);
			}

			logger.log(`Using AI provider "${providerConfig.providerName}" with model "${modelName}" for this session`);

			// ── Step 1: Setup OpenCode ──────────────────────────────
			const setupStepStartedAt = this.startStep('setup-opencode', onLogEntry);
			reportProgress(onProgress, 0, 0, 'Setup OpenCode');

			const binaryPath = await ensureBinary(version, logger, signal);
			this.completeStep('setup-opencode', setupStepStartedAt, onLogEntry);

			if (signal.aborted) {
				if (workspacePath) {
					await cleanupWorkspace(workspacePath);
					workspacePath = null;
				}
				return this.handleCancel(startTime);
			}

			// ── Step 2: Prepare Context ────────────────────────────────
			const prepareContextStepStartedAt = this.startStep('prepare-context', onLogEntry);
			reportProgress(onProgress, 1, 20, 'Prepare Context');

			workspacePath = await createWorkspace(userId, directory.id);
			sessionConfig = await prepareOpenCodeSessionConfig({
				userId,
				directoryId: directory.id,
				providerConfig,
				model: modelName
			});
			await seedExistingItems(workspacePath, existing.items);
			await seedMetadata(workspacePath, {
				directory: { name: directory.name, description: directory.description },
				request: { prompt: request.prompt, name: request.name },
				categories: existing.categories,
				tags: existing.tags,
				brands: existing.brands
			});
			this.completeStep('prepare-context', prepareContextStepStartedAt, onLogEntry);

			if (signal.aborted) {
				if (workspacePath) {
					await cleanupWorkspace(workspacePath);
					workspacePath = null;
				}
				if (sessionConfig) {
					await cleanupOpenCodeSessionConfig(sessionConfig.sessionDir);
					sessionConfig = null;
				}
				return this.handleCancel(startTime);
			}

			// ── Step 3: Generate Items ─────────────────────────────────
			const generateItemsStepStartedAt = this.startStep('generate-items', onLogEntry);
			reportProgress(onProgress, 2, 30, 'Generate Items');

			const promptOptions = { directory, request, existing, workspacePath };
			const promptFacade = execContext?.promptFacade;

			const sysTemplate = (
				promptFacade
					? await promptFacade.getPrompt(PROMPT_KEYS.SYSTEM, DEFAULT_SYSTEM_PROMPT, facadeOptions)
					: DEFAULT_SYSTEM_PROMPT
			) as typeof DEFAULT_SYSTEM_PROMPT;
			const systemPrompt = substituteVariables(sysTemplate, buildSystemPromptVariables(promptOptions));

			const userTemplate = (
				promptFacade
					? await promptFacade.getPrompt(PROMPT_KEYS.USER, DEFAULT_USER_PROMPT, facadeOptions)
					: DEFAULT_USER_PROMPT
			) as typeof DEFAULT_USER_PROMPT;
			const userPrompt = substituteVariables(userTemplate, buildUserPromptVariables(promptOptions));

			const targetItems = ((request.config || {}).target_items as number) || DEFAULT_TARGET_ITEMS;

			const taxonomyWatcher = startTaxonomyWatcher({
				workspacePath,
				logger,
				onNewItem: (newItemCount) => {
					reportItemProgress(onProgress, newItemCount, targetItems, 2);
				}
			});

			let execResult: ExecuteResult;
			try {
				const { onStdoutLine, onStderrLine } = this.createOpenCodeStreamHandlers(onLogEntry);

				const { promise, kill } = executeOpenCode({
					binaryPath,
					prompt: this.buildCombinedPrompt(systemPrompt, userPrompt),
					cwd: workspacePath,
					env: sessionConfig.env,
					model: sessionConfig.model,
					signal,
					onStdoutLine,
					onStderrLine
				});

				this.killProcess = kill;
				execResult = await promise;
				this.killProcess = null;
			} finally {
				taxonomyWatcher.stop();
			}

			if (execResult.killed || signal.aborted) {
				this.failStep('generate-items', new Error('Cancelled'), onLogEntry);
				if (workspacePath) {
					await cleanupWorkspace(workspacePath);
					workspacePath = null;
				}
				if (sessionConfig) {
					await cleanupOpenCodeSessionConfig(sessionConfig.sessionDir);
					sessionConfig = null;
				}
				return this.handleCancel(startTime);
			}

			let generationWarning: string | undefined;
			if (execResult.exitCode !== 0) {
				const detail = this.extractErrorDetail(execResult);

				logger.warn(`OpenCode exited with code ${execResult.exitCode}: ${detail}`);
				generationWarning = `OpenCode finished with an error (${detail}).`;
				this.emitOpenCodeLog({
					onLogEntry,
					stepId: 'generate-items',
					event: 'message',
					level: 'warn',
					message: generationWarning
				});
			}

			this.completeStep('generate-items', generateItemsStepStartedAt, onLogEntry);

			// ── Step 4: Collect Results ────────────────────────────────
			const collectResultsStepStartedAt = this.startStep('collect-results', onLogEntry);
			reportProgress(onProgress, 3, 85, 'Collect Results');

			const items = await readGeneratedItems(workspacePath, logger);

			if (items.length === 0) {
				const stderrExcerpt = execResult.stderr?.trim().split('\n').slice(0, 5).join('\n') || '';
				const stdoutExcerpt = execResult.stdout?.trim().split('\n').slice(-5).join('\n') || '';
				const detail = stderrExcerpt || stdoutExcerpt || `exit code ${execResult.exitCode}`;
				throw new Error(`OpenCode completed but produced no valid item files. CLI output:\n${detail}`);
			}

			const metadata = collectMetadataFromItems(items);
			this.completeStep('collect-results', collectResultsStepStartedAt, onLogEntry);

			// ── Step 5: Capture Screenshots ────────────────────────────
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

			// ── Step 6: Cleanup ────────────────────────────────────────
			const cleanupStepStartedAt = this.startStep('cleanup', onLogEntry);
			reportProgress(onProgress, 5, 95, 'Cleanup');

			if (workspacePath) {
				await cleanupWorkspace(workspacePath);
				workspacePath = null;
			}
			if (sessionConfig) {
				await cleanupOpenCodeSessionConfig(sessionConfig.sessionDir);
				sessionConfig = null;
			}
			this.completeStep('cleanup', cleanupStepStartedAt, onLogEntry);

			if (signal.aborted) {
				return this.handleCancel(startTime);
			}

			// ── Build result ───────────────────────────────────────────
			reportProgress(onProgress, 6, 100, 'Complete');

			const duration = Date.now() - startTime;
			const warnings = [...(generationWarning ? [generationWarning] : []), ...screenshotWarnings];
			this.state = finalizeCompletedState(this.state!);

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
					stepsCompleted: this.state!.completedSteps.length,
					totalSteps: OPENCODE_STEP_IDS.length,
					state: this.state!,
					warnings: warnings.length > 0 ? warnings : undefined
				}
			);
		} catch (error) {
			const err = error instanceof Error ? error : new Error(String(error));
			const runningStepId = this.getRunningStepId();
			if (runningStepId) {
				this.failStep(runningStepId, err, onLogEntry);
			}
			logger.error(`OpenCode pipeline failed: ${err.message}`);
			if (workspacePath) {
				await cleanupWorkspace(workspacePath);
			}
			if (sessionConfig) {
				await cleanupOpenCodeSessionConfig(sessionConfig.sessionDir);
			}
			return this.handleError(err, startTime);
		} finally {
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

	getState(): PipelineState<OpenCodeStepId> | null {
		return this.state;
	}

	// ── Private helpers ────────────────────────────────────────────────

	private async resolveAiProvider(
		execContext: NonNullable<PipelineExecutionOptions['execContext']>,
		facadeOptions: FacadeOptions
	): Promise<{
		providerConfig: Awaited<ReturnType<typeof execContext.aiFacade.getProviderConfig>> | null;
		modelName: string | null;
	}> {
		const providerConfig = await execContext.aiFacade.getProviderConfig(facadeOptions);
		if (!providerConfig.baseUrl || !providerConfig.apiKey) {
			return { providerConfig: null, modelName: null };
		}

		const modelName = providerConfig.routing.complexModel || providerConfig.defaultModel;
		if (!modelName) {
			return { providerConfig, modelName: null };
		}

		return { providerConfig, modelName };
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

		const captureScreenshotsStepStartedAt = this.startStep('capture-screenshots', onLogEntry);
		reportProgress(onProgress, 4, 87, 'Capture Screenshots');

		const { status, errors } = await captureScreenshots(items, {
			screenshotFacade,
			facadeOptions: { userId, directoryId },
			signal,
			logger
		});

		if (status === 'failed') {
			this.failStep('capture-screenshots', new Error(errors[0] || 'Screenshot capture failed'), onLogEntry);
		} else {
			this.completeStep('capture-screenshots', captureScreenshotsStepStartedAt, onLogEntry);
		}

		if (errors.length > 0) {
			const facadeOptions = { userId, directoryId };
			const providerName = await screenshotFacade.getActiveProviderName?.(facadeOptions);
			const label = providerName ? `Screenshot capture (${providerName})` : 'Screenshot capture';
			const unique = [...new Set(errors)];
			return [`${label} failed for ${errors.length} item(s): ${unique.join('; ')}`];
		}
		return [];
	}

	private createOpenCodeStreamHandlers(onLogEntry?: PipelineExecutionOptions['onLogEntry']): {
		onStdoutLine?: (line: string) => void;
		onStderrLine?: (line: string) => void;
	} {
		if (!onLogEntry) {
			return {};
		}

		return {
			onStdoutLine: (line: string) => {
				const logEntry = this.buildOpenCodeLogFromStdout(line);
				if (!logEntry) {
					return;
				}

				this.emitOpenCodeLog({ onLogEntry, ...logEntry });
			},
			onStderrLine: (line: string) => {
				this.emitOpenCodeLog({
					onLogEntry,
					stepId: 'generate-items',
					event: 'message',
					level: 'error',
					message: this.truncateLogMessage(line)
				});
			}
		};
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

	private buildOpenCodeLogFromStdout(line: string): Omit<OpenCodeLogOptions, 'onLogEntry'> | null {
		const trimmedLine = line.trim();
		if (!trimmedLine) {
			return null;
		}

		try {
			const event = JSON.parse(trimmedLine) as Record<string, unknown>;
			const type = this.extractString(event.type);

			switch (type) {
				case 'assistant': {
					const text = this.extractOpenCodeContentText(
						(event.message as { content?: unknown } | undefined)?.content
					);
					return text
						? {
								stepId: 'generate-items',
								event: 'message',
								level: 'info',
								message: text
							}
						: null;
				}
				case 'tool_use': {
					const toolName = this.extractString(event.tool) || this.extractString(event.name) || 'unknown';
					return {
						stepId: 'generate-items',
						event: 'message',
						level: 'info',
						message: `Tool started: ${toolName}`
					};
				}
				case 'tool_result': {
					const toolName = this.extractString(event.tool) || this.extractString(event.name) || 'unknown';
					const toolOutput =
						this.extractString(event.result) ||
						this.extractString((event.result as { content?: unknown } | undefined)?.content);
					return {
						stepId: 'generate-items',
						event: 'message',
						level: 'info',
						message: toolOutput
							? `Tool finished: ${toolName} (${toolOutput})`
							: `Tool finished: ${toolName}`
					};
				}
				case 'result': {
					const detail =
						this.extractString(event.result) ||
						this.extractString(event.error) ||
						'OpenCode session completed';
					return {
						stepId: 'generate-items',
						event: 'message',
						level: event.is_error === true ? 'warn' : 'info',
						message: event.is_error === true ? `OpenCode result: ${detail}` : detail
					};
				}
				case 'error': {
					const detail =
						this.extractString((event.error as { message?: unknown } | undefined)?.message) ||
						this.extractString(event.message) ||
						this.extractString(event.error) ||
						'OpenCode reported an error';
					return {
						stepId: 'generate-items',
						event: 'message',
						level: 'error',
						message: detail
					};
				}
				default: {
					const message =
						this.extractString(event.message) ||
						this.extractString(event.summary) ||
						(type ? `OpenCode event: ${type}` : undefined);
					return message
						? {
								stepId: 'generate-items',
								event: 'message',
								level: 'info',
								message
							}
						: null;
				}
			}
		} catch {
			return {
				stepId: 'generate-items',
				event: 'message',
				level: 'info',
				message: trimmedLine
			};
		}
	}

	private extractOpenCodeContentText(content: unknown): string | undefined {
		if (typeof content === 'string') {
			return this.truncateLogMessage(content);
		}

		if (!Array.isArray(content)) {
			return undefined;
		}

		const text = content
			.filter((part): part is { type?: string; text?: string } => typeof part === 'object' && part !== null)
			.filter((part) => part.type === 'text' && typeof part.text === 'string')
			.map((part) => part.text!.trim())
			.filter(Boolean)
			.join(' ');

		return text ? this.truncateLogMessage(text) : undefined;
	}

	private extractString(value: unknown): string | undefined {
		if (typeof value === 'string') {
			const trimmedValue = value.trim();
			return trimmedValue ? this.truncateLogMessage(trimmedValue) : undefined;
		}

		if (typeof value === 'number' || typeof value === 'boolean') {
			return this.truncateLogMessage(String(value));
		}

		return undefined;
	}

	private truncateLogMessage(message: string): string {
		return message.trim().slice(0, LOG_MESSAGE_MAX_LENGTH);
	}

	private startStep(stepId: OpenCodeStepId, onLogEntry?: PipelineExecutionOptions['onLogEntry']): number {
		this.setState(stepId, 'running');
		this.emitOpenCodeLog({
			onLogEntry,
			stepId,
			event: 'step_started',
			level: 'info',
			message: this.getStepName(stepId)
		});
		return Date.now();
	}

	private completeStep(
		stepId: OpenCodeStepId,
		startedAt: number,
		onLogEntry?: PipelineExecutionOptions['onLogEntry']
	): void {
		this.setState(stepId, 'completed');
		this.emitOpenCodeLog({
			onLogEntry,
			stepId,
			event: 'step_completed',
			level: 'info',
			message: this.getStepName(stepId),
			durationMs: Date.now() - startedAt
		});
	}

	private failStep(stepId: OpenCodeStepId, error: Error, onLogEntry?: PipelineExecutionOptions['onLogEntry']): void {
		this.setState(stepId, 'failed', error.message);
		this.emitOpenCodeLog({
			onLogEntry,
			stepId,
			event: 'step_failed',
			level: 'error',
			message: `${this.getStepName(stepId)}: ${this.truncateLogMessage(error.message)}`
		});
	}

	private skipStep(
		stepId: OpenCodeStepId,
		message: string,
		onLogEntry?: PipelineExecutionOptions['onLogEntry']
	): void {
		this.setState(stepId, 'skipped' as StepStatus);
		this.emitOpenCodeLog({
			onLogEntry,
			stepId,
			event: 'step_skipped',
			level: 'info',
			message: this.truncateLogMessage(message)
		});
	}

	private emitOpenCodeLog({ onLogEntry, stepId, message, ...log }: OpenCodeLogOptions): void {
		if (!onLogEntry) {
			return;
		}

		const stepContext = stepId ? STEP_CONTEXT_BY_ID.get(stepId) : undefined;

		onLogEntry({
			timestamp: new Date().toISOString(),
			source: 'pipeline',
			message: this.truncateLogMessage(message),
			stepIndex: stepContext?.stepIndex ?? null,
			stepName: stepContext?.stepName ?? null,
			...log
		});
	}

	private getStepName(stepId: OpenCodeStepId): string {
		return STEP_CONTEXT_BY_ID.get(stepId)?.stepName ?? stepId;
	}

	private getRunningStepId(): OpenCodeStepId | undefined {
		if (!this.state) {
			return undefined;
		}

		for (const stepId of OPENCODE_STEP_IDS) {
			const status = this.state.steps.get(stepId)?.status;
			if (status === 'running') {
				return stepId;
			}
		}

		return undefined;
	}

	private extractErrorDetail(result: ExecuteResult): string {
		// When stream-json is active, stderr may be empty and stdout is NDJSON.
		// Try to find the actual error from a result event or stderr.
		if (result.stderr?.trim()) {
			return result.stderr.trim().split('\n')[0].slice(0, 500);
		}

		// Parse NDJSON stdout for a result event with error info
		if (result.stdout) {
			const lines = result.stdout.split('\n');
			for (let i = lines.length - 1; i >= 0; i--) {
				try {
					const event = JSON.parse(lines[i]);
					if (event.type === 'result' && event.is_error) {
						return (event.error || event.result || 'unknown error').slice(0, 500);
					}
					if (event.type === 'error') {
						return (
							event.error?.message ||
							event.message ||
							JSON.stringify(event.error) ||
							'unknown error'
						).slice(0, 500);
					}
				} catch {
					// not JSON
				}
			}
		}

		// No structured error found — use raw stdout as last resort
		if (result.stdout?.trim()) {
			return result.stdout.trim().split('\n')[0].slice(0, 500);
		}

		return `exit code ${result.exitCode}`;
	}

	private setState(stepId: OpenCodeStepId, status: StepStatus, error?: string): void {
		if (this.state) {
			this.state = updateStepState(this.state, stepId, status, error);
		}
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
}

export default OpenCodePlugin;
