import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type {
    DirectoryReference,
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
import { buildErrorPipelineResult, createEmptyPipelineOutputs } from '@ever-works/plugin';
import { PipelineEvents } from './step-pipeline-executor.service';
import { PipelineFacadeService } from './pipeline-facade.service';
import { validatePipelineResult } from './validators';
import { PluginContextFactoryService } from '../plugins/services/plugin-context-factory.service';

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
    ) {}

    /**
     * Execute using a pipeline plugin
     */
    async execute(
        plugin: IPipelinePlugin,
        directory: DirectoryReference,
        request: GenerationRequest,
        existing: ExistingItems,
        options?: PipelineExecutionOptions,
        onProgress?: PipelineProgressCallback,
    ): Promise<PipelineResult> {
        const startTime = Date.now();

        this.logger.log(
            `Starting full pipeline execution via plugin "${plugin.id}" for directory: ${directory.id}`,
        );

        // Emit pipeline:started event
        this.emitPipelineEvent(PipelineEvents.STARTED, {
            directoryId: directory.id,
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

        try {
            // Create execContext for the plugin to use facades
            const execContext = this.facadeService.createStepExecutionContext(
                directory,
                request.providers,
                options?.signal,
            );

            // Delegate to the plugin's execute method with execContext
            const rawResult = await plugin.execute(
                directory,
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
            this.emitPipelineCompleted(
                directory.id,
                duration,
                result.stepsCompleted,
                result,
                plugin.id,
            );

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
            this.emitPipelineFailed(directory.id, err, undefined, 0, plugin.id);

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
        directory: DirectoryReference,
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
                return await this.execute(
                    plugin,
                    directory,
                    request,
                    existing,
                    options,
                    onProgress,
                );
            } finally {
                options.signal.removeEventListener('abort', abortHandler);
            }
        }

        return this.execute(plugin, directory, request, existing, options, onProgress);
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
        directoryId: string,
        duration: number,
        stepsCompleted: number,
        result: PipelineResult,
        source: string,
    ): void {
        this.eventEmitter.emit(PipelineEvents.COMPLETED, {
            timestamp: new Date().toISOString(),
            directoryId,
            pipelineId: source,
            duration,
            stepsCompleted,
            outputs: result.outputs,
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
}
