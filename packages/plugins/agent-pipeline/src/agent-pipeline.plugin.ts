import { generateText, stepCountIs, wrapLanguageModel } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type {
	IPlugin,
	IPipelinePlugin,
	IFormSchemaProvider,
	PluginContext,
	PluginCategory,
	PluginLogger,
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
	FormFieldGroup,
	MutableItemData
} from '@ever-works/plugin';
import { collectMetadataFromItems, createItemLookupIndex, isItemDuplicate } from '@ever-works/plugin';

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
import { extractSimpleKeywords, appendToJsonlIndex } from './utils/data-source-helpers.js';
import { createToolCallRepairFn, withToolCallingRetry } from './utils/tool-call-resilience.js';

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
		return { status: 'healthy', message: 'Agent Pipeline plugin is ready', checkedAt: Date.now() };
	}

	getManifest(): PluginManifest {
		return {
			id: this.id,
			name: this.name,
			version: this.version,
			description:
				'Autonomous tool-based pipeline that researches and generates directory items using an AI agent',
			category: this.category,
			capabilities: [...this.capabilities],
			author: { name: 'Ever Works Team' },
			license: 'MIT',
			builtIn: true,
			autoEnable: false,
			systemPlugin: false,
			visibility: 'public',
			selectableProviderCategories: ['ai-provider', 'search', 'screenshot', 'content-extractor', 'data-source'],
			readme: [
				'# Agent Pipeline Plugin',
				'',
				'Autonomous tool-based pipeline that researches and generates directory items.',
				'',
				'## How it works',
				'',
				'1. **Prepare Context** - Loads existing items, queries data sources',
				'2. **Generate Items** - AI agent researches and creates items',
				'3. **Collect Results** - Gathers generated items',
				'4. **Capture Screenshots** - Takes screenshots for items that need images',
				'5. **Cleanup** - Releases resources'
			].join('\n'),
			icon: {
				type: 'svg',
				value: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" fill="none"><defs><linearGradient id="g" x1="4" y1="44" x2="44" y2="4"><stop stop-color="#7C3AED"/><stop offset="1" stop-color="#06B6D4"/></linearGradient></defs><rect x="4" y="4" width="40" height="40" rx="12" fill="url(#g)"/><path d="M15 15l9 9M15 33l9-9M33 24h-9" stroke="#fff" stroke-width="2" stroke-linecap="round" opacity=".5"/><circle cx="15" cy="15" r="4" fill="#fff" fill-opacity=".9"/><circle cx="15" cy="33" r="4" fill="#fff" fill-opacity=".9"/><circle cx="33" cy="24" r="5" fill="#FCD34D"/></svg>'
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

			const { providerConfig, modelName } = await this.resolveAiProvider(execContext, facadeOptions);
			if (!providerConfig || !modelName) {
				return this.handleError(
					new Error(
						providerConfig
							? `AI provider "${providerConfig.providerId}" has no model configured. ` +
									'Set a defaultModel or complexModel in provider settings.'
							: 'AI provider missing baseUrl or apiKey. Please configure the AI provider settings.'
					),
					startTime
				);
			}

			const workspacePath = await createWorkspace(userId, directory.id, existing, directory, request);
			const dataSourceItems = await this.queryDataSources(
				execContext,
				directory,
				userId,
				request,
				existing,
				workspacePath,
				logger
			);

			this.setState('prepare-context', 'completed');
			if (signal.aborted) return this.handleCancel(startTime);

			// ── Step 2: Generate Items ─────────────────────────────────
			this.setState('generate-items', 'running');
			reportProgress(onProgress, 1, 20, 'Generate Items');

			const warnings = await this.runAgentGeneration(
				providerConfig,
				modelName,
				workspacePath,
				execContext,
				facadeOptions,
				directory,
				request,
				existing,
				onProgress,
				signal,
				logger
			);

			if (signal.aborted) {
				this.setState('generate-items', 'failed', 'Cancelled');
				return this.handleCancel(startTime);
			}

			this.setState('generate-items', 'completed');

			// ── Step 3: Collect Results ────────────────────────────────
			this.setState('collect-results', 'running');
			reportProgress(onProgress, 2, 82, 'Collect Results');

			const items = await this.collectAndMergeResults(workspacePath, dataSourceItems, logger);
			const metadata = collectMetadataFromItems(items);
			this.setState('collect-results', 'completed');

			// ── Step 4: Capture Screenshots ────────────────────────────
			const screenshotWarnings = await this.runScreenshotCapture(
				request,
				execContext,
				items,
				facadeOptions,
				signal,
				onProgress,
				logger
			);
			warnings.push(...screenshotWarnings);

			// ── Step 5: Cleanup ────────────────────────────────────────
			this.setState('cleanup', 'running');
			reportProgress(onProgress, 4, 95, 'Cleanup');

			await cleanupWorkspace(userId, directory.id);

			this.setState('cleanup', 'completed');

			// ── Build result ───────────────────────────────────────────
			reportProgress(onProgress, 5, 100, 'Complete');

			return this.buildSuccessResult(items, metadata, startTime, warnings);
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

	private async queryDataSources(
		execContext: NonNullable<PipelineExecutionOptions['execContext']>,
		directory: DirectoryReference,
		userId: string,
		request: GenerationRequest,
		existing: ExistingItems,
		workspacePath: string,
		logger: PluginLogger
	): Promise<MutableItemData[]> {
		if (!execContext.dataSourceFacade?.isConfigured()) return [];

		try {
			const keywords = extractSimpleKeywords(request.prompt, directory.name);
			const result = await execContext.dataSourceFacade.queryAll({
				directoryId: directory.id,
				userId,
				pluginConfig: request.config as Record<string, Record<string, unknown>> | undefined,
				filterContext: { prompt: request.prompt, subject: directory.name, keywords }
			});

			for (const err of result.errors) {
				logger.warn(`Data source ${err.sourceId} failed: ${err.error}`);
			}

			if (result.items.length === 0) return [];

			const lookupIndex = createItemLookupIndex(existing.items as MutableItemData[]);
			const newItems = (result.items as MutableItemData[]).filter((item) => !isItemDuplicate(item, lookupIndex));
			await appendToJsonlIndex(workspacePath, newItems);
			logger.log(`Data sources: ${result.items.length} queried, ${newItems.length} new items`);
			return newItems;
		} catch (error) {
			logger.warn(`Data source query failed: ${error instanceof Error ? error.message : String(error)}`);
			return [];
		}
	}

	private async runAgentGeneration(
		providerConfig: Awaited<
			ReturnType<NonNullable<PipelineExecutionOptions['execContext']>['aiFacade']['getProviderConfig']>
		>,
		modelName: string,
		workspacePath: string,
		execContext: NonNullable<PipelineExecutionOptions['execContext']>,
		facadeOptions: FacadeOptions,
		directory: DirectoryReference,
		request: GenerationRequest,
		existing: ExistingItems,
		onProgress: PipelineProgressCallback | undefined,
		signal: AbortSignal,
		logger: PluginLogger
	): Promise<string[]> {
		logger.log(`Using AI provider "${providerConfig.providerName}" with model "${modelName}"`);

		const provider = createOpenAICompatible({
			name: providerConfig.providerId,
			baseURL: providerConfig.baseUrl!,
			apiKey: providerConfig.apiKey!
		});

		const model = wrapLanguageModel({
			model: provider(modelName),
			middleware: {
				specificationVersion: 'v3',
				transformParams: async ({ params }) => ({
					...params,
					prompt: params.prompt.map((message) =>
						message.role === 'assistant'
							? {
									...message,
									content: message.content.filter((part) => part.type !== 'reasoning')
								}
							: message
					)
				})
			}
		});

		const { tools, breaker } = await createAgentTools(
			workspacePath,
			{
				searchFacade: execContext.searchFacade,
				contentExtractorFacade: execContext.contentExtractorFacade
			},
			facadeOptions,
			onProgress,
			AGENT_PIPELINE_STEP_IDS.length,
			logger
		);

		const promptOptions = { directory, request, existing };
		const systemPrompt = buildSystemPrompt(promptOptions);
		const userPrompt = buildUserPrompt(promptOptions);

		const settings = await resolveSettings(this.context, facadeOptions.userId, directory.id);
		const maxSteps = (settings.maxSteps as number) || DEFAULT_MAX_STEPS;

		const repairToolCall = createToolCallRepairFn(model, logger);

		const result = await withToolCallingRetry(
			() =>
				generateText({
					model,
					system: systemPrompt,
					prompt: userPrompt,
					tools: tools as Parameters<typeof generateText>[0]['tools'],
					stopWhen: stepCountIs(maxSteps),
					abortSignal: signal,
					experimental_repairToolCall: repairToolCall
				}),
			{
				providerName: providerConfig.providerName ?? providerConfig.providerId,
				modelName,
				signal,
				logger
			}
		);

		// Log generation diagnostics
		const totalToolCalls = result.steps.reduce((sum, step) => sum + step.toolCalls.length, 0);
		const toolNames = [...new Set(result.steps.flatMap((step) => step.toolCalls.map((tc) => tc.toolName)))];
		logger.log(
			`Agent completed: ${result.steps.length} steps, ${totalToolCalls} tool calls` +
				(toolNames.length > 0 ? ` (${toolNames.join(', ')})` : ' (no tools used)') +
				`, finish=${result.finishReason}` +
				`, tokens=${result.totalUsage.totalTokens ?? 'unknown'}`
		);

		if (totalToolCalls === 0) {
			logger.warn(
				`Model "${modelName}" returned without making any tool calls. ` +
					'This usually means the model does not support tool calling or ignored the tools. ' +
					`Response text: "${result.text.slice(0, 200)}${result.text.length > 200 ? '...' : ''}"`
			);
		}

		// Resolve provider names for user-facing warnings
		const [searchProviderName, extractProviderName] = await Promise.all([
			execContext.searchFacade.getActiveProviderName?.(facadeOptions)?.catch(() => null) ?? null,
			execContext.contentExtractorFacade.getActiveProviderName?.(facadeOptions)?.catch(() => null) ?? null
		]);

		const toolLabels: Record<string, { label: string; impact: string }> = {
			search: {
				label: searchProviderName ? `Web search (${searchProviderName})` : 'Web search',
				impact: 'Some results may be missing.'
			},
			extractContent: {
				label: extractProviderName ? `Content extraction (${extractProviderName})` : 'Content extraction',
				impact: 'Item details may be incomplete.'
			}
		};

		const warnings = breaker.getFailedTools().map((tool) => {
			const info = toolLabels[tool.name] ?? { label: tool.name, impact: 'Results may be less accurate.' };
			return `${info.label} was unavailable during generation (${tool.reason}). ${info.impact}`;
		});

		if (warnings.length > 0) {
			logger.warn(`Generation warnings (${warnings.length}): ${warnings.join(' | ')}`);
		}

		return warnings;
	}

	private async collectAndMergeResults(
		workspacePath: string,
		dataSourceItems: MutableItemData[],
		logger: PluginLogger
	): Promise<MutableItemData[]> {
		const agentItems = await collectItemsFromWorkspace(workspacePath, logger);
		const agentLookup = createItemLookupIndex(agentItems as MutableItemData[]);
		const uniqueDsItems = dataSourceItems.filter((item) => !isItemDuplicate(item, agentLookup));
		const total = agentItems.length + uniqueDsItems.length;
		logger.log(
			`Collected ${total} items (${agentItems.length} from agent, ${uniqueDsItems.length} from data sources)`
		);
		return [...(agentItems as MutableItemData[]), ...uniqueDsItems];
	}

	private async runScreenshotCapture(
		request: GenerationRequest,
		execContext: NonNullable<PipelineExecutionOptions['execContext']>,
		items: MutableItemData[],
		facadeOptions: FacadeOptions,
		signal: AbortSignal,
		onProgress: PipelineProgressCallback | undefined,
		logger: PluginLogger
	): Promise<string[]> {
		const shouldCapture = (request.config || {}).capture_screenshots !== false;

		if (!shouldCapture || items.length === 0 || signal.aborted) {
			this.setState('capture-screenshots', 'skipped' as StepStatus);
			return [];
		}

		if (!execContext.screenshotFacade.isAvailable()) {
			this.setState('capture-screenshots', 'skipped' as StepStatus);
			return ['Screenshot provider is not configured. Enable a screenshot plugin to capture item images.'];
		}

		this.setState('capture-screenshots', 'running');
		reportProgress(onProgress, 3, 85, 'Capture Screenshots');

		const { status, errors } = await captureScreenshots(items, {
			screenshotFacade: execContext.screenshotFacade,
			facadeOptions,
			signal,
			logger
		});
		this.setState('capture-screenshots', status);

		if (errors.length > 0) {
			const providerName = await execContext.screenshotFacade.getActiveProviderName?.(facadeOptions);
			const label = providerName ? `Screenshot capture (${providerName})` : 'Screenshot capture';
			const unique = [...new Set(errors)];
			return [`${label} failed for ${errors.length} item(s): ${unique.join('; ')}`];
		}
		return [];
	}

	private buildSuccessResult(
		items: MutableItemData[],
		metadata: ReturnType<typeof collectMetadataFromItems>,
		startTime: number,
		warnings?: string[]
	): PipelineResult {
		const duration = Date.now() - startTime;
		return {
			success: true,
			items,
			categories: metadata.categories,
			tags: metadata.tags,
			brands: metadata.brands,
			collections: metadata.collections,
			metrics: buildMetrics(startTime, duration, items.length),
			duration,
			stepsCompleted: AGENT_PIPELINE_STEP_IDS.length,
			totalSteps: AGENT_PIPELINE_STEP_IDS.length,
			state: this.state!,
			warnings
		};
	}

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
