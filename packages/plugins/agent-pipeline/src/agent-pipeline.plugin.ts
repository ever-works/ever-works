import { generateText, stepCountIs, ToolSet } from 'ai';
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
import { buildSuccessPipelineResult, substituteVariables } from '@ever-works/plugin';
import { collectMetadataFromItems, createItemLookupIndex, isItemDuplicate } from '@ever-works/plugin';

import type { AgentPipelineStepId, TokenUsageBreakdown } from './types.js';
import {
	AGENT_PIPELINE_STEP_IDS,
	DEFAULT_MAX_STEPS,
	DEFAULT_CONTEXT_BUDGET_RATIO,
	TokenUsageAccumulator
} from './types.js';
import { STEP_DEFINITIONS } from './steps.js';
import {
	getFormFields as formFields,
	getFormGroups as formGroups,
	validateFormInput as formValidate,
	getDefaultValues as formDefaults
} from './form-schema.js';
import {
	buildParentSystemPromptVariables,
	buildParentUserPromptVariables,
	DEFAULT_PARENT_SYSTEM_PROMPT,
	DEFAULT_PARENT_USER_PROMPT
} from './prompt/system-prompt.js';
import { PROMPT_KEYS } from './prompt-keys.js';
import { createParentTools } from './tools/parent-tools.js';
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
import { createPrepareStep } from './utils/context-compaction.js';
import { wrapReasoningFilteredModel } from './utils/model-wrapper.js';

