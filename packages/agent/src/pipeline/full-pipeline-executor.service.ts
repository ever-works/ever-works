import { Injectable, Logger, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type {
    WorkReference,
    GenerationRequest,
    ExistingItems,
    PipelineExecutionOptions,
    PipelineProgressCallback,
    PipelineResult,
    IPipelinePlugin,
    PipelineEventPayload,
    PipelineCompletedPayload,
    PipelineFailedPayload,
} from '@ever-works/plugin';
import type { GenerationStepLog } from '@ever-works/contracts/api';
import type { KbContextBundleData } from '@ever-works/contracts';
import type { IKbToolsFacade } from '@ever-works/plugin';
import { buildErrorPipelineResult, createEmptyPipelineOutputs } from '@ever-works/plugin';
import { PipelineEvents } from './step-pipeline-executor.service';
import { PipelineFacadeService } from './pipeline-facade.service';
import { validatePipelineResult } from './validators';
import { PluginContextFactoryService } from '../plugins/services/plugin-context-factory.service';
import { KnowledgeBaseService } from '../services/knowledge-base.service';
import { KbToolsFacadeAdapter } from '../services/kb-tools-facade.adapter';

/**
 * Executor for self-managed pipeline plugins.
 *
 * This service delegates execution to IPipelinePlugin implementations
 * that own their execution entirely (not engine-orchestratable).
 * It creates a StepExecutionContext and passes it via options.execContext.
 */
@Injectable()
export class FullPipelineExecutorService {
    private readonly logger = new Logger(FullPipelineExecutorService.name);

    constructor(
        private readonly eventEmitter: EventEmitter2,
        private readonly facadeService: PipelineFacadeService,
        private readonly contextFactory: PluginContextFactoryService,
        // EW-641 Phase 2/b row 32c — same KB resolver as the step-orchestrated
        // executor. Optional so OSS images / isolated unit tests without
        // KB wiring still construct (and `execContext.kbContext` stays
        // undefined for those callers).
        @Optional() private readonly knowledgeBaseService?: KnowledgeBaseService,
        // EW-641 Phase 2/d row 36c — LLM-callable KB tools facade,
        // threaded via `execContext.kbTools` for self-managed pipeline
        // plugins (agent-pipeline + family). Same optionality contract
        // as `knowledgeBaseService`.
        @Optional() private readonly kbToolsFacade?: KbToolsFacadeAdapter,
    ) {}

    /**
     * EW-641 Phase 2/b row 32c — same try/catch resolver as the step
     * executor uses. A KB hiccup must never break generation; on failure
     * we log + return undefined so the step plugin sees no kbContext.
     */
    private async resolveKbContextSafe(
        work: WorkReference,
        request: GenerationRequest,
    ): Promise<KbContextBundleData | undefined> {
        if (!this.knowledgeBaseService || !work.id) return undefined;
        try {
            return await this.knowledgeBaseService.resolveContext(work.id, {
                query: request.prompt,
            });
        } catch (err) {
            this.logger.warn(
                `KB context resolution failed for work=${work.id}: ${(err as Error).message}. Continuing without kbContext.`,
            );
            return undefined;
        }
    }

    /**
     * EW-641 Phase 2/d row 36c — resolve the LLM-callable KB tools
     * facade for this pipeline run. Mirrors the step-executor helper
     * of the same name (synchronous-friendly; the adapter is a
     * singleton @Injectable).
     */
    private resolveKbToolsFacadeSafe(work: WorkReference): IKbToolsFacade | undefined {
        if (!this.kbToolsFacade || !work.id) return undefined;
        return this.kbToolsFacade;
    }

    /**
     * Execute using a pipeline plugin
     */
    async execute(
        plugin: IPipelinePlugin,
        work: WorkReference,
        request: GenerationRequest,
        existing: ExistingItems,
        options?: PipelineExecutionOptions,
        onProgress?: PipelineProgressCallback,
    ): Promise<PipelineResult> {
        const startTime = Date.now();

        this.logger.log(
            `Starting full pipeline execution via plugin "${plugin.id}" for work: ${work.id}`,
        );

        // Emit pipeline:started event
        this.emitPipelineEvent(PipelineEvents.STARTED, {
            workId: work.id,
            pipelineId: plugin.id,
        });

        // Attach a log interceptor so ALL plugin logger calls are captured
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

        // EW-641 Phase 2/b row 32c + 2/d row 36c — resolve KB bundle +
        // tools facade once before the plugin executes; both ride on
        // the same execContext that facades use.
        const kbContext = await this.resolveKbContextSafe(work, request);
        const kbTools = this.resolveKbToolsFacadeSafe(work);

        try {
            // Create execContext for the plugin to use facades
            const execContext = this.facadeService.createStepExecutionContext(
                work,
                request.providers,
                request.aiModel,
                options?.signal,
                kbContext,
                kbTools,
            );

            // Delegate to the plugin's execute method with execContext
            const rawResult = await plugin.execute(
                work,
                request,
                existing,
                { ...options, execContext, onLogEntry: options?.onLogEntry },
                onProgress,
            );

            // Validate the result from the plugin
            const validation = validatePipelineResult(rawResult);
            if (!validation.valid) {
                this.logger.error(
                    `Plugin "${plugin.id}" returned invalid result: ${validation.errors.join('; ')}`,
                );
                throw new Error(
                    `Plugin "${plugin.id}" returned invalid pipeline result: ${validation.errors.join('; ')}`,
                );
            }
            const result = validation.result!;

            const duration = Date.now() - startTime;

            // Emit pipeline:completed event
            this.emitPipelineCompleted(work.id, duration, result.stepsCompleted, result, plugin.id);

            this.logger.log(
                `Full pipeline completed via plugin "${plugin.id}": ` +
                    `${result.stepsCompleted}/${result.totalSteps} steps in ${duration}ms`,
            );

            return {
                ...result,
                duration,
            };
        } catch (error) {
            const err = error as Error;
            const duration = Date.now() - startTime;

            // Emit pipeline:failed event
            this.emitPipelineFailed(work.id, err, undefined, 0, plugin.id);

            this.logger.error(`Full pipeline failed via plugin "${plugin.id}": ${err.message}`);

            // Return a failed result
            return buildErrorPipelineResult(err, {
                outputs: createEmptyPipelineOutputs(),
                duration,
                stepsCompleted: 0,
                totalSteps: plugin.getStepDefinitions().length,
                state: {
                    steps: new Map(),
                    completedSteps: [],
                    failedSteps: [],
                    isRunning: false,
                    isCancelled: false,
                },
            });
        } finally {
            removeInterceptor?.();
        }
    }

    /**
     * Execute with cancellation support
     */
    async executeWithCancellation(
        plugin: IPipelinePlugin,
        work: WorkReference,
        request: GenerationRequest,
        existing: ExistingItems,
        options: PipelineExecutionOptions & { signal: AbortSignal },
        onProgress?: PipelineProgressCallback,
    ): Promise<PipelineResult> {
        if (plugin.cancel && options.signal) {
            const abortHandler = () => {
                this.logger.log(`Cancelling full pipeline for plugin "${plugin.id}"`);
                plugin.cancel!().catch((err) => {
                    this.logger.error(`Failed to cancel plugin: ${err.message}`);
                });
            };

            options.signal.addEventListener('abort', abortHandler, { once: true });

            try {
                return await this.execute(plugin, work, request, existing, options, onProgress);
            } finally {
                options.signal.removeEventListener('abort', abortHandler);
            }
        }

        return this.execute(plugin, work, request, existing, options, onProgress);
    }

    /**
     * Get the current state of a running pipeline (if supported by plugin)
     */
    getPluginState(
        plugin: IPipelinePlugin,
    ): ReturnType<NonNullable<IPipelinePlugin['getState']>> | null {
        if (plugin.getState) {
            return plugin.getState();
        }
        return null;
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
