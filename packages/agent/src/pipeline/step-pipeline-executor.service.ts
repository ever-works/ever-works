import { Injectable, Logger, Inject, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import * as superjson from 'superjson';
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
    IDefaultPipelinePlugin,
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
    ItemData,
    Category,
    Tag,
    Brand,
    DomainAnalysis,
    WebPageData,
    AdvancedPromptsContext,
} from '@ever-works/plugin';
import { isDefaultPipelinePlugin, isPipelineStepPlugin } from '@ever-works/plugin';
import { AiFacadeService } from '../facades/ai.facade';
import { SearchFacadeService } from '../facades/search.facade';
import { ScreenshotFacadeService } from '../facades/screenshot.facade';
import { ContentExtractorFacadeService } from '../facades/content-extractor.facade';
import { DataSourceFacadeService } from '../facades/data-source.facade';
import { PipelineBuilderService } from './pipeline-builder.service';
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
 * Checkpoint data structure for pipeline recovery
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
    /** Schema version for validation */
    schemaVersion: number;
}

/**
 * Checkpoint TTL in milliseconds (24 hours)
 */
const CHECKPOINT_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Current checkpoint schema version
 * Increment when checkpoint structure changes to invalidate old checkpoints
 */
const CURRENT_CHECKPOINT_VERSION = 1;

/**
 * Context for binding facades to a specific directory/user.
 * This allows facades to automatically include directory context in their calls.
 */