interface ProcessUrlExecutionResult {
	url: string;
	files: string[];
	count: number;
	error?: string;
}

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
		const onLogEntry = options?.onLogEntry;

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

		const tokenAccumulator = new TokenUsageAccumulator();

		try {
			// ── Step 1: Prepare Context ────────────────────────────────
			this.setState('prepare-context', 'running');
			reportProgress(onProgress, 0, 10, 'Prepare Context');
			this.emitLog(onLogEntry, 'step_started', 'Prepare Context', 0);

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
			this.emitLog(onLogEntry, 'step_completed', 'Prepare Context', 0);
			if (signal.aborted) return this.handleCancel(startTime);

			// ── Step 2: Generate Items ─────────────────────────────────
			this.setState('generate-items', 'running');
			reportProgress(onProgress, 1, 20, 'Generate Items');
			this.emitLog(onLogEntry, 'step_started', 'Generate Items', 1);

			const { warnings, tokenUsage } = await this.runAgentGeneration(
				providerConfig,
				workspacePath,
				execContext,
				facadeOptions,
				directory,
				request,
				existing,
				onProgress,
				signal,
				logger,
				tokenAccumulator,
				onLogEntry
			);

			if (signal.aborted) {
				this.setState('generate-items', 'failed', 'Cancelled');
				this.emitLog(onLogEntry, 'step_failed', 'Generate Items: Cancelled', 1, 'warn');
				return this.handleCancel(startTime);
			}

			this.setState('generate-items', 'completed');
			this.emitLog(onLogEntry, 'step_completed', 'Generate Items', 1);

			// ── Step 3: Collect Results ────────────────────────────────
			this.setState('collect-results', 'running');
			reportProgress(onProgress, 2, 82, 'Collect Results');
			this.emitLog(onLogEntry, 'step_started', 'Collect Results', 2);

			const items = await this.collectAndMergeResults(workspacePath, dataSourceItems, logger);
			const metadata = collectMetadataFromItems(items);
			this.setState('collect-results', 'completed');
			this.emitLog(onLogEntry, 'step_completed', 'Collect Results', 2);

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
			this.emitLog(onLogEntry, 'step_started', 'Cleanup', 4);

			await cleanupWorkspace(userId, directory.id);

			this.setState('cleanup', 'completed');
			this.emitLog(onLogEntry, 'step_completed', 'Cleanup', 4);

			// ── Build result ───────────────────────────────────────────
			reportProgress(onProgress, 5, 100, 'Complete');

			return this.buildSuccessResult(items, metadata, startTime, warnings, tokenUsage);
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

	private emitLog(
		onLogEntry: PipelineExecutionOptions['onLogEntry'],
		event: 'step_started' | 'step_completed' | 'step_failed' | 'step_skipped' | 'message',
		message: string,
		stepIndex?: number,
		level: 'info' | 'warn' | 'error' | 'debug' = 'info'
	): void {
		onLogEntry?.({
			timestamp: new Date().toISOString(),
			level,
			source: 'pipeline',
			event,
			message,
			stepIndex: stepIndex ?? null,
			stepName: null,
			durationMs: null
		});
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
		workspacePath: string,
		execContext: NonNullable<PipelineExecutionOptions['execContext']>,
		facadeOptions: FacadeOptions,
		directory: DirectoryReference,
		request: GenerationRequest,
		existing: ExistingItems,
		onProgress: PipelineProgressCallback | undefined,
		signal: AbortSignal,
		logger: PluginLogger,
		tokenAccumulator: TokenUsageAccumulator,
		onLogEntry?: PipelineExecutionOptions['onLogEntry']
	): Promise<{ warnings: string[]; tokenUsage: TokenUsageBreakdown }> {
		// Two-model resolution: parent (orchestrator) and worker (extraction)
		const parentModelName = providerConfig.routing.complexModel || providerConfig.defaultModel;
		const workerModelName = providerConfig.defaultModel || providerConfig.routing.complexModel;

		if (!parentModelName || !workerModelName) {
			throw new Error('AI model configuration error: both parent and worker models required');
		}

		logger.log(
			`Using AI provider "${providerConfig.providerName}" — ` +
				`parent: "${parentModelName}", worker: "${workerModelName}"`
		);
		this.emitLog(
			onLogEntry,
			'message',
			`AI provider: ${providerConfig.providerName} (parent: ${parentModelName}, worker: ${workerModelName})`,
			1
		);

		const provider = createOpenAICompatible({
			name: providerConfig.providerId,
			baseURL: providerConfig.baseUrl!,
			apiKey: providerConfig.apiKey!
		});

		const wrapModel = (name: string) => {
			return wrapReasoningFilteredModel(provider(name));
		};

		const parentModel = wrapModel(parentModelName);
		const workerModel = wrapModel(workerModelName);

		// Resolve context windows — reuse result when both models are the same
		const parentMaxContextTokens = await execContext.aiFacade.resolveModelContextLength(
			parentModelName,
			facadeOptions
		);
		const workerMaxContextTokens =
			parentModelName === workerModelName
				? parentMaxContextTokens
				: await execContext.aiFacade.resolveModelContextLength(workerModelName, facadeOptions);

		logger.log(
			`Context windows — parent: ${parentMaxContextTokens} tokens, worker: ${workerMaxContextTokens} tokens`
		);

		const directoryContext = {
			directoryName: directory.name,
			directoryDescription: directory.description,
			requestPrompt: request.prompt
		};

		const { tools, breaker } = createParentTools({
			workspacePath,
			facades: {
				searchFacade: execContext.searchFacade,
				contentExtractorFacade: execContext.contentExtractorFacade
			},
			facadeOptions,
			workerModel,
			workerMaxContextTokens,
			parentModel,
			parentMaxContextTokens,
			directoryContext,
			onProgress,
			totalSteps: AGENT_PIPELINE_STEP_IDS.length,
			logger,
			tokenAccumulator,
			signal,
			promptFacade: execContext.promptFacade,
			onLogEntry
		});

		const promptOptions = { directory, request, existing };
		const promptFacade = execContext.promptFacade;

		const sysTemplate = (
			promptFacade
				? await promptFacade.getPrompt(PROMPT_KEYS.PARENT_SYSTEM, DEFAULT_PARENT_SYSTEM_PROMPT, facadeOptions)
				: DEFAULT_PARENT_SYSTEM_PROMPT
		) as typeof DEFAULT_PARENT_SYSTEM_PROMPT;
		const systemPrompt = substituteVariables(sysTemplate, buildParentSystemPromptVariables(promptOptions));

		this.context?.logger.log('[System Prompt] ' + systemPrompt);

		const userTemplate = (
			promptFacade
				? await promptFacade.getPrompt(PROMPT_KEYS.PARENT_USER, DEFAULT_PARENT_USER_PROMPT, facadeOptions)
				: DEFAULT_PARENT_USER_PROMPT
		) as typeof DEFAULT_PARENT_USER_PROMPT;
		const userPrompt = substituteVariables(userTemplate, buildParentUserPromptVariables(promptOptions));

		this.context?.logger.log('[User Prompt] ' + userPrompt);

		const settings = await resolveSettings(this.context, facadeOptions.userId, directory.id);
		const maxSteps = (settings.maxSteps as number) || DEFAULT_MAX_STEPS;

		const repairToolCall = createToolCallRepairFn(parentModel, logger);

		const prepareStep = createPrepareStep({
			maxContextTokens: parentMaxContextTokens,
			budgetRatio: DEFAULT_CONTEXT_BUDGET_RATIO,
			maxSingleOutputChars: Math.floor(parentMaxContextTokens * 0.08 * 4),
			logger
		});

		let agentStepIndex = 0;
		const result = await withToolCallingRetry(
			() => {
				return generateText({
					model: parentModel,
					system: systemPrompt,
					prompt: userPrompt,
					tools: tools as ToolSet,
					stopWhen: stepCountIs(maxSteps),
					prepareStep,
					abortSignal: signal,
					experimental_repairToolCall: repairToolCall,
					experimental_telemetry: { isEnabled: true },
					onStepFinish: (step) => {
						agentStepIndex++;
						const toolNames = step.toolCalls.map((tc) => tc.toolName);
						const toolSummary = toolNames.length > 0
							? `tools: ${toolNames.join(', ')}`
							: `text: ${step.text.slice(0, 120)}${step.text.length > 120 ? '…' : ''}`;
						const tokens = step.usage;
						this.emitLog(
							onLogEntry,
							'message',
							`Agent step ${agentStepIndex}: ${toolSummary} (${tokens.totalTokens} tokens)`,
							1,
							'info'
						);
					}
				});
			},
			{
				providerName: providerConfig.providerName ?? providerConfig.providerId,
				modelName: parentModelName,
				signal,
				logger
			}
		);

		tokenAccumulator.addParent(result.totalUsage);

		// Log generation diagnostics
		const totalToolCalls = result.steps.reduce((sum, step) => sum + step.toolCalls.length, 0);
		const toolNames = [...new Set(result.steps.flatMap((step) => step.toolCalls.map((tc) => tc.toolName)))];
		const tokenUsage = tokenAccumulator.toBreakdown();

		const completionMsg =
			`Agent completed: ${result.steps.length} steps, ${totalToolCalls} tool calls` +
			(toolNames.length > 0 ? ` (${toolNames.join(', ')})` : ' (no tools used)') +
			`, finish=${result.finishReason}` +
			`, tokens: parent=${tokenUsage.parent.totalTokens}` +
			`, workers=${tokenUsage.workers.totalTokens}` +
			`, total=${tokenUsage.total.totalTokens}`;
		logger.log(completionMsg);
		this.emitLog(onLogEntry, 'message', completionMsg, 1);

		if (totalToolCalls === 0) {
			logger.warn(
				`Model "${parentModelName}" returned without making any tool calls. ` +
					'This usually means the model does not support tool calling or ignored the tools. ' +
					`Response text: "${result.text.slice(0, 200)}${result.text.length > 200 ? '...' : ''}"`
			);
		}

		// Resolve provider name for user-facing warnings
		const searchProviderName =
			(await execContext.searchFacade.getActiveProviderName?.(facadeOptions)?.catch(() => null)) ?? null;

		const toolLabels: Record<string, { label: string; impact: string }> = {
			search: {
				label: searchProviderName ? `Web search (${searchProviderName})` : 'Web search',
				impact: 'Some results may be missing.'
			}
		};

		const warnings = breaker.getFailedTools().map((t) => {
			const info = toolLabels[t.name] ?? { label: t.name, impact: 'Results may be less accurate.' };
			return `${info.label} was unavailable during generation (${t.reason}). ${info.impact}`;
		});

		const processUrlFailures = this.collectProcessUrlFailures(result.steps as unknown[]);
		if (processUrlFailures.failedUrls > 0) {
			const samples =
				processUrlFailures.sampleErrors.length > 0
					? ` Errors: ${processUrlFailures.sampleErrors.join('; ')}`
					: '';

			if (processUrlFailures.failedUrls === processUrlFailures.totalUrls) {
				warnings.push(
					`URL processing had failures (${processUrlFailures.failedUrls}/${processUrlFailures.totalUrls} URLs failed). ` +
						'Some relevant items may be missing.' +
						samples
				);
			}
		}

		if (warnings.length > 0) {
			logger.warn(`Generation warnings (${warnings.length}): ${warnings.join(' | ')}`);
		}

		return { warnings, tokenUsage };
	}

	private async collectAndMergeResults(
		workspacePath: string,
		dataSourceItems: MutableItemData[],
		logger: PluginLogger
	): Promise<MutableItemData[]> {
		const collectedAgentItems = await collectItemsFromWorkspace(workspacePath, logger);
		const agentItems = this.deduplicateGeneratedItems(collectedAgentItems as MutableItemData[], logger);
		const agentLookup = createItemLookupIndex(agentItems);
		const uniqueDsItems = dataSourceItems.filter((item) => !isItemDuplicate(item, agentLookup));
		const total = agentItems.length + uniqueDsItems.length;
		logger.log(
			`Collected ${total} items (${agentItems.length} from agent, ${uniqueDsItems.length} from data sources)`
		);
		return [...agentItems, ...uniqueDsItems];
	}

	private deduplicateGeneratedItems(items: MutableItemData[], logger: PluginLogger): MutableItemData[] {
		const seenUrls = new Set<string>();
		const seenNames = new Set<string>();
		const unique: MutableItemData[] = [];
		let dropped = 0;

		for (const item of items) {
			const urlKey = this.normalizeUrl(item.source_url);
			const nameKey = this.normalizeName(item.name);

			const isDuplicate = urlKey ? seenUrls.has(urlKey) : !!nameKey && seenNames.has(nameKey);
			if (isDuplicate) {
				dropped++;
				continue;
			}

			unique.push(item);
			if (urlKey) {
				seenUrls.add(urlKey);
			} else if (nameKey) {
				seenNames.add(nameKey);
			}
		}

		if (dropped > 0) {
			logger.log(
				`Deduplicated generated items: dropped ${dropped} duplicates (${items.length} -> ${unique.length})`
			);
		}

		return unique;
	}

	private normalizeUrl(raw: unknown): string | null {
		if (typeof raw !== 'string') return null;
		const trimmed = raw.trim();
		if (!trimmed) return null;

		try {
			const parsed = new URL(trimmed);
			const pathname = parsed.pathname.replace(/\/+$/, '') || '/';
			const host = parsed.host.toLowerCase();
			const protocol = parsed.protocol.toLowerCase();
			return `${protocol}//${host}${pathname}${parsed.search}`;
		} catch {
			return trimmed.toLowerCase().replace(/\/+$/, '');
		}
	}

	private normalizeName(raw: unknown): string | null {
		if (typeof raw !== 'string') return null;
		const normalized = raw.trim().toLowerCase().replace(/\s+/g, ' ');
		return normalized || null;
	}

	private collectProcessUrlFailures(steps: unknown[]): {
		totalUrls: number;
		failedUrls: number;
		sampleErrors: string[];
	} {
		let totalUrls = 0;
		let failedUrls = 0;
		const uniqueErrors = new Set<string>();

		for (const step of steps) {
			const toolResults = (step as { toolResults?: unknown[] }).toolResults;
			if (!Array.isArray(toolResults)) continue;

			for (const toolResult of toolResults) {
				const tr = toolResult as { toolName?: unknown; output?: unknown };
				if (tr.toolName !== 'processUrls') continue;

				if (!Array.isArray(tr.output)) continue;
				for (const result of tr.output as ProcessUrlExecutionResult[]) {
					totalUrls++;
					if (typeof result?.error === 'string' && result.error.trim()) {
						failedUrls++;
						uniqueErrors.add(result.error.trim());
					}
				}
			}
		}

		return {
			totalUrls,
			failedUrls,
			sampleErrors: [...uniqueErrors].slice(0, 3)
		};
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
			this.setState('capture-screenshots', 'skipped');
			return [];
		}

		if (!execContext.screenshotFacade.isAvailable()) {
			this.setState('capture-screenshots', 'skipped');
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
		warnings?: string[],
		tokenUsage?: TokenUsageBreakdown
	): PipelineResult {
		const duration = Date.now() - startTime;
		return buildSuccessPipelineResult(
			{
				items,
				categories: metadata.categories,
				tags: metadata.tags,
				brands: metadata.brands,
				collections: metadata.collections
			},
			{
				metrics: buildMetrics(startTime, duration, items.length, tokenUsage),
				duration,
				stepsCompleted: AGENT_PIPELINE_STEP_IDS.length,
				totalSteps: AGENT_PIPELINE_STEP_IDS.length,
				state: this.state!,
				warnings
			}
		);
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
