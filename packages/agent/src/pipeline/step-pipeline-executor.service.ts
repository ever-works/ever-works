import { Injectable, Logger, Inject, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import type {
    DirectoryReference,
    GenerationRequest,
    ExistingItems,
    PipelineExecutionOptions,
    PipelineProgressCallback,
    PipelineResult,
    PipelineStepDefinition,
    StepMetrics,
    StepDataKey,
    IPipelineStepPlugin,
    IPlugin,
    PipelineEventPayload,
    PipelineStepEventPayload,
    PipelineStepCompletedPayload,
    PipelineStepFailedPayload,
    PipelineCompletedPayload,
    PipelineFailedPayload,
    GenerationContextSnapshot,
    StepExecutionContext,
    StepLogger,
    IAiFacade,
    ISearchFacade,
    IScreenshotFacade,
    IContentExtractorFacade,
    IDataSourceFacade,
    AskJsonOptions,
    AskJsonResponse,
    SchemaType,
    SearchFacadeOptions,
    SearchFacadeResult,
    ScreenshotCaptureOptions,
    ScreenshotCaptureResult,
    SmartImageOptions,
    SmartImageResult,
    FacadeExtractionOptions,
    FacadeExtractedContent,
    DataSourceFacadeOptions,
    DataSourceFacadeResult,
    EnabledDataSource,
} from '@ever-works/plugin';
import { AiFacadeService } from '../facades/ai.facade';
import { SearchFacadeService } from '../facades/search.facade';
import { ScreenshotFacadeService } from '../facades/screenshot.facade';
import { ContentExtractorFacadeService } from '../facades/content-extractor.facade';
import { DataSourceFacadeService } from '../facades/data-source.facade';

/**
 * Type guard for pipeline step plugins (inlined to avoid ESM import issues)
 */
function isPipelineStepPlugin(plugin: IPlugin): plugin is IPipelineStepPlugin {
    return plugin.capabilities.includes('pipeline-step');
}
import { PipelineBuilderService } from './pipeline-builder.service';
import { DefaultPipelinePlugin } from './default-pipeline.plugin';
import { PluginRegistryService } from '../plugins/services/plugin-registry.service';
import { TypedGenerationContext, createGenerationContext } from './generation-context';
import { ExecutablePipelineRunner } from './executable-pipeline.class';

/**
 * Checkpoint data structure for pipeline resume capability.
 * Used to persist pipeline state between executions for recovery.
 */
export interface CheckpointData {
    /** Index of the last completed step */
    stepIndex: number;
    /** Name of the last completed step */
    stepName: string;
    /** When the checkpoint was created */
    timestamp: string;
    /** Serializable context snapshot */
    context: GenerationContextSnapshot;
    /** Steps that have been completed */
    completedSteps: string[];
}

/**
 * Checkpoint TTL in milliseconds (24 hours)
 */
const CHECKPOINT_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Context for binding facades to a specific directory/user.
 * This allows facades to automatically include directory context in their calls.
 */
interface FacadeBindingContext {
    readonly directoryId: string;
    readonly userId?: string;
}

/**
 * Pipeline event names for lifecycle notifications.
 */
export const PipelineEvents = {
    STARTED: 'pipeline:started',
    STEP_STARTED: 'pipeline:step-started',
    STEP_COMPLETED: 'pipeline:step-completed',
    STEP_FAILED: 'pipeline:step-failed',
    STEP_SKIPPED: 'pipeline:step-skipped',
    COMPLETED: 'pipeline:completed',
    FAILED: 'pipeline:failed',
    CANCELLED: 'pipeline:cancelled',
} as const;

/**
 * Step-based pipeline executor service.
 *
 * This service executes pipelines step by step, supporting:
 * - Built-in steps via DefaultPipelinePlugin
 * - Plugin-provided steps via IPipelineStepPlugin
 * - Step skipping when data already provided
 * - Per-step metrics tracking
 * - Checkpoint saving for resume capability
 * - Event hooks for pipeline lifecycle
 */
@Injectable()
export class StepPipelineExecutorService {
    private readonly logger = new Logger(StepPipelineExecutorService.name);

    constructor(
        private readonly pipelineBuilder: PipelineBuilderService,
        private readonly defaultPlugin: DefaultPipelinePlugin,
        private readonly registry: PluginRegistryService,
        private readonly eventEmitter: EventEmitter2,
        private readonly aiFacade: AiFacadeService,
        private readonly searchFacade: SearchFacadeService,
        private readonly screenshotFacade: ScreenshotFacadeService,
        private readonly contentExtractorFacade: ContentExtractorFacadeService,
        @Optional() private readonly dataSourceFacade?: DataSourceFacadeService,
        @Optional() @Inject(CACHE_MANAGER) private readonly cacheManager?: Cache,
    ) {}

    /**
     * Get the default pipeline plugin.
     * Prefers the NestJS-injected plugin, falls back to registry lookup.
     */
    private getDefaultPipelinePlugin(): DefaultPipelinePlugin {
        // Primary: use the NestJS-injected plugin
        if (this.defaultPlugin) {
            return this.defaultPlugin;
        }

        // Fallback: get from plugin registry
        const registered = this.registry.get('default-pipeline');
        if (registered && registered.state === 'enabled') {
            // The registered plugin should be compatible with DefaultPipelinePlugin interface
            return registered.plugin as unknown as DefaultPipelinePlugin;
        }

        throw new Error(
            'Default pipeline plugin not available. ' +
                'Ensure DefaultPipelinePlugin is provided in the module or loaded via plugin system.',
        );
    }

    /**
     * Create a bound AI facade that automatically includes directory context.
     * Steps use this facade without needing to pass facadeOptions.
     */
    private createBoundAiFacade(ctx: FacadeBindingContext): IAiFacade {
        const facade = this.aiFacade;
        return {
            askJson: <T>(
                promptTemplate: string,
                schema: SchemaType<T>,
                options?: AskJsonOptions,
            ): Promise<AskJsonResponse<T>> =>
                // Cast schema to any since both ZodSchema and SchemaType satisfy the contract
                // The runtime implementation in AiFacadeService handles Zod schemas
                facade.askJson(promptTemplate, schema as any, options, {
                    directoryId: ctx.directoryId,
                    userId: ctx.userId,
                }),
            isConfigured: () => facade.isConfigured(),
            testConnection: () =>
                facade.testConnection({
                    directoryId: ctx.directoryId,
                    userId: ctx.userId,
                }),
            getAvailableModels: () =>
                facade.getAvailableModels({
                    directoryId: ctx.directoryId,
                    userId: ctx.userId,
                }),
        };
    }

    /**
     * Create a bound search facade that automatically includes directory context.
     */
    private createBoundSearchFacade(ctx: FacadeBindingContext): ISearchFacade {
        const facade = this.searchFacade;
        return {
            search: (query: string, options?: SearchFacadeOptions): Promise<SearchFacadeResult[]> =>
                facade.search(query, {
                    ...options,
                    userId: ctx.userId,
                    directoryId: ctx.directoryId,
                } as SearchFacadeOptions),
            isConfigured: () => facade.isConfigured(),
        };
    }

    /**
     * Create a bound screenshot facade that automatically includes directory context.
     */
    private createBoundScreenshotFacade(ctx: FacadeBindingContext): IScreenshotFacade {
        const facade = this.screenshotFacade;
        return {
            capture: (options: ScreenshotCaptureOptions): Promise<ScreenshotCaptureResult> =>
                facade.capture(options, {
                    directoryId: ctx.directoryId,
                    userId: ctx.userId,
                }),
            getSmartImage: (options: SmartImageOptions): Promise<SmartImageResult> =>
                facade.getSmartImage(options, {
                    directoryId: ctx.directoryId,
                    userId: ctx.userId,
                }),
            getScreenshotUrl: (options: ScreenshotCaptureOptions): Promise<string | null> =>
                facade.getScreenshotUrl(options, {
                    directoryId: ctx.directoryId,
                    userId: ctx.userId,
                }),
            isAvailable: () => facade.isAvailable(),
        };
    }

    /**
     * Create a bound content extractor facade that automatically includes directory context.
     */
    private createBoundContentExtractorFacade(ctx: FacadeBindingContext): IContentExtractorFacade {
        const facade = this.contentExtractorFacade;
        return {
            extractContent: (
                url: string,
                options?: FacadeExtractionOptions,
            ): Promise<FacadeExtractedContent | null> =>
                facade.extractContent(url, {
                    ...options,
                    userId: ctx.userId,
                    directoryId: ctx.directoryId,
                } as FacadeExtractionOptions),
            isConfigured: () => facade.isConfigured(),
        };
    }

    /**
     * Create a bound data source facade that automatically includes directory context.
     */
    private createBoundDataSourceFacade(ctx: FacadeBindingContext): IDataSourceFacade | undefined {
        if (!this.dataSourceFacade) {
            return undefined;
        }
        const facade = this.dataSourceFacade;
        return {
            queryAll: (options?: DataSourceFacadeOptions): Promise<DataSourceFacadeResult> =>
                facade.queryAll({
                    ...options,
                    directoryId: ctx.directoryId,
                    userId: ctx.userId,
                }),
            getEnabledSources: (directoryId: string): Promise<EnabledDataSource[]> =>
                facade.getEnabledSources(directoryId, ctx.userId),
            isConfigured: () => facade.isConfigured(),
        };
    }

    /**
     * Create a StepExecutionContext for step executors.
     * Provides access to bound facades that automatically include directory context.
     *
     * This is the key integration point for directory-scoped plugin resolution.
     * Each facade is wrapped to automatically include directoryId/userId in all calls,
     * so pipeline steps don't need to manage this context themselves.
     */
    private createStepExecutionContext(
        directory: DirectoryReference,
        signal?: AbortSignal,
    ): StepExecutionContext {
        const stepLogger: StepLogger = {
            log: (msg: string, ...args: unknown[]) =>
                this.logger.log(`[${directory.slug}] ${msg}`, ...args),
            debug: (msg: string, ...args: unknown[]) =>
                this.logger.debug(`[${directory.slug}] ${msg}`, ...args),
            warn: (msg: string, ...args: unknown[]) =>
                this.logger.warn(`[${directory.slug}] ${msg}`, ...args),
            error: (msg: string, trace?: string, ...args: unknown[]) =>
                this.logger.error(`[${directory.slug}] ${msg}`, trace, ...args),
            verbose: (msg: string, ...args: unknown[]) =>
                this.logger.verbose?.(`[${directory.slug}] ${msg}`, ...args),
        };

        // Create binding context with directory info
        const facadeContext: FacadeBindingContext = {
            directoryId: directory.id,
            userId: directory.user?.id,
        };

        return {
            aiFacade: this.createBoundAiFacade(facadeContext),
            searchFacade: this.createBoundSearchFacade(facadeContext),
            screenshotFacade: this.createBoundScreenshotFacade(facadeContext),
            contentExtractorFacade: this.createBoundContentExtractorFacade(facadeContext),
            dataSourceFacade: this.createBoundDataSourceFacade(facadeContext),
            logger: stepLogger,
            directory,
            user: directory.user,
            signal,
        };
    }

    /**
     * Execute the pipeline for a directory
     *
     * @param directory - Directory reference
     * @param request - Generation request parameters
     * @param existing - Existing items in directory
     * @param options - Execution options
     * @param onProgress - Progress callback
     * @returns Pipeline execution result
     */
    async execute(
        directory: DirectoryReference,
        request: GenerationRequest,
        existing: ExistingItems,
        options?: PipelineExecutionOptions,
        onProgress?: PipelineProgressCallback,
    ): Promise<PipelineResult> {
        const startTime = Date.now();

        this.logger.log(`Starting step-based pipeline execution for directory: ${directory.id}`);

        // 1. Build the pipeline (with directory-scoped plugin resolution)
        const pipeline = await this.pipelineBuilder.build(directory.id, directory.user?.id);
        const runner = new ExecutablePipelineRunner(pipeline, this.eventEmitter);

        // 2. Create the generation context
        const context = createGenerationContext(directory, request, existing);

        // 3. Emit pipeline:started event (Task 3.19)
        this.emitPipelineEvent(PipelineEvents.STARTED, {
            directoryId: directory.id,
        });

        // 4. Start execution tracking
        runner.startExecution();

        let lastCompletedStepIndex = -1;
        let currentStepIndex = 0;

        try {
            // 5. Execute steps in order
            for (const step of pipeline.steps) {
                // Check for cancellation
                if (options?.signal?.aborted) {
                    this.logger.log(`Pipeline cancelled at step ${currentStepIndex}`);
                    runner.cancelExecution();
                    this.emitPipelineEvent(PipelineEvents.CANCELLED, {
                        directoryId: directory.id,
                    });
                    return this.createCancelledResult(context, runner, startTime, step.id);
                }

                // Check if step should be skipped via options
                if (options?.skipSteps?.includes(step.id)) {
                    this.logger.debug(`Skipping step "${step.id}" (in skipSteps)`);
                    runner.markStepSkipped(step.id, 'skipped by options');
                    this.emitStepSkipped(step, currentStepIndex, pipeline.steps.length);
                    currentStepIndex++;
                    continue;
                }

                // Check if onlySteps is specified and this step is not in it
                if (options?.onlySteps && !options.onlySteps.includes(step.id)) {
                    this.logger.debug(`Skipping step "${step.id}" (not in onlySteps)`);
                    runner.markStepSkipped(step.id, 'not in onlySteps');
                    currentStepIndex++;
                    continue;
                }

                // Check if step can be skipped (data already provided)
                if (await this.canSkipStep(step, context)) {
                    this.logger.debug(`Skipping step "${step.id}" (data already provided)`);
                    runner.markStepSkipped(step.id, 'data already provided');
                    this.emitStepSkipped(step, currentStepIndex, pipeline.steps.length);
                    currentStepIndex++;
                    continue;
                }

                // Emit step:started event (Task 3.19)
                runner.startStep(step.id);
                this.emitStepEvent(
                    PipelineEvents.STEP_STARTED,
                    step,
                    currentStepIndex,
                    pipeline.steps.length,
                );

                // Report progress
                if (onProgress) {
                    onProgress({
                        percent: Math.round((currentStepIndex / pipeline.steps.length) * 100),
                        currentStepIndex,
                        totalSteps: pipeline.steps.length,
                        currentStepName: step.name,
                        message: `Executing: ${step.name}`,
                    });
                }

                const stepStartTime = Date.now();

                try {
                    // Execute the step
                    const executor = pipeline.executorMap.get(step.id);
                    if (!executor) {
                        throw new Error(`No executor found for step "${step.id}"`);
                    }

                    await this.executeStep(step, executor, context, options);

                    // Record metrics
                    const metrics = this.createStepMetrics(step, stepStartTime, true);
                    context.recordStepMetrics(step.id, metrics);
                    runner.markStepComplete(step.id, metrics);

                    // Save checkpoint
                    await this.saveCheckpoint(
                        directory,
                        context,
                        currentStepIndex,
                        step.name,
                        runner.getState().completedSteps,
                    );

                    // Emit step:completed event (Task 3.19)
                    this.emitStepCompleted(
                        step,
                        currentStepIndex,
                        pipeline.steps.length,
                        metrics.duration ?? 0,
                    );

                    lastCompletedStepIndex = currentStepIndex;

                    // Check if shouldStop is set
                    if (context.shouldStop) {
                        this.logger.log(`Pipeline stopped by step "${step.id}"`);
                        break;
                    }
                } catch (error) {
                    const err = error as Error;
                    const metrics = this.createStepMetrics(step, stepStartTime, false, err.message);
                    context.recordStepMetrics(step.id, metrics);
                    runner.markStepFailed(step.id, err);

                    // Emit step:failed event (Task 3.19)
                    this.emitStepFailed(
                        step,
                        currentStepIndex,
                        pipeline.steps.length,
                        err,
                        step.optional ?? false,
                    );

                    if (!options?.continueOnError && !step.optional) {
                        throw err;
                    }

                    this.logger.warn(`Step "${step.id}" failed but continuing: ${err.message}`);
                }

                currentStepIndex++;
            }

            // 6. Complete execution
            runner.completeExecution();

            // Update final metrics
            context.updateMetrics({
                duration: Date.now() - startTime,
                itemsProcessed: context.finalItems.length,
            });

            // Emit pipeline:completed event (Task 3.19)
            this.emitPipelineCompleted(
                directory.id,
                Date.now() - startTime,
                runner.getState().completedSteps.length,
                context,
            );

            this.logger.log(
                `Pipeline completed: ${runner.getState().completedSteps.length}/${pipeline.steps.length} steps`,
            );

            return this.createSuccessResult(context, runner, startTime);
        } catch (error) {
            runner.completeExecution();

            const failedStep = pipeline.steps[currentStepIndex]?.id;

            // Emit pipeline:failed event (Task 3.19)
            this.emitPipelineFailed(
                directory.id,
                error as Error,
                failedStep,
                lastCompletedStepIndex + 1,
            );

            this.logger.error(
                `Pipeline failed at step "${failedStep}": ${(error as Error).message}`,
            );

            return this.createFailedResult(context, runner, startTime, error as Error, failedStep);
        }
    }

    /**
     * Execute with an existing context (for resume scenarios)
     */
    async executeWithContext(
        context: TypedGenerationContext,
        options?: PipelineExecutionOptions,
        onProgress?: PipelineProgressCallback,
    ): Promise<PipelineResult> {
        return this.execute(
            context.directory,
            context.request,
            context.existing,
            options,
            onProgress,
        );
    }

    /**
     * Resume pipeline from checkpoint
     * @param directoryId - Directory ID to resume
     * @param options - Execution options
     * @param onProgress - Progress callback
     */
    async resumeFromCheckpoint(
        directoryId: string,
        options?: PipelineExecutionOptions,
        onProgress?: PipelineProgressCallback,
    ): Promise<PipelineResult | null> {
        const checkpoint = await this.loadCheckpoint(directoryId);
        if (!checkpoint) {
            this.logger.warn(`No checkpoint found for directory: ${directoryId}`);
            return null;
        }

        this.logger.log(
            `Resuming pipeline from checkpoint at step ${checkpoint.stepIndex}: ${checkpoint.stepName}`,
        );

        // Reconstruct context from checkpoint
        const context = new TypedGenerationContext(
            checkpoint.context.directory,
            checkpoint.context.request,
            checkpoint.context.existing,
        );

        // Copy checkpoint data to context
        // Note: We need to convert readonly types to mutable types when restoring
        context.extractedUrls = [...checkpoint.context.extractedUrls];
        context.searchQueries = [...checkpoint.context.searchQueries];
        context.webPages = checkpoint.context.webPages.map((wp) => ({ ...wp }));
        context.processedSourceUrls = new Set(checkpoint.context.processedSourceUrls);
        context.contentCache = new Map(checkpoint.context.contentCache);

        // Convert readonly ItemData to MutableItemData using JSON serialization
        // This is safe for checkpoint restore since we need deep clones anyway
        context.initialAiItems = JSON.parse(JSON.stringify(checkpoint.context.initialAiItems));
        context.extractedWebItems = JSON.parse(
            JSON.stringify(checkpoint.context.extractedWebItems),
        );
        context.aggregatedItems = JSON.parse(JSON.stringify(checkpoint.context.aggregatedItems));
        context.finalItems = JSON.parse(JSON.stringify(checkpoint.context.finalItems));
        context.finalCategories = checkpoint.context.finalCategories.map((c) => ({ ...c }));
        context.finalTags = checkpoint.context.finalTags.map((t) => ({ ...t }));
        context.finalBrands = checkpoint.context.finalBrands.map((b) => ({ ...b }));
        context.domainAnalysis = checkpoint.context.domainAnalysis;
        context.allInitialCategories = [...checkpoint.context.allInitialCategories];
        context.allPriorityCategories = [...checkpoint.context.allPriorityCategories];
        context.featuredItemHints = [...checkpoint.context.featuredItemHints];
        context.subject = checkpoint.context.subject;

        // Execute with completed steps to skip
        const resumeOptions: PipelineExecutionOptions = {
            ...options,
            skipSteps: checkpoint.completedSteps,
        };

        return this.executeWithContext(context, resumeOptions, onProgress);
    }

    /**
     * Check if step can be skipped because data is already provided
     */
    private async canSkipStep(
        step: PipelineStepDefinition,
        context: TypedGenerationContext,
    ): Promise<boolean> {
        // If step doesn't provide any data keys, can't skip
        if (!step.provides?.length) {
            return false;
        }

        // Check if ALL data this step provides is already available
        return step.provides.every((key) => context.hasStepResult(key as StepDataKey));
    }

    /**
     * Execute a single step
     */
    private async executeStep(
        step: PipelineStepDefinition,
        executor:
            | { type: 'builtin'; serviceId: string }
            | { type: 'plugin'; pluginId: string; stepId: string },
        context: TypedGenerationContext,
        options?: PipelineExecutionOptions,
    ): Promise<void> {
        // Create execution context with facades for step executors
        const execContext = this.createStepExecutionContext(context.directory, options?.signal);

        if (executor.type === 'builtin') {
            // Execute via DefaultPipelinePlugin
            const defaultPipeline = this.getDefaultPipelinePlugin();
            await defaultPipeline.executeStep(step.id, context, execContext, {
                timeout: options?.timeout,
                signal: options?.signal,
                settings: options?.stepSettings?.[step.id] ?? {},
            });
        } else {
            // Execute via plugin
            const plugin = await this.getPluginExecutor(executor.pluginId);
            if (!plugin) {
                throw new Error(`Plugin "${executor.pluginId}" not found for step "${step.id}"`);
            }

            // For plugin steps, pass execContext through settings
            await plugin.execute(context, {
                timeout: options?.timeout,
                signal: options?.signal,
                settings: {
                    stepId: executor.stepId,
                    execContext,
                    ...(options?.stepSettings?.[step.id] ?? {}),
                },
            });
        }
    }

    /**
     * Get plugin executor by ID
     */
    private async getPluginExecutor(pluginId: string): Promise<IPipelineStepPlugin | null> {
        const registered = this.registry.get(pluginId);
        if (!registered || registered.state !== 'enabled') {
            return null;
        }

        if (isPipelineStepPlugin(registered.plugin)) {
            return registered.plugin;
        }

        return null;
    }

    /**
     * Create step metrics for tracking execution performance
     */
    private createStepMetrics(
        step: PipelineStepDefinition,
        startTime: number,
        success: boolean,
        error?: string,
    ): StepMetrics {
        return {
            name: step.name,
            startTime,
            duration: Date.now() - startTime,
            success,
            error,
        };
    }

    /**
     * Save checkpoint for pipeline recovery
     */
    private async saveCheckpoint(
        directory: DirectoryReference,
        context: TypedGenerationContext,
        stepIndex: number,
        stepName: string,
        completedSteps: readonly string[],
    ): Promise<void> {
        if (!this.cacheManager) {
            return;
        }

        const checkpointKey = `pipeline-checkpoint-${directory.id}`;
        const checkpointData: CheckpointData = {
            stepIndex,
            stepName,
            timestamp: new Date().toISOString(),
            context: context.toSnapshot(),
            completedSteps: [...completedSteps],
        };

        try {
            await this.cacheManager.set(checkpointKey, checkpointData, CHECKPOINT_TTL_MS);
            this.logger.debug(`Saved checkpoint at step ${stepIndex}: ${stepName}`);
        } catch (error) {
            this.logger.warn(`Failed to save checkpoint: ${(error as Error).message}`);
        }
    }

    /**
     * Load checkpoint
     */
    async loadCheckpoint(directoryId: string): Promise<CheckpointData | null> {
        if (!this.cacheManager) {
            return null;
        }

        const checkpointKey = `pipeline-checkpoint-${directoryId}`;
        try {
            const data = await this.cacheManager.get<CheckpointData>(checkpointKey);
            return data ?? null;
        } catch {
            return null;
        }
    }

    /**
     * Clear checkpoint for a directory
     */
    async clearCheckpoint(directoryId: string): Promise<void> {
        if (!this.cacheManager) {
            return;
        }

        const checkpointKey = `pipeline-checkpoint-${directoryId}`;
        await this.cacheManager.del(checkpointKey);
    }

    // ============================================================================
    // Event Emission Helpers
    // ============================================================================

    private emitPipelineEvent(event: string, payload: Partial<PipelineEventPayload>): void {
        this.eventEmitter.emit(event, {
            timestamp: new Date().toISOString(),
            ...payload,
        } as PipelineEventPayload);
    }

    private emitStepEvent(
        event: string,
        step: PipelineStepDefinition,
        index: number,
        total: number,
    ): void {
        this.eventEmitter.emit(event, {
            timestamp: new Date().toISOString(),
            stepId: step.id,
            stepName: step.name,
            stepIndex: index,
            totalSteps: total,
        } as PipelineStepEventPayload);
    }

    private emitStepCompleted(
        step: PipelineStepDefinition,
        index: number,
        total: number,
        duration: number,
    ): void {
        this.eventEmitter.emit(PipelineEvents.STEP_COMPLETED, {
            timestamp: new Date().toISOString(),
            stepId: step.id,
            stepName: step.name,
            stepIndex: index,
            totalSteps: total,
            duration,
        } as PipelineStepCompletedPayload);
    }

    private emitStepFailed(
        step: PipelineStepDefinition,
        index: number,
        total: number,
        error: Error,
        recoverable: boolean,
    ): void {
        this.eventEmitter.emit(PipelineEvents.STEP_FAILED, {
            timestamp: new Date().toISOString(),
            stepId: step.id,
            stepName: step.name,
            stepIndex: index,
            totalSteps: total,
            error: error.message,
            recoverable,
        } as PipelineStepFailedPayload);
    }

    private emitStepSkipped(step: PipelineStepDefinition, index: number, total: number): void {
        this.eventEmitter.emit(PipelineEvents.STEP_SKIPPED, {
            timestamp: new Date().toISOString(),
            stepId: step.id,
            stepName: step.name,
            stepIndex: index,
            totalSteps: total,
        } as PipelineStepEventPayload);
    }

    private emitPipelineCompleted(
        directoryId: string,
        duration: number,
        stepsCompleted: number,
        context: TypedGenerationContext,
    ): void {
        this.eventEmitter.emit(PipelineEvents.COMPLETED, {
            timestamp: new Date().toISOString(),
            directoryId,
            duration,
            stepsCompleted,
            items: context.finalItems,
            categories: context.finalCategories,
            tags: context.finalTags,
            brands: context.finalBrands,
        } as PipelineCompletedPayload);
    }

    private emitPipelineFailed(
        directoryId: string,
        error: Error,
        failedStep: string | undefined,
        completedSteps: number,
    ): void {
        this.eventEmitter.emit(PipelineEvents.FAILED, {
            timestamp: new Date().toISOString(),
            directoryId,
            error: error.message,
            failedStep,
            completedSteps,
        } as PipelineFailedPayload);
    }

    // ============================================================================
    // Result Creation Helpers
    // ============================================================================

    private createSuccessResult(
        context: TypedGenerationContext,
        runner: ExecutablePipelineRunner,
        startTime: number,
    ): PipelineResult {
        return {
            success: true,
            items: context.finalItems,
            categories: context.finalCategories,
            tags: context.finalTags,
            brands: context.finalBrands,
            duration: Date.now() - startTime,
            stepsCompleted: runner.getState().completedSteps.length,
            totalSteps: runner.getPipeline().steps.length,
            state: runner.getState(),
        };
    }

    private createFailedResult(
        context: TypedGenerationContext,
        runner: ExecutablePipelineRunner,
        startTime: number,
        error: Error,
        failedStep?: string,
    ): PipelineResult {
        return {
            success: false,
            items: context.finalItems,
            categories: context.finalCategories,
            tags: context.finalTags,
            brands: context.finalBrands,
            duration: Date.now() - startTime,
            stepsCompleted: runner.getState().completedSteps.length,
            totalSteps: runner.getPipeline().steps.length,
            error,
            failedStep,
            state: runner.getState(),
        };
    }

    private createCancelledResult(
        context: TypedGenerationContext,
        runner: ExecutablePipelineRunner,
        startTime: number,
        cancelledAtStep: string,
    ): PipelineResult {
        return {
            success: false,
            items: context.finalItems,
            categories: context.finalCategories,
            tags: context.finalTags,
            brands: context.finalBrands,
            duration: Date.now() - startTime,
            stepsCompleted: runner.getState().completedSteps.length,
            totalSteps: runner.getPipeline().steps.length,
            error: `Pipeline cancelled at step: ${cancelledAtStep}`,
            failedStep: cancelledAtStep,
            state: runner.getState(),
        };
    }
}
