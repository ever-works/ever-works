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
    IPipelinePlugin,
    IPipelineModifierPlugin,
    PipelineEventPayload,
    PipelineStepEventPayload,
    PipelineStepCompletedPayload,
    PipelineStepFailedPayload,
    PipelineCompletedPayload,
    PipelineFailedPayload,
    GenerationContextSnapshot,
} from '@ever-works/plugin';
import { isPipelineModifierPlugin } from '@ever-works/plugin';
import { PipelineBuilderService } from './pipeline-builder.service';
import { PipelineFacadeService } from './pipeline-facade.service';
import { PluginRegistryService } from '../plugins/services/plugin-registry.service';
import { TypedGenerationContext } from './generation-context';
import { ExecutablePipelineRunner } from './executable-pipeline.class';

/**
 * Checkpoint data structure for pipeline recovery.
 */
export interface CheckpointData {
    /** Index of the last completed step */
    stepIndex: number;
    /** Name of the last completed step */
    stepName: string;
    /** Pipeline plugin ID that created this checkpoint */
    pipelineId: string;
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
const CURRENT_CHECKPOINT_VERSION = 3;

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
 * This service executes engine-orchestratable pipelines step by step, supporting:
 * - Built-in steps via IPipelinePlugin.executeStep()
 * - Plugin-provided steps via IPipelineModifierPlugin
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
        private readonly facadeService: PipelineFacadeService,
        @Optional() @Inject(CACHE_MANAGER) private readonly cacheManager?: Cache,
    ) {}

    /**
     * Execute the pipeline for a directory.
     *
     * @param plugin - The resolved pipeline plugin instance
     * @param directory - Directory reference
     * @param request - Generation request parameters
     * @param existing - Existing items in directory
     * @param options - Execution options
     * @param onProgress - Progress callback
     * @returns Pipeline execution result
     */
    async execute(
        plugin: IPipelinePlugin,
        directory: DirectoryReference,
        request: GenerationRequest,
        existing: ExistingItems,
        options?: PipelineExecutionOptions,
        onProgress?: PipelineProgressCallback,
    ): Promise<PipelineResult> {
        const context = new TypedGenerationContext(directory, request, existing);
        return this.executePipeline(plugin, context, options, onProgress);
    }

    private async executePipeline(
        plugin: IPipelinePlugin,
        context: TypedGenerationContext,
        options?: PipelineExecutionOptions,
        onProgress?: PipelineProgressCallback,
    ): Promise<PipelineResult> {
        const startTime = Date.now();
        const directory = context.directory;

        this.logger.log(
            `Starting step-based pipeline execution for directory: ${directory.id} via plugin: ${plugin.id}`,
        );

        // 1. Build the pipeline (with directory-scoped plugin resolution)
        const pipeline = await this.pipelineBuilder.build(plugin, directory.id, directory.user?.id);
        const runner = new ExecutablePipelineRunner(pipeline, this.eventEmitter);

        // 2. Emit pipeline:started event
        this.emitPipelineEvent(PipelineEvents.STARTED, {
            directoryId: directory.id,
            pipelineId: plugin.id,
        });

        // 3. Start execution tracking
        runner.startExecution();

        let lastCompletedStepIndex = -1;
        let currentStepIndex = 0;

        try {
            // 4. Execute groups in order
            for (const group of pipeline.groups) {
                // Check for cancellation
                if (options?.signal?.aborted) {
                    this.logger.log(`Pipeline cancelled before group ${group.id}`);
                    runner.cancelExecution();
                    this.emitPipelineEvent(PipelineEvents.CANCELLED, {
                        directoryId: directory.id,
                    });
                    const nextStep = group.stepIds[0];
                    return this.createCancelledResult(context, runner, startTime, nextStep);
                }

                // Get steps for this group
                const groupSteps = group.stepIds
                    .map((id) => pipeline.steps.find((s) => s.id === id))
                    .filter((s): s is PipelineStepDefinition => s !== undefined);

                if (groupSteps.length === 0) continue;

                // Execute steps in the group (parallel or sequential)
                const stepPromises = groupSteps.map((step) =>
                    this.processStep(
                        step,
                        pipeline,
                        plugin,
                        runner,
                        context,
                        currentStepIndex + groupSteps.indexOf(step),
                        pipeline.steps.length,
                        plugin.id,
                        options,
                        onProgress,
                    ),
                );

                await Promise.all(stepPromises);

                currentStepIndex += groupSteps.length;
                lastCompletedStepIndex = currentStepIndex - 1;

                if (context.shouldStop) {
                    this.logger.log(`Pipeline stopped by a step in group ${group.id}`);
                    break;
                }
            }

            // 5. Complete execution
            runner.completeExecution();

            context.updateMetrics({
                duration: Date.now() - startTime,
                itemsProcessed: context.finalItems.length,
            });

            this.emitPipelineCompleted(
                directory.id,
                Date.now() - startTime,
                runner.getState().completedSteps.length,
                context,
                plugin.id,
            );

            this.logger.log(
                `Pipeline completed: ${runner.getState().completedSteps.length}/${pipeline.steps.length} steps`,
            );

            await this.clearCheckpoint(directory.id, plugin.id);

            return this.createSuccessResult(context, runner, startTime);
        } catch (error) {
            runner.completeExecution();

            const failedStep = pipeline.steps[currentStepIndex]?.id;

            this.emitPipelineFailed(
                directory.id,
                error as Error,
                failedStep,
                lastCompletedStepIndex + 1,
                plugin.id,
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
        pipeline: any,
        plugin: IPipelinePlugin,
        runner: ExecutablePipelineRunner,
        context: TypedGenerationContext,
        stepIndex: number,
        totalSteps: number,
        pipelineId: string,
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

        // Emit step:started event
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

            await this.executeStep(step, executor, plugin, context, options);

            // Record metrics
            const metrics = this.createStepMetrics(step, stepStartTime, true);
            context.recordStepMetrics(step.id, metrics);
            runner.markStepComplete(step.id, metrics);

            // Engine-level circuit breaker (safety net after data-producing steps)
            if (
                this.shouldCircuitBreak(
                    step,
                    context,
                    pipeline.steps,
                    runner.getState().completedSteps,
                )
            ) {
                context.warnings.push(
                    `Pipeline stopped after "${step.name}": no data produced. Check provider configuration.`,
                );
                context.shouldStop = true;
            }

            // Save checkpoint
            await this.saveCheckpoint(
                directory,
                pipelineId,
                context,
                stepIndex,
                step.name,
                runner.getState().completedSteps,
            );

            // Emit step:completed event
            this.emitStepCompleted(step, stepIndex, totalSteps, metrics.duration ?? 0);
        } catch (error) {
            const err = error as Error;
            const metrics = this.createStepMetrics(step, stepStartTime, false, err.message);
            context.recordStepMetrics(step.id, metrics);
            runner.markStepFailed(step.id, err);

            // Emit step:failed event
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
        plugin: IPipelinePlugin,
        context: TypedGenerationContext,
        options?: PipelineExecutionOptions,
        onProgress?: PipelineProgressCallback,
    ): Promise<PipelineResult> {
        return this.executePipeline(plugin, context, options, onProgress);
    }

    /**
     * Resume pipeline from checkpoint
     */
    async resumeFromCheckpoint(
        plugin: IPipelinePlugin,
        directoryId: string,
        pipelineId: string,
        options?: PipelineExecutionOptions,
        onProgress?: PipelineProgressCallback,
    ): Promise<PipelineResult | null> {
        const checkpoint = await this.loadCheckpoint(directoryId, pipelineId);
        if (!checkpoint) {
            this.logger.warn(`No checkpoint found for directory: ${directoryId}`);
            return null;
        }

        const stepDefinitions = plugin.getStepDefinitions();
        if (!this.isCheckpointViable(checkpoint, stepDefinitions)) {
            this.logger.warn(
                `Checkpoint for directory ${directoryId} has no meaningful data. Discarding.`,
            );
            await this.clearCheckpoint(directoryId, pipelineId);
            return null;
        }

        this.logger.log(
            `Resuming pipeline from checkpoint at step ${checkpoint.stepIndex}: ${checkpoint.stepName}`,
        );

        const context = TypedGenerationContext.fromSnapshot(checkpoint.context);

        const resumeOptions: PipelineExecutionOptions = {
            ...options,
            skipSteps: checkpoint.completedSteps,
        };

        return this.executeWithContext(plugin, context, resumeOptions, onProgress);
    }

    /**
     * Check if step can be skipped because data is already provided
     */
    private async canSkipStep(
        step: PipelineStepDefinition,
        context: TypedGenerationContext,
    ): Promise<boolean> {
        if (!step.provides?.length) {
            return false;
        }

        return step.provides.every((key) => context.hasStepResult(key as StepDataKey));
    }

    /**
     * Execute a single step
     */
    private async executeStep(
        step: PipelineStepDefinition,
        executor:
            | { type: 'builtin'; serviceId: string; pluginId?: string }
            | { type: 'plugin'; pluginId: string; stepId: string },
        plugin: IPipelinePlugin,
        context: TypedGenerationContext,
        options?: PipelineExecutionOptions,
    ): Promise<void> {
        // Create execution context with bound facades
        const execContext = this.facadeService.createStepExecutionContext(
            context.directory,
            context.request.providers,
            options?.signal,
        );

        if (executor.type === 'builtin') {
            // Execute via the pipeline plugin's own executeStep method
            await plugin.executeStep!(step.id, context, execContext, {
                timeout: options?.timeout,
                signal: options?.signal,
                settings: options?.stepSettings?.[step.id] ?? {},
            });
        } else {
            // Execute via modifier plugin
            const modifierPlugin = this.getModifierPluginExecutor(executor.pluginId);
            if (!modifierPlugin) {
                throw new Error(
                    `Modifier plugin "${executor.pluginId}" not found for step "${step.id}"`,
                );
            }

            await modifierPlugin.execute(context, {
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
     * Get modifier plugin executor by ID
     */
    private getModifierPluginExecutor(pluginId: string): IPipelineModifierPlugin | null {
        const registered = this.registry.get(pluginId);
        if (!registered || registered.state !== 'loaded') {
            return null;
        }

        if (isPipelineModifierPlugin(registered.plugin)) {
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
        pipelineId: string,
        context: TypedGenerationContext,
        stepIndex: number,
        stepName: string,
        completedSteps: readonly string[],
    ): Promise<void> {
        if (!this.cacheManager) {
            return;
        }

        const checkpointKey = `pipeline-checkpoint-${directory.id}-${pipelineId}`;
        const snapshot = context.toSnapshot();

        const checkpointData: CheckpointData = {
            stepIndex,
            stepName,
            pipelineId,
            timestamp: new Date().toISOString(),
            context: snapshot,
            completedSteps: [...completedSteps],
            schemaVersion: CURRENT_CHECKPOINT_VERSION,
        };

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
    async loadCheckpoint(directoryId: string, pipelineId: string): Promise<CheckpointData | null> {
        if (!this.cacheManager) {
            return null;
        }

        const checkpointKey = `pipeline-checkpoint-${directoryId}-${pipelineId}`;
        try {
            const serialized = await this.cacheManager.get<string>(checkpointKey);

            if (!serialized) {
                return null;
            }

            const data = superjson.parse<CheckpointData>(serialized);

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
    async clearCheckpoint(directoryId: string, pipelineId: string): Promise<void> {
        if (!this.cacheManager) {
            return;
        }

        const checkpointKey = `pipeline-checkpoint-${directoryId}-${pipelineId}`;
        await this.cacheManager.del(checkpointKey);
    }

    // ============================================================================
    // Circuit Breaker & Checkpoint Validation
    // ============================================================================

    private static readonly DATA_KEYS: ReadonlySet<string> = new Set([
        'webPages',
        'initialAiItems',
        'extractedWebItems',
        'aggregatedItems',
        'finalItems',
    ]);

    private static readonly MIN_DATA_STEPS_FOR_CIRCUIT_BREAK = 3;

    private isDataProvidingStep(step: PipelineStepDefinition): boolean {
        return (
            step.provides?.some((key) => StepPipelineExecutorService.DATA_KEYS.has(key)) ?? false
        );
    }

    private hasAnyData(context: TypedGenerationContext): boolean {
        return (
            context.webPages.length > 0 ||
            context.initialAiItems.length > 0 ||
            context.extractedWebItems.length > 0 ||
            context.aggregatedItems.length > 0 ||
            context.finalItems.length > 0
        );
    }

    private shouldCircuitBreak(
        step: PipelineStepDefinition,
        context: TypedGenerationContext,
        allSteps: readonly PipelineStepDefinition[],
        completedStepIds: readonly string[],
    ): boolean {
        if (!this.isDataProvidingStep(step)) {
            return false;
        }

        const completedDataStepCount = allSteps.filter(
            (s) => completedStepIds.includes(s.id) && this.isDataProvidingStep(s),
        ).length;

        if (completedDataStepCount < StepPipelineExecutorService.MIN_DATA_STEPS_FOR_CIRCUIT_BREAK) {
            return false;
        }

        return !this.hasAnyData(context);
    }

    private hasSnapshotData(ctx: GenerationContextSnapshot): boolean {
        return (
            ctx.webPages.length > 0 ||
            ctx.initialAiItems.length > 0 ||
            ctx.extractedWebItems.length > 0 ||
            ctx.aggregatedItems.length > 0 ||
            ctx.finalItems.length > 0
        );
    }

    private isCheckpointViable(
        checkpoint: CheckpointData,
        stepDefinitions: readonly PipelineStepDefinition[],
    ): boolean {
        if (checkpoint.context.shouldStop) {
            return false;
        }

        if (this.hasSnapshotData(checkpoint.context)) {
            return true;
        }

        // Check if any completed step was supposed to produce data
        const completedDataSteps = stepDefinitions.filter(
            (s) => checkpoint.completedSteps.includes(s.id) && this.isDataProvidingStep(s),
        );

        return completedDataSteps.length === 0;
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
        source: string,
    ): void {
        this.eventEmitter.emit(PipelineEvents.COMPLETED, {
            timestamp: new Date().toISOString(),
            directoryId,
            pipelineId: source,
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
        source: string,
    ): void {
        this.eventEmitter.emit(PipelineEvents.FAILED, {
            timestamp: new Date().toISOString(),
            directoryId,
            pipelineId: source,
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
        const hasItems = context.finalItems.length > 0;
        const warnings = context.warnings.length > 0 ? context.warnings : undefined;

        return {
            success: hasItems,
            items: context.finalItems,
            categories: context.finalCategories,
            tags: context.finalTags,
            brands: context.finalBrands,
            duration: Date.now() - startTime,
            stepsCompleted: runner.getState().completedSteps.length,
            totalSteps: runner.getPipeline().steps.length,
            state: runner.getState(),
            warnings,
            error: hasItems ? undefined : 'Pipeline completed but generated no items.',
        };
    }

    private createFailedResult(
        context: TypedGenerationContext,
        runner: ExecutablePipelineRunner,
        startTime: number,
        error: Error,
        failedStep?: string,
    ): PipelineResult {
        const warnings = context.warnings.length > 0 ? context.warnings : undefined;

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
            warnings,
        };
    }

    private createCancelledResult(
        context: TypedGenerationContext,
        runner: ExecutablePipelineRunner,
        startTime: number,
        cancelledAtStep: string,
    ): PipelineResult {
        const warnings = context.warnings.length > 0 ? context.warnings : undefined;

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
            warnings,
        };
    }
}
