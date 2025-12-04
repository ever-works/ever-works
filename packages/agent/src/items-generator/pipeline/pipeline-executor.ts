import { Logger, Injectable, Inject } from '@nestjs/common';
import { IPipelineStep, GenerationContext } from '../interfaces/pipeline.interface';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import type { Directory } from '@src/entities';

// Serializable version of GenerationContext (without methods or complex objects like Directory)
export type SerializableGenerationContext = Omit<
    GenerationContext,
    'directory' | 'processedSourceUrls' | 'contentCache' | 'onProgress' | 'shouldStop'
> & {
    // Handle specific field transformations
    processedSourceUrls: string[];
};

// Define the structure of the data stored in a checkpoint
export interface CheckpointData {
    stepIndex: number;
    stepName: string;
    timestamp: string;
    context: SerializableGenerationContext;
}

// 1 hour in milliseconds
const CHECKPOINT_TTL_MS = 60 * 60 * 1000;

@Injectable()
export class PipelineExecutor {
    private readonly logger = new Logger(PipelineExecutor.name);
    private steps: IPipelineStep[] = [];

    constructor(@Inject(CACHE_MANAGER) private cacheManager: Cache) {}

    addStep(step: IPipelineStep) {
        this.steps.push(step);
        return this;
    }

    async execute(
        context: GenerationContext,
        onProgress?: (step: string) => void,
        resumeFromStepName?: string,
    ): Promise<GenerationContext> {
        let currentContext = context;
        const totalSteps = this.steps.length;
        let startIndex = 0;

        if (resumeFromStepName) {
            const stepIndex = this.steps.findIndex((s) => s.name === resumeFromStepName);
            if (stepIndex !== -1) {
                // We found the step that was COMPLETED last time.
                // We should start from the NEXT step.
                startIndex = stepIndex + 1;
                this.logger.log(
                    `Resuming pipeline execution for directory: ${context.directory.slug}. Last completed step: ${resumeFromStepName}. Starting from step index ${startIndex}`,
                );
            } else {
                this.logger.warn(
                    `Could not find step with name '${resumeFromStepName}' to resume from. Starting from beginning.`,
                );
            }
        } else {
            this.logger.log(
                `Starting pipeline execution with ${totalSteps} steps for directory: ${context.directory.slug}`,
            );
        }

        // If we finished the last step, we are done
        if (startIndex >= totalSteps) {
            this.logger.log(`Pipeline already completed (last step was ${resumeFromStepName}).`);
            return currentContext;
        }

        for (let i = startIndex; i < totalSteps; i++) {
            const step = this.steps[i];
            const stepName = step.name;

            if (currentContext.shouldStop) {
                this.logger.log(`Pipeline stopped before step ${stepName}`);
                break;
            }

            try {
                this.logger.log(`[Step ${i + 1}/${totalSteps}] ${stepName} - Starting`);
                const startTime = Date.now();

                // Update progress if callback provided
                if (onProgress) {
                    onProgress(stepName);
                }

                // Execute step
                currentContext = await step.run(currentContext);

                const duration = Date.now() - startTime;
                this.logger.log(
                    `[Step ${i + 1}/${totalSteps}] ${stepName} - Completed in ${duration}ms`,
                );

                // Checkpointing (Resilience)
                await this.saveCheckpoint(currentContext, i, stepName);
            } catch (error) {
                this.logger.error(
                    `[Step ${i + 1}/${totalSteps}] ${stepName} - Failed: ${error.message}`,
                    error.stack,
                );
                // Here we could implement retry logic or custom error handling strategies
                throw error;
            }
        }

        this.logger.log(`Pipeline execution completed successfully.`);
        return currentContext;
    }

    async loadCheckpoint(directory: Directory): Promise<CheckpointData | null> {
        try {
            const checkpointKey = this.getCheckpointKey(directory);
            const checkpointData = await this.cacheManager.get<CheckpointData>(checkpointKey);

            if (checkpointData && checkpointData.stepName) {
                return checkpointData;
            }

            return null;
        } catch (err) {
            this.logger.warn(`Failed to load checkpoint for ${directory.slug}: ${err.message}`);
            return null;
        }
    }

    private getCheckpointKey(directory: Directory) {
        return `pipeline-checkpoint-${directory.userId}-${directory.slug}`;
    }

    private async saveCheckpoint(context: GenerationContext, stepIndex: number, stepName: string) {
        try {
            const checkpointKey = this.getCheckpointKey(context.directory);

            // Create serializable context by excluding non-serializable fields
            const {
                directory,
                processedSourceUrls,
                contentCache,
                shouldStop,
                ...serializableProps
            } = context;

            const serializableContext: SerializableGenerationContext = {
                ...serializableProps,
                processedSourceUrls: Array.from(processedSourceUrls),
            };

            const checkpointData: CheckpointData = {
                stepIndex,
                stepName,
                timestamp: new Date().toISOString(),
                context: serializableContext,
            };

            // Cache for 1 hour (longer might be needed depending on expected failure recovery time)
            await this.cacheManager.set(checkpointKey, checkpointData, CHECKPOINT_TTL_MS);
            this.logger.debug(`Checkpoint saved for ${context.directory.slug} at step ${stepName}`);
        } catch (err) {
            this.logger.warn(`Failed to save checkpoint for step ${stepName}: ${err.message}`);
        }
    }
}