interface FacadeBindingContext {
    readonly directoryId: string;
    readonly userId: string;
    readonly providerOverrides?: {
        readonly ai?: string;
        readonly search?: string;
        readonly screenshot?: string;
        readonly contentExtractor?: string;
    };
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
     * Get the default pipeline plugin from the plugin registry.
     * The plugin is loaded via the plugin system (PluginBootstrapService.bootstrap()).
     */
    private getDefaultPipelinePlugin(): IDefaultPipelinePlugin {
        const registered = this.registry.get('default-pipeline');
        if (registered && registered.state === 'enabled') {
            if (isDefaultPipelinePlugin(registered.plugin)) {
                return registered.plugin;
            }
        }

        throw new Error(
            'Default pipeline plugin not available. ' +
                'Ensure the plugin system has been initialized via PluginBootstrapService.bootstrap().',
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
                    providerOverride: ctx.providerOverrides?.ai,
                }),
            isConfigured: () => facade.isConfigured(),
            testConnection: () =>
                facade.testConnection({
                    directoryId: ctx.directoryId,
                    userId: ctx.userId,
                    providerOverride: ctx.providerOverrides?.ai,
                }),
            getAvailableModels: () =>
                facade.getAvailableModels({
                    directoryId: ctx.directoryId,
                    userId: ctx.userId,
                    providerOverride: ctx.providerOverrides?.ai,
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
                facade.search(query, options, {
                    userId: ctx.userId,
                    directoryId: ctx.directoryId,
                    providerOverride: ctx.providerOverrides?.search,
                }),
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
                    providerOverride: ctx.providerOverrides?.screenshot,
                }),
            getSmartImage: (options: SmartImageOptions): Promise<SmartImageResult> =>
                facade.getSmartImage(options, {
                    directoryId: ctx.directoryId,
                    userId: ctx.userId,
                    providerOverride: ctx.providerOverrides?.screenshot,
                }),
            getScreenshotUrl: (options: ScreenshotCaptureOptions): Promise<string | null> =>
                facade.getScreenshotUrl(options, {
                    directoryId: ctx.directoryId,
                    userId: ctx.userId,
                    providerOverride: ctx.providerOverrides?.screenshot,
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
                facade.extractContent(url, options, {
                    userId: ctx.userId,
                    directoryId: ctx.directoryId,
                    providerOverride: ctx.providerOverrides?.contentExtractor,
                }),
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
        providerOverrides?: GenerationRequest['providers'],
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

        // Create binding context with directory info and optional provider overrides
        if (!directory.user?.id) {
            throw new Error(
                'User context is required for pipeline execution. ' +
                    'Ensure DirectoryReference includes a user with an id.',
            );
        }
        const facadeContext: FacadeBindingContext = {
            directoryId: directory.id,
            userId: directory.user.id,
            providerOverrides,
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
        const context = createGenerationContext(directory, request, existing);
        return this.executeWithContext(context, options, onProgress);
    }

    private async executePipeline(
        context: TypedGenerationContext,
        options?: PipelineExecutionOptions,
        onProgress?: PipelineProgressCallback,
    ): Promise<PipelineResult> {
        const startTime = Date.now();
        const directory = context.directory;

        this.logger.log(`Starting step-based pipeline execution for directory: ${directory.id}`);

        // 1. Build the pipeline (with directory-scoped plugin resolution)
        const pipeline = await this.pipelineBuilder.build(directory.id, directory.user?.id);
        const runner = new ExecutablePipelineRunner(pipeline, this.eventEmitter);

        // 2. Emit pipeline:started event (Task 3.19)
        this.emitPipelineEvent(PipelineEvents.STARTED, {
            directoryId: directory.id,
        });

        // 3. Start execution tracking
        runner.startExecution();

        let lastCompletedStepIndex = -1;
        let currentStepIndex = 0;

        try {
            // 4. Execute groups in order (Task 3.19)
            // We iterate over groups to allow parallel execution of steps within a group
            for (const group of pipeline.groups) {
                // Check for cancellation
                if (options?.signal?.aborted) {
                    this.logger.log(`Pipeline cancelled before group ${group.id}`);
                    runner.cancelExecution();
                    this.emitPipelineEvent(PipelineEvents.CANCELLED, {
                        directoryId: directory.id,
                    });
                    // Determine which step would have been next
                    const nextStep = group.stepIds[0];
                    return this.createCancelledResult(context, runner, startTime, nextStep);
                }

                // Get steps for this group
                const groupSteps = group.stepIds
                    .map((id) => pipeline.steps.find((s) => s.id === id))
                    .filter((s): s is PipelineStepDefinition => s !== undefined);

                if (groupSteps.length === 0) continue;

                // Execute steps in the group (parallel or sequential)
                // Use Promise.all to run all steps in the group concurrently
                const stepPromises = groupSteps.map((step) =>
                    this.processStep(
                        step,
                        pipeline,
                        runner,
                        context,
                        currentStepIndex + groupSteps.indexOf(step),
                        pipeline.steps.length,
                        options,
                        onProgress,
                    ),
                );

                // Wait for all steps in the group to complete
                await Promise.all(stepPromises);

                // Increment index
                currentStepIndex += groupSteps.length;
                lastCompletedStepIndex = currentStepIndex - 1;

                // Check if shouldStop is set (from any step in the group)
                if (context.shouldStop) {
                    this.logger.log(`Pipeline stopped by a step in group ${group.id}`);
                    break;
                }
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

            // We can't easily know exactly which step failed in the main catch block
            // because of parallel execution, but the individual processStep catches errors.
            // If we got here, it means a non-optional step failed and re-threw the error.
            const failedStep = pipeline.steps[currentStepIndex]?.id;

            // Emit pipeline:failed event (Task 3.19)
            this.emitPipelineFailed(
                directory.id,
                error as Error,
                failedStep,
                lastCompletedStepIndex + 1,
            );

            this.logger.error(`Pipeline failed: ${(error as Error).message}`);

            return this.createFailedResult(context, runner, startTime, error as Error, failedStep);
        }
    }

    /**
     * Process a single step with error handling, metrics, and events
     */
    private async processStep(
        step: PipelineStepDefinition,
        pipeline: any, // Typed as ExecutablePipeline but avoiding circular import in private method signature if strictly typed
        runner: ExecutablePipelineRunner,
        context: TypedGenerationContext,
        stepIndex: number,
        totalSteps: number,
        options?: PipelineExecutionOptions,
        onProgress?: PipelineProgressCallback,
    ): Promise<void> {
        const directory = context.directory;

        // Check if step should be skipped via options
        if (options?.skipSteps?.includes(step.id)) {
            this.logger.debug(`Skipping step "${step.id}" (in skipSteps)`);
            runner.markStepSkipped(step.id, 'skipped by options');
            this.emitStepSkipped(step, stepIndex, totalSteps);
            return;
        }

        // Check if onlySteps is specified and this step is not in it
        if (options?.onlySteps && !options.onlySteps.includes(step.id)) {
            this.logger.debug(`Skipping step "${step.id}" (not in onlySteps)`);
            runner.markStepSkipped(step.id, 'not in onlySteps');
            return;
        }

        // Check if step can be skipped (data already provided)
        if (await this.canSkipStep(step, context)) {
            this.logger.debug(`Skipping step "${step.id}" (data already provided)`);
            runner.markStepSkipped(step.id, 'data already provided');
            this.emitStepSkipped(step, stepIndex, totalSteps);
            return;
        }

        // Emit step:started event (Task 3.19)
        runner.startStep(step.id);
        this.emitStepEvent(PipelineEvents.STEP_STARTED, step, stepIndex, totalSteps);

        // Report progress
        if (onProgress) {
            onProgress({
                percent: Math.round((stepIndex / totalSteps) * 100),
                currentStepIndex: stepIndex,
                totalSteps: totalSteps,
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
                stepIndex,
                step.name,
                runner.getState().completedSteps,
            );

            // Emit step:completed event (Task 3.19)
            this.emitStepCompleted(step, stepIndex, totalSteps, metrics.duration ?? 0);
        } catch (error) {
            const err = error as Error;
            const metrics = this.createStepMetrics(step, stepStartTime, false, err.message);
            context.recordStepMetrics(step.id, metrics);
            runner.markStepFailed(step.id, err);

            // Emit step:failed event (Task 3.19)
            this.emitStepFailed(step, stepIndex, totalSteps, err, step.optional ?? false);

            if (!options?.continueOnError && !step.optional) {
                throw err;
            }

            this.logger.warn(`Step "${step.id}" failed but continuing: ${err.message}`);
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
        return this.executePipeline(context, options, onProgress);
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

        const context = TypedGenerationContext.fromSnapshot(checkpoint.context);

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
        // Pass provider overrides from the generation request so user-selected providers are used
        const execContext = this.createStepExecutionContext(
            context.directory,
            context.request.providers,
            options?.signal,
        );

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
        const snapshot = context.toSnapshot();

        const checkpointData: CheckpointData = {
            stepIndex,
            stepName,
            timestamp: new Date().toISOString(),
            context: snapshot,
            completedSteps: [...completedSteps],
            schemaVersion: CURRENT_CHECKPOINT_VERSION,
        };

        // Serialize with superjson to handle Sets, Maps, Dates, etc.
        const serialized = superjson.stringify(checkpointData);

        try {
            await this.cacheManager.set(checkpointKey, serialized, CHECKPOINT_TTL_MS);
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
            const serialized = await this.cacheManager.get<string>(checkpointKey);

            if (!serialized) {
                return null;
            }

            // Deserialize with superjson to restore Sets, Maps, Dates, etc.
            const data = superjson.parse<CheckpointData>(serialized);

            // Validate schema version
            const schemaVersion = data.schemaVersion ?? 0;
            if (schemaVersion !== CURRENT_CHECKPOINT_VERSION) {
                this.logger.warn(
                    `Checkpoint schema version mismatch for directory ${directoryId}: ` +
                        `expected ${CURRENT_CHECKPOINT_VERSION}, got ${schemaVersion}. ` +
                        `Clearing incompatible checkpoint.`,
                );
                await this.cacheManager.del(checkpointKey);
                return null;
            }

            return data;
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
