import { Injectable, Logger, Optional } from '@nestjs/common';
import { GENERATION_CANCELLED } from '@ever-works/agent/constants';
import { DataGeneratorService, GenerationStats } from '@ever-works/agent/generators';
import { MarkdownGeneratorService } from '@ever-works/agent/generators';
import { WebsiteGeneratorService } from '@ever-works/agent/generators';
import { Directory, User, GenerateStatusType } from '@ever-works/agent/entities';
import { CreateItemsGeneratorDto } from '@ever-works/agent/items-generator';
import {
    DirectoryOperationsService,
    buildStatsUpdate,
} from '@ever-works/agent/directory-operations';
import { GenerationLogCollector } from '@ever-works/agent/generators';
import { NotificationService } from '@ever-works/agent/notifications';
import { normalizeGeneratorError } from '@ever-works/agent/services';
import { calculateDurationSeconds } from '@ever-works/agent/utils';
import { BaseOrchestrator } from './base-orchestrator';

export type TriggerGenerationOptions = {
    directory: Directory;
    user: User;
    dto: CreateItemsGeneratorDto;
    historyId: string;
    historyStartedAt?: string;
    signal?: AbortSignal;
};

@Injectable()
export class TriggerGenerationOrchestrator extends BaseOrchestrator {
    protected readonly logger = new Logger(TriggerGenerationOrchestrator.name);
    protected readonly operationLabel = 'Generation';

    constructor(
        private readonly dataGenerator: DataGeneratorService,
        private readonly markdownGenerator: MarkdownGeneratorService,
        private readonly websiteGenerator: WebsiteGeneratorService,
        directoryOperations: DirectoryOperationsService,
        @Optional()
        notificationService?: NotificationService,
    ) {
        super(directoryOperations, notificationService);
    }

    async run({
        directory,
        user,
        dto,
        historyId,
        historyStartedAt,
        signal,
    }: TriggerGenerationOptions): Promise<GenerateStatusType> {
        const startTime = this.resolveStartTime(historyStartedAt);

        const logCollector = new GenerationLogCollector(
            historyId,
            (hId, logs) => this.directoryOperations.appendGenerationLogs(hId, logs),
            {
                onRecentLogsUpdated: (recentLogs) =>
                    this.directoryOperations.updateGenerateRecentLogs(directory.id, recentLogs),
            },
        );

        await Promise.all([
            this.directoryOperations.recordGenerationStartTime(directory.id, startTime),
            this.directoryOperations.updateGenerateStatus(directory.id, {
                status: GenerateStatusType.GENERATING,
            }),
            this.directoryOperations.updateGenerationHistory(directory.id, historyId, {
                status: GenerateStatusType.GENERATING,
                startedAt: startTime,
            }),
        ]);

        logCollector.message('Generation started', 'info', 'orchestrator');

        let generationStats: GenerationStats | null = null;
        let generationWarnings: string[] | undefined;

        try {
            const generated = await this.dataGenerator.initialize(directory, user, dto, {
                logCollector,
                signal,
            });
            generationWarnings = generated.warnings;

            if (generated.success === false) {
                const cause = generated.error.cause;
                const message =
                    cause instanceof Error &&
                    cause.message &&
                    cause.message !== generated.error.message
                        ? `${generated.error.message}: ${cause.message}`
                        : generated.error.message;

                const generationError = new Error(message) as Error & { cause?: Error };
                if (cause) {
                    generationError.cause = cause;
                }
                generationError.name = generated.error.code;

                throw generationError;
            }

            logCollector.message('Data generation completed', 'info', 'orchestrator');
            generationStats = generated.stats;
            const newItemsCount = generated.stats?.newItemsCount ?? 0;
            const updatedItemsCount = generated.stats?.updatedItemsCount ?? 0;

            if (signal?.aborted) {
                throw this.createGenerationCancelledError();
            }

            if (newItemsCount > 0 || updatedItemsCount > 0) {
                logCollector.message('Markdown generation started', 'info', 'orchestrator');
                await this.markdownGenerator.initialize(directory, user, {
                    generation_method: dto.generation_method,
                    pr_update: generated.prUpdate,
                });
                logCollector.message('Markdown generation completed', 'info', 'orchestrator');
            }

            if (signal?.aborted) {
                throw this.createGenerationCancelledError();
            }

            if (newItemsCount > 0 || generated.hasExistingItems) {
                logCollector.message('Website generation started', 'info', 'orchestrator');
                await this.websiteGenerator.initialize(
                    directory,
                    user,
                    dto.website_repository_creation_method,
                );
                logCollector.message('Website generation completed', 'info', 'orchestrator');
            }

            const endTime = new Date();

            logCollector.message('Generation completed successfully', 'info', 'orchestrator');

            await Promise.all([
                this.directoryOperations.recordGenerationFinishTime(directory.id, endTime),
                this.directoryOperations.updateGenerateStatus(directory.id, {
                    status: GenerateStatusType.GENERATED,
                    step: null,
                    warnings: generationWarnings,
                    recentLogs: logCollector.getRecentLogs(),
                }),
                this.directoryOperations.updateGenerationHistory(directory.id, historyId, {
                    status: GenerateStatusType.GENERATED,
                    finishedAt: endTime,
                    durationInSeconds: calculateDurationSeconds(startTime, endTime),
                    ...buildStatsUpdate(generationStats),
                }),
            ]);

            return GenerateStatusType.GENERATED;
        } catch (error) {
            const endTime = new Date();
            const wasCancelled = this.isGenerationCancelledError(error) || Boolean(signal?.aborted);
            const finalStatus = wasCancelled
                ? GenerateStatusType.CANCELLED
                : GenerateStatusType.ERROR;
            const errorMessage = wasCancelled
                ? GENERATION_CANCELLED
                : normalizeGeneratorError(error);

            logCollector.message(
                wasCancelled
                    ? 'Generation cancelled'
                    : `Generation failed: ${normalizeGeneratorError(error)}`,
                wasCancelled ? 'warn' : 'error',
                'orchestrator',
            );

            await Promise.all([
                this.directoryOperations.recordGenerationFinishTime(directory.id, endTime),
                this.directoryOperations.updateGenerateStatus(directory.id, {
                    status: finalStatus,
                    error: errorMessage,
                    warnings: generationWarnings,
                    recentLogs: logCollector.getRecentLogs(),
                }),
                this.directoryOperations.updateGenerationHistory(directory.id, historyId, {
                    status: finalStatus,
                    finishedAt: endTime,
                    durationInSeconds: calculateDurationSeconds(startTime, endTime),
                    errorMessage,
                    ...buildStatsUpdate(generationStats),
                }),
            ]);

            if (wasCancelled) {
                return GenerateStatusType.CANCELLED;
            }

            this.logger.error('Generation failed', error as Error);

            await this.handleErrorNotification(error, user, directory);

            throw error;
        } finally {
            await logCollector.dispose();
            await this.directoryOperations.emitGenerationCompleted(directory.id);
        }
    }

    private createGenerationCancelledError(): Error {
        const error = new Error(GENERATION_CANCELLED);
        error.name = 'AbortError';
        return error;
    }

    private isGenerationCancelledError(error: unknown): boolean {
        if (!(error instanceof Error)) {
            return false;
        }

        return (
            error.name === 'AbortError' ||
            error.message.toLowerCase() === GENERATION_CANCELLED.toLowerCase()
        );
    }
}
