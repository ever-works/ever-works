import { generateText, stepCountIs } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type {
	IPlugin,
	IPipelinePlugin,
	IFormSchemaProvider,
	PluginContext,
	PluginCategory,
	JsonSchema,
	ValidationResult,
	PluginSettings,
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
	FacadeOptions,
	FormFieldDefinition,
	FormFieldGroup
} from '@ever-works/plugin';
import { collectMetadataFromItems } from '@ever-works/plugin';

import type { AgentPipelineStepId } from './types.js';
import { AGENT_PIPELINE_STEP_IDS, DEFAULT_MAX_STEPS } from './types.js';
import { STEP_DEFINITIONS } from './steps.js';
import {
	getFormFields as formFields,
	getFormGroups as formGroups,
	validateFormInput as formValidate,
	getDefaultValues as formDefaults
} from './form-schema.js';
import { buildSystemPrompt, buildUserPrompt } from './prompt/system-prompt.js';
import { createAgentTools } from './tools/agent-tools.js';
import { createWorkspace, collectItemsFromWorkspace, cleanupWorkspace } from './utils/sandbox-workspace.js';
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

/**
 * Agent Pipeline Plugin
 *
 * Self-managed pipeline that runs a single AI agent loop with tools
 * for web search, content extraction, and file management.
 */
export class AgentPipelinePlugin implements IPlugin, IPipelinePlugin<AgentPipelineStepId>, IFormSchemaProvider {
	readonly id = 'agent-pipeline';
	readonly name = 'Agent Pipeline';
	readonly version = '1.0.0';
	readonly category: PluginCategory = 'pipeline';
	readonly capabilities = ['pipeline', 'form-schema-provider'] as const;
	readonly configurationMode = 'hybrid' as const;
	readonly handledConfigFields = ['*'] as const;

	readonly settingsSchema: JsonSchema = {
		type: 'object',
		properties: {
			maxSteps: {
				type: 'integer',
				title: 'Max Steps',
				description: 'Maximum number of agent tool-calling steps',
				default: DEFAULT_MAX_STEPS,
				minimum: 10,
				maximum: 2000,
				'x-hidden': true
			}
		}
	};

	private context: PluginContext | null = null;
	private state: PipelineState<AgentPipelineStepId> | null = null;
	private abortController: AbortController | null = null;

	// ── IPlugin lifecycle ──────────────────────────────────────────────

	async onLoad(context: PluginContext): Promise<void> {
		this.context = context;
		context.logger.log('Agent Pipeline plugin loaded');
	}

	async onUnload(): Promise<void> {
		await this.cancel();
		this.context = null;
	}

	async validateSettings(_settings: PluginSettings): Promise<ValidationResult> {
		return { valid: true };
	}

	async healthCheck(): Promise<PluginHealthCheck> {
		return {
			status: 'healthy',
			message: 'Agent Pipeline plugin is ready',
			checkedAt: Date.now()
		};
	}

