import { Injectable, Logger, Inject, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import * as superjson from 'superjson';
import type {
    WorkReference,
    GenerationRequest,
    ExistingItems,
    IPipelineContext,
    PipelineExecutionOptions,
    PipelineProgressCallback,
    PipelineResult,
    PipelineStepDefinition,
    StepMetrics,
    IPipelinePlugin,
    IPipelineModifierPlugin,
    PipelineEventPayload,
    PipelineStepEventPayload,
    PipelineStepCompletedPayload,
    PipelineStepFailedPayload,
    PipelineCompletedPayload,
    PipelineFailedPayload,
    ExecutablePipeline,
} from '@ever-works/plugin';
import {
    buildErrorPipelineResult,
    buildSuccessPipelineResult,
    createEmptyPipelineOutputs,
    isPipelineModifierPlugin,
} from '@ever-works/plugin';
import type { GenerationStepLog } from '@ever-works/contracts/api';
import { PipelineBuilderService } from './pipeline-builder.service';
import { PipelineFacadeService } from './pipeline-facade.service';
import { PluginRegistryService } from '../plugins/services/plugin-registry.service';
import { PluginContextFactoryService } from '../plugins/services/plugin-context-factory.service';
import { ExecutablePipelineRunner } from './executable-pipeline.class';

export interface CheckpointData {
    stepIndex: number;
    stepName: string;
    pipelineId: string;
    timestamp: string;
    context: unknown;
    completedSteps: string[];
    schemaVersion: number;
}

const CHECKPOINT_TTL_MS = 24 * 60 * 60 * 1000;
const CURRENT_CHECKPOINT_VERSION = 4;
const STEP_LOG_PREFIX_BY_EVENT: Record<
    Extract<
        GenerationStepLog['event'],
        'step_started' | 'step_completed' | 'step_failed' | 'step_skipped'
    >,
    string
> = {
    step_started: 'Step started',
    step_completed: 'Step completed',
    step_failed: 'Step failed',
    step_skipped: 'Step skipped',
};

type EmitLogEntryOptions = {
    onLogEntry?: (log: GenerationStepLog) => void;
    event: GenerationStepLog['event'];
    message: string;
    stepIndex: number;
    level: GenerationStepLog['level'];
    source: GenerationStepLog['source'];
    durationMs?: number;
    stepName?: string;
};

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
 * Context-agnostic step-based pipeline executor.
 *
 * The engine delegates context creation, snapshotting, result extraction,
 * and skip/circuit-breaker logic to the pipeline plugin via lifecycle hooks.
 */
@Injectable()
export class StepPipelineExecutorService {
    private readonly logger = new Logger(StepPipelineExecutorService.name);

    constructor(
        private readonly pipelineBuilder: PipelineBuilderService,
        private readonly registry: PluginRegistryService,
        private readonly eventEmitter: EventEmitter2,
        private readonly facadeService: PipelineFacadeService,
        private readonly contextFactory: PluginContextFactoryService,
        @Optional() @Inject(CACHE_MANAGER) private readonly cacheManager?: Cache,
    ) {}

    async execute(
        plugin: IPipelinePlugin,
        work: WorkReference,
        request: GenerationRequest,
        existing: ExistingItems,
        options?: PipelineExecutionOptions,
        onProgress?: PipelineProgressCallback,
    ): Promise<PipelineResult> {
        if (!plugin.createContext) {
            throw new Error(
                `Pipeline plugin "${plugin.id}" must implement createContext() for engine-orchestrated execution.`,
            );
        }
        const context = plugin.createContext(work, request, existing);

        // Attach log interceptor to capture ALL plugin logger output
        const onLogEntry = options?.onLogEntry;
        let removeInterceptor: (() => void) | undefined;
        if (onLogEntry) {
            removeInterceptor = this.contextFactory.addLogInterceptor(
                plugin.id,
                (level: string, message: string) => {
                    onLogEntry({
                        timestamp: new Date().toISOString(),
                        level: level as GenerationStepLog['level'],
                        source: 'pipeline',
                        event: 'message',
                        message,
                    });
                },
            );
        }

        try {
            return await this.executePipeline(plugin, context, options, onProgress);
        } finally {
            removeInterceptor?.();
        }
    }

    private async executePipeline(
        plugin: IPipelinePlugin,
        context: IPipelineContext,
        options?: PipelineExecutionOptions,
        onProgress?: PipelineProgressCallback,
    ): Promise<PipelineResult> {
        const startTime = Date.now();
        const work = context.work;

        this.logger.log(
            `Starting step-based pipeline execution for work: ${work.id} via plugin: ${plugin.id}`,
        );

        const pipeline = await this.pipelineBuilder.build(plugin, work.id, work.user?.id);
        const runner = new ExecutablePipelineRunner(pipeline, this.eventEmitter);

        this.emitPipelineEvent(PipelineEvents.STARTED, {
            workId: work.id,
            pipelineId: plugin.id,
        });

        runner.startExecution();

        let lastCompletedStepIndex = -1;
        let currentStepIndex = 0;

        try {
            for (const group of pipeline.groups) {
                if (options?.signal?.aborted) {
                    this.logger.log(`Pipeline cancelled before group ${group.id}`);
                    runner.cancelExecution();
                    this.emitPipelineEvent(PipelineEvents.CANCELLED, {
                        workId: work.id,
                    });
                    return this.buildResult(plugin, context, runner, startTime, {
                        error: `Pipeline cancelled at step: ${group.stepIds[0]}`,
                        failedStep: group.stepIds[0],
                    });
                }

                const groupSteps = group.stepIds
                    .map((id) => pipeline.steps.find((s) => s.id === id))
                    .filter((s): s is PipelineStepDefinition => s !== undefined);

                if (groupSteps.length === 0) continue;

                const concurrency = this.resolveGroupConcurrency(group.maxConcurrent, options);
                if (!concurrency || concurrency >= groupSteps.length) {
                    await Promise.all(
                        groupSteps.map((step, idx) =>
                            this.processStep(
                                step,
                                pipeline,
                                plugin,
                                runner,
                                context,
                                currentStepIndex + idx,
                                pipeline.steps.length,
                                plugin.id,
                                options,
                                onProgress,
                            ),
                        ),
                    );
                } else {
                    const stepThunks = groupSteps.map(
                        (step, idx) => () =>
                            this.processStep(
                                step,
                                pipeline,
                                plugin,
                                runner,
                                context,
                                currentStepIndex + idx,
                                pipeline.steps.length,
                                plugin.id,
                                options,
                                onProgress,
                            ),
                    );
                    await this.runWithConcurrencyLimit(stepThunks, concurrency);
                }

                currentStepIndex += groupSteps.length;
                lastCompletedStepIndex = currentStepIndex - 1;

                if (context.shouldStop) {
                    this.logger.log(`Pipeline stopped by a step in group ${group.id}`);
                    break;
                }
            }

            runner.completeExecution();
            const result = this.buildResult(plugin, context, runner, startTime);

            this.emitPipelineCompleted(
                work.id,
                Date.now() - startTime,
                runner.getState().completedSteps.length,
                result,
                plugin.id,
            );

            this.logger.log(
                `Pipeline completed: ${runner.getState().completedSteps.length}/${pipeline.steps.length} steps`,
            );

            await this.clearCheckpoint(work.id, plugin.id);

            return result;
        } catch (error) {
            runner.completeExecution();
            const failedStep = pipeline.steps[currentStepIndex]?.id;

            this.emitPipelineFailed(
                work.id,
                error as Error,
                failedStep,
                lastCompletedStepIndex + 1,
                plugin.id,
            );

            this.logger.error(`Pipeline failed: ${(error as Error).message}`);

            return this.buildResult(plugin, context, runner, startTime, {
                error: error as Error,
                failedStep,
            });
        }
    }

    private async processStep(
        step: PipelineStepDefinition,
        pipeline: ExecutablePipeline,
        plugin: IPipelinePlugin,
        runner: ExecutablePipelineRunner,
        context: IPipelineContext,
        stepIndex: number,
        totalSteps: number,
        pipelineId: string,
        options?: PipelineExecutionOptions,
        onProgress?: PipelineProgressCallback,
    ): Promise<void> {
        const onLogEntry = options?.onLogEntry;

        if (options?.skipSteps?.includes(step.id)) {
            this.logger.debug(`Skipping step "${step.id}" (in skipSteps)`);
            runner.markStepSkipped(step.id, 'skipped by options');
            this.emitStepSkipped(step, stepIndex, totalSteps);
            this.emitLogEntry({
                onLogEntry,
                event: 'step_skipped',
                message: step.name,
                stepIndex,
                level: 'info',
                source: 'pipeline',
                stepName: step.name,
            });
            return;
        }

        if (options?.onlySteps && !options.onlySteps.includes(step.id)) {
            this.logger.debug(`Skipping step "${step.id}" (not in onlySteps)`);
            runner.markStepSkipped(step.id, 'not in onlySteps');
            return;
        }

        if (plugin.canSkipStep?.(step.id, context)) {
            this.logger.debug(`Skipping step "${step.id}" (data already provided)`);
            runner.markStepSkipped(step.id, 'data already provided');
            this.emitStepSkipped(step, stepIndex, totalSteps);
            this.emitLogEntry({
                onLogEntry,
                event: 'step_skipped',
                message: step.name,
                stepIndex,
                level: 'info',
                source: 'pipeline',
                stepName: step.name,
            });
            return;
        }

        runner.startStep(step.id);
        this.emitStepEvent(PipelineEvents.STEP_STARTED, step, stepIndex, totalSteps);
        this.emitLogEntry({
            onLogEntry,
            event: 'step_started',
            message: step.name,
            stepIndex,
            level: 'info',
            source: 'pipeline',
            stepName: step.name,
        });

        if (onProgress) {
            onProgress({
                percent: Math.round((stepIndex / totalSteps) * 100),
                currentStepIndex: stepIndex,
                totalSteps,
                currentStepName: step.name,
                message: `Executing: ${step.name}`,
            });
        }

        const stepStartTime = Date.now();

        try {
            const executor = pipeline.executorMap.get(step.id);
            if (!executor) {
                throw new Error(`No executor found for step "${step.id}"`);
            }

            await this.executeStep(step, executor, plugin, context, options);

            const durationMs = Date.now() - stepStartTime;
            const metrics = this.createStepMetrics(step, stepStartTime, true);
            runner.markStepComplete(step.id, metrics);

            await this.saveCheckpoint(
                plugin,
                context.work,
                pipelineId,
                context,
                stepIndex,
                step.name,
                runner.getState().completedSteps,
            );

            this.emitStepCompleted(step, stepIndex, totalSteps, metrics.duration ?? 0);
            this.emitLogEntry({
                onLogEntry,
                event: 'step_completed',
                message: step.name,
                stepIndex,
                level: 'info',
                source: 'pipeline',
                durationMs,
                stepName: step.name,
            });
        } catch (error) {
            const err = error as Error;
            const metrics = this.createStepMetrics(step, stepStartTime, false, err.message);
            runner.markStepFailed(step.id, err);

            this.emitStepFailed(step, stepIndex, totalSteps, err, step.optional ?? false);
            this.emitLogEntry({
                onLogEntry,
                event: 'step_failed',
                message: `${step.name}: ${err.message}`,
                stepIndex,
                level: 'error',
                source: 'pipeline',
                stepName: step.name,
            });

            if (!options?.continueOnError && !step.optional) {
                throw err;
            }

            this.logger.warn(`Step "${step.id}" failed but continuing: ${err.message}`);
        }
    }

    async executeWithContext(
        plugin: IPipelinePlugin,
        context: IPipelineContext,
        options?: PipelineExecutionOptions,
        onProgress?: PipelineProgressCallback,
    ): Promise<PipelineResult> {
        return this.executePipeline(plugin, context, options, onProgress);
    }

    async resumeFromCheckpoint(
        plugin: IPipelinePlugin,
        workId: string,
        pipelineId: string,
        options?: PipelineExecutionOptions,
        onProgress?: PipelineProgressCallback,
    ): Promise<PipelineResult | null> {
        const checkpoint = await this.loadCheckpoint(workId, pipelineId);
        if (!checkpoint) {
            this.logger.warn(`No checkpoint found for work: ${workId}`);
            return null;
        }

        const viable =
            plugin.isCheckpointViable?.(checkpoint.context, checkpoint.completedSteps) ?? true;

        if (!viable) {
            this.logger.warn(`Checkpoint for work ${workId} is not viable. Discarding.`);
            await this.clearCheckpoint(workId, pipelineId);
            return null;
        }

        if (!plugin.contextFromSnapshot) {
            this.logger.warn(
                `Pipeline plugin "${plugin.id}" does not implement contextFromSnapshot(). Cannot resume.`,
            );
            await this.clearCheckpoint(workId, pipelineId);
            return null;
        }

        this.logger.log(
            `Resuming pipeline from checkpoint at step ${checkpoint.stepIndex}: ${checkpoint.stepName}`,
        );

        const context = plugin.contextFromSnapshot(checkpoint.context);

        const resumeOptions: PipelineExecutionOptions = {
            ...options,
            skipSteps: checkpoint.completedSteps,
        };

        return this.executeWithContext(plugin, context, resumeOptions, onProgress);
    }

    private async executeStep(
        step: PipelineStepDefinition,
        executor:
            | { type: 'builtin'; serviceId: string; pluginId?: string }
            | { type: 'plugin'; pluginId: string; stepId: string },
        plugin: IPipelinePlugin,
        context: IPipelineContext,
        options?: PipelineExecutionOptions,
    ): Promise<void> {
        const execContext = this.facadeService.createStepExecutionContext(
            context.work,
            context.request.providers,
            context.request.aiModel,
            options?.signal,
        );

        if (executor.type === 'builtin') {
            await plugin.executeStep!(step.id, context, execContext, {
                timeout: options?.timeout,
                signal: options?.signal,
                settings: options?.stepSettings?.[step.id] ?? {},
            });
        } else {
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

    private getModifierPluginExecutor(pluginId: string): IPipelineModifierPlugin | null {
        const registered = this.registry.get(pluginId);
        if (!registered || registered.state !== 'loaded') {
            return null;
        }
        return isPipelineModifierPlugin(registered.plugin) ? registered.plugin : null;
    }

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

    private async runWithConcurrencyLimit(
        tasks: Array<() => Promise<void>>,
        limit: number,
    ): Promise<void> {
        const executing = new Set<Promise<void>>();
        for (const task of tasks) {
            const p = task().finally(() => executing.delete(p));
            executing.add(p);
            if (executing.size >= limit) {
                await Promise.race(executing);
            }
        }
        await Promise.all(executing);
    }

    private resolveGroupConcurrency(
        groupConcurrency: number | undefined,
        options?: PipelineExecutionOptions,
    ): number | undefined {
        if (options?.maxConcurrent !== undefined) {
            return Math.max(1, Math.floor(options.maxConcurrent));
        }
        return groupConcurrency;
    }

    // ============================================================================
    // Checkpoint Management
    // ============================================================================

    private async saveCheckpoint(
        plugin: IPipelinePlugin,
        work: WorkReference,
        pipelineId: string,
        context: IPipelineContext,
        stepIndex: number,
        stepName: string,
        completedSteps: readonly string[],
    ): Promise<void> {
        if (!this.cacheManager || !plugin.contextToSnapshot) {
            return;
        }

        const checkpointKey = `pipeline-checkpoint-${work.id}-${pipelineId}`;
        const snapshot = plugin.contextToSnapshot(context);

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

    async loadCheckpoint(workId: string, pipelineId: string): Promise<CheckpointData | null> {
        if (!this.cacheManager) {
            return null;
        }

        const checkpointKey = `pipeline-checkpoint-${workId}-${pipelineId}`;
        try {
            const serialized = await this.cacheManager.get<string>(checkpointKey);
            if (!serialized) {
                return null;
            }

            const data = superjson.parse<CheckpointData>(serialized);
            const schemaVersion = data.schemaVersion ?? 0;
            if (schemaVersion !== CURRENT_CHECKPOINT_VERSION) {
                this.logger.warn(
                    `Checkpoint schema version mismatch for work ${workId}: ` +
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

    async clearCheckpoint(workId: string, pipelineId: string): Promise<void> {
        if (!this.cacheManager) {
            return;
        }
        await this.cacheManager.del(`pipeline-checkpoint-${workId}-${pipelineId}`);
    }

    // ============================================================================
    // Result Building
    // ============================================================================

    private buildResult(
        plugin: IPipelinePlugin,
        context: IPipelineContext,
        runner: ExecutablePipelineRunner,
        startTime: number,
        failure?: { error?: Error | string; failedStep?: string },
    ): PipelineResult {
        const meta = {
            duration: Date.now() - startTime,
            stepsCompleted: runner.getState().completedSteps.length,
            totalSteps: runner.getPipeline().steps.length,
            state: runner.getState(),
        };

        if (plugin.extractResult) {
            const result = plugin.extractResult(context, meta);
            if (failure) {
                return {
                    ...result,
                    success: false,
                    error: failure.error,
                    failedStep: failure.failedStep,
                };
            }
            return result;
        }

        // Fallback for plugins that don't implement extractResult
        const warnings = context.warnings.length > 0 ? context.warnings : undefined;
        const base = {
            duration: meta.duration,
            stepsCompleted: meta.stepsCompleted,
            totalSteps: meta.totalSteps,
            state: meta.state,
            warnings,
        };

        if (failure) {
            return buildErrorPipelineResult(failure.error ?? 'Pipeline failed', {
                ...base,
                outputs: createEmptyPipelineOutputs(),
                failedStep: failure.failedStep,
            });
        }

        return buildSuccessPipelineResult(createEmptyPipelineOutputs(), {
            ...base,
        });
    }

    // ============================================================================
    // Event Emission
    // ============================================================================

    private emitLogEntry({
        onLogEntry,
        event,
        message,
        stepIndex,
        level,
        source,
        durationMs,
        stepName,
    }: EmitLogEntryOptions): void {
        const prefixedMessage =
            event in STEP_LOG_PREFIX_BY_EVENT
                ? `${STEP_LOG_PREFIX_BY_EVENT[event as keyof typeof STEP_LOG_PREFIX_BY_EVENT]}: ${message}`
                : message;

        onLogEntry?.({
            timestamp: new Date().toISOString(),
            level,
            source,
            event,
            message: prefixedMessage,
            stepIndex,
            stepName: stepName ?? null,
            durationMs: durationMs ?? null,
        });
    }

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
        workId: string,
        duration: number,
        stepsCompleted: number,
        result: PipelineResult,
        source: string,
    ): void {
        this.eventEmitter.emit(PipelineEvents.COMPLETED, {
            timestamp: new Date().toISOString(),
            workId,
            pipelineId: source,
            duration,
            stepsCompleted,
            outputs: result.outputs,
        } as PipelineCompletedPayload);
    }

    private emitPipelineFailed(
        workId: string,
        error: Error,
        failedStep: string | undefined,
        completedSteps: number,
        source: string,
    ): void {
        this.eventEmitter.emit(PipelineEvents.FAILED, {
            timestamp: new Date().toISOString(),
            workId,
            pipelineId: source,
            error: error.message,
            failedStep,
            completedSteps,
        } as PipelineFailedPayload);
    }
}
