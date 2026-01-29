import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type {
    DirectoryReference,
    GenerationRequest,
    ExistingItems,
    PipelineExecutionOptions,
    PipelineProgressCallback,
    PipelineResult,
    IFullPipelinePlugin,
    PipelineEventPayload,
    PipelineCompletedPayload,
    PipelineFailedPayload,
} from '@ever-works/plugin';
import { PipelineEvents } from './step-pipeline-executor.service';

/**
 * Executor for full pipeline plugins.
 *
 * This service delegates execution to IFullPipelinePlugin implementations,
 * which provide complete pipeline replacement capability. Full pipeline plugins
 * can completely override the standard step-based execution with their own
 * implementation.
 */
@Injectable()
export class FullPipelineExecutorService {
    private readonly logger = new Logger(FullPipelineExecutorService.name);

    constructor(private readonly eventEmitter: EventEmitter2) {}

    /**
     * Execute using a full pipeline plugin
     *
     * @param plugin - The full pipeline plugin to execute
     * @param directory - Directory reference
     * @param request - Generation request parameters
     * @param existing - Existing items in directory
     * @param options - Execution options
     * @param onProgress - Progress callback
     * @returns Pipeline execution result
     */
    async execute(
        plugin: IFullPipelinePlugin,
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

        try {
            // Delegate to the plugin's execute method
            const result = await plugin.execute(directory, request, existing, options, onProgress);

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
            return {
                success: false,
                items: [],
                categories: [],
                tags: [],
                brands: [],
                duration,
                stepsCompleted: 0,
                totalSteps: plugin.getStepDefinitions().length,
                error: err,
                state: {
                    steps: new Map(),
                    completedSteps: [],
                    failedSteps: [],
                    isRunning: false,
                    isCancelled: false,
                },
            };
        }
    }

    /**
     * Execute with cancellation support
     *
     * @param plugin - The full pipeline plugin
     * @param directory - Directory reference
     * @param request - Generation request
     * @param existing - Existing items
     * @param options - Execution options with signal
     * @param onProgress - Progress callback
     */
    async executeWithCancellation(
        plugin: IFullPipelinePlugin,
        directory: DirectoryReference,
        request: GenerationRequest,
        existing: ExistingItems,
        options: PipelineExecutionOptions & { signal: AbortSignal },
        onProgress?: PipelineProgressCallback,
    ): Promise<PipelineResult> {
        // If plugin supports cancellation, use it
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

        // Otherwise, just execute normally
        return this.execute(plugin, directory, request, existing, options, onProgress);
    }

    /**
     * Get the current state of a running pipeline (if supported by plugin)
     *
     * @param plugin - The full pipeline plugin
     */
    getPluginState(
        plugin: IFullPipelinePlugin,
    ): ReturnType<NonNullable<IFullPipelinePlugin['getState']>> | null {
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
            items: result.items,
            categories: result.categories,
            tags: result.tags,
            brands: result.brands,
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