	getManifest(): PluginManifest {
		return {
			id: this.id,
			name: this.name,
			version: this.version,
			description:
				'Autonomous tool-based pipeline that researches and generates directory items using an AI agent with web search, content extraction, and file management capabilities',
			category: this.category,
			capabilities: [...this.capabilities],
			author: { name: 'Ever Works Team' },
			license: 'MIT',
			builtIn: true,
			autoEnable: false,
			visibility: 'public',
			selectableProviderCategories: ['ai-provider', 'search', 'screenshot', 'content-extractor'],
			readme: [
				'# Agent Pipeline Plugin',
				'',
				'Autonomous tool-based pipeline that researches and generates directory items.',
				'',
				'## How it works',
				'',
				'1. **Prepare Context** - Loads existing items and metadata',
				'2. **Generate Items** - AI agent researches and creates items',
				'3. **Collect Results** - Gathers generated items',
				'4. **Capture Screenshots** - Takes screenshots for items that need images',
				'5. **Cleanup** - Releases resources'
			].join('\n')
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

	getStepDefinitions(): readonly PipelineStepDefinition<AgentPipelineStepId>[] {
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
		this.abortController = new AbortController();
		const signal = options?.signal ?? this.abortController.signal;

		this.state = initializeState();

		const logger = this.context?.logger ?? console;
		const execContext = options?.execContext;

		if (!execContext) {
			return this.handleError(
				new Error('Execution context (execContext) is required for agent-pipeline'),
				startTime
			);
		}

		const userId = execContext.user?.id ?? directory.user?.id;
		if (!userId) {
			return this.handleError(new Error('User ID is required'), startTime);
		}

		const facadeOptions: FacadeOptions = { userId, directoryId: directory.id };

		try {
			// ── Step 1: Prepare Context ────────────────────────────────
			this.setState('prepare-context', 'running');
			reportProgress(onProgress, 0, 10, 'Prepare Context');

			const providerConfig = await execContext.aiFacade.getProviderConfig(facadeOptions);
			if (!providerConfig.baseUrl || !providerConfig.apiKey) {
				return this.handleError(
					new Error(
						`AI provider "${providerConfig.providerId}" missing baseUrl or apiKey. ` +
							'Please configure the AI provider settings.'
					),
					startTime
				);
			}

			const modelName = providerConfig.routing.complexModel || providerConfig.defaultModel;
			if (!modelName) {
				return this.handleError(
					new Error(
						`AI provider "${providerConfig.providerId}" has no model configured. ` +
							'Set a defaultModel or complexModel in provider settings.'
					),
					startTime
				);
			}

			// Create a sandboxed workspace for the agent to read/write files
			const workspacePath = await createWorkspace(userId, directory.id, existing, directory, request);

			this.setState('prepare-context', 'completed');
			if (signal.aborted) return this.handleCancel(startTime);

			// ── Step 2: Generate Items ─────────────────────────────────
			this.setState('generate-items', 'running');
			reportProgress(onProgress, 1, 20, 'Generate Items');

			logger.log(`Using AI provider "${providerConfig.providerName}" with model "${modelName}"`);

			const provider = createOpenAICompatible({
				name: providerConfig.providerId,
				baseURL: providerConfig.baseUrl,
				apiKey: providerConfig.apiKey
			});
			const model = provider(modelName);

			const { tools } = await createAgentTools(
				workspacePath,
				{
					searchFacade: execContext.searchFacade,
					contentExtractorFacade: execContext.contentExtractorFacade
				},
				facadeOptions,
				onProgress,
				AGENT_PIPELINE_STEP_IDS.length
			);

			const promptOptions = { directory, request, existing };
			const systemPrompt = buildSystemPrompt(promptOptions);
			const userPrompt = buildUserPrompt(promptOptions);

			const settings = await resolveSettings(this.context, userId, directory.id);
			const maxSteps = (settings.maxSteps as number) || DEFAULT_MAX_STEPS;

			await generateText({
				model,
				system: systemPrompt,
				prompt: userPrompt,
				tools: tools as Parameters<typeof generateText>[0]['tools'],
				stopWhen: stepCountIs(maxSteps),
				abortSignal: signal
			});

			if (signal.aborted) {
				this.setState('generate-items', 'failed', 'Cancelled');
				return this.handleCancel(startTime);
			}

			this.setState('generate-items', 'completed');

			// ── Step 3: Collect Results ────────────────────────────────
			this.setState('collect-results', 'running');
			reportProgress(onProgress, 2, 82, 'Collect Results');

			const items = await collectItemsFromWorkspace(workspacePath, logger);
			const metadata = collectMetadataFromItems(items);
			this.setState('collect-results', 'completed');

			// ── Step 4: Capture Screenshots ────────────────────────────
			const config = request.config || {};
			const shouldCapture = config.capture_screenshots !== false;

			if (shouldCapture && execContext.screenshotFacade.isAvailable() && items.length > 0 && !signal.aborted) {
				this.setState('capture-screenshots', 'running');
				reportProgress(onProgress, 3, 85, 'Capture Screenshots');

				const status = await captureScreenshots(items, {
					screenshotFacade: execContext.screenshotFacade,
					facadeOptions,
					signal,
					logger
				});
				this.setState('capture-screenshots', status);
			} else {
				this.setState('capture-screenshots', 'skipped' as StepStatus);
			}

			// ── Step 5: Cleanup ────────────────────────────────────────
			this.setState('cleanup', 'running');
			reportProgress(onProgress, 4, 95, 'Cleanup');

			await cleanupWorkspace(userId, directory.id);

			this.setState('cleanup', 'completed');

			// ── Build result ───────────────────────────────────────────
			reportProgress(onProgress, 5, 100, 'Complete');

			const duration = Date.now() - startTime;
			return {
				success: items.length > 0,
				items,
				categories: metadata.categories,
				tags: metadata.tags,
				brands: metadata.brands,
				metrics: buildMetrics(startTime, duration, items.length),
				duration,
				stepsCompleted: AGENT_PIPELINE_STEP_IDS.length,
				totalSteps: AGENT_PIPELINE_STEP_IDS.length,
				state: this.state!
			};
		} catch (error) {
			const err = error instanceof Error ? error : new Error(String(error));
			logger.error(`Agent pipeline failed: ${err.message}`);
			await cleanupWorkspace(userId, directory.id);
			return this.handleError(err, startTime);
		}
	}

	async cancel(): Promise<void> {
		this.abortController?.abort();
	}

	getState(): PipelineState<AgentPipelineStepId> | null {
		return this.state;
	}

	// ── Private helpers ────────────────────────────────────────────────

	private setState(stepId: AgentPipelineStepId, status: StepStatus, error?: string): void {
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

export default AgentPipelinePlugin;
