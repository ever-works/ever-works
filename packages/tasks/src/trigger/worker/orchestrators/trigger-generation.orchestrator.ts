import { Injectable, Logger, Optional } from '@nestjs/common';
import { GENERATION_CANCELLED } from '@ever-works/agent/constants';
import { DataGeneratorService, GenerationStats } from '@ever-works/agent/generators';
import { MarkdownGeneratorService } from '@ever-works/agent/generators';
import { WebsiteGeneratorService } from '@ever-works/agent/generators';
import { Work, User, GenerateStatusType } from '@ever-works/agent/entities';
import { CreateItemsGeneratorDto } from '@ever-works/agent/items-generator';
import { WorkOperationsService, buildStatsUpdate } from '@ever-works/agent/work-operations';
import { GenerationLogCollector } from '@ever-works/agent/generators';
import { NotificationService } from '@ever-works/agent/notifications';
import { normalizeGeneratorError } from '@ever-works/agent/services';
import {
    calculateDurationSeconds,
    createGenerationCancelledError,
    isGenerationCancelledError,
    throwIfGenerationCancelled,
} from '@ever-works/agent/utils';
import { BaseOrchestrator } from './base-orchestrator';

export type TriggerGenerationOptions = {
    work: Work;
    user: User;
    dto: CreateItemsGeneratorDto;
    historyId: string;
    historyStartedAt?: string;
    signal?: AbortSignal;
};

// Security: matches `scheme://user:password@host` userinfo so embedded credentials
// (e.g. `https://oauth2:<token>@github.com/...` from isomorphic-git error chains) can be
// redacted from messages before they are persisted or returned to users. The capture
// group preserves the scheme + `://`; only the `user:password` portion is replaced.
const URL_CREDENTIALS_PATTERN = /([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi;

/**
 * Strip `user:password` userinfo from any credential-bearing URL embedded in a
 * free-form error message, replacing it with `***:***` while keeping the scheme and
 * host. Messages without such userinfo (the legitimate case) are returned unchanged.
 */
function redactUrlCredentials(message: string): string {
    return message.replace(URL_CREDENTIALS_PATTERN, '$1***:***@');
}

@Injectable()
export class TriggerGenerationOrchestrator extends BaseOrchestrator {
    protected readonly logger = new Logger(TriggerGenerationOrchestrator.name);
    protected readonly operationLabel = 'Generation';

    constructor(
        private readonly dataGenerator: DataGeneratorService,
        private readonly markdownGenerator: MarkdownGeneratorService,
        private readonly websiteGenerator: WebsiteGeneratorService,
        workOperations: WorkOperationsService,
        @Optional()
        notificationService?: NotificationService,
    ) {
        super(workOperations, notificationService);
    }

    async run({
        work,
        user,
        dto,
        historyId,
        historyStartedAt,
        signal,
    }: TriggerGenerationOptions): Promise<GenerateStatusType> {
        const startTime = this.resolveStartTime(historyStartedAt);

        if (
            work.generateStatus?.status === GenerateStatusType.CANCELLED ||
            (await this.isWorkCancelled(work.id))
        ) {
            return GenerateStatusType.CANCELLED;
        }

        const logCollector = new GenerationLogCollector(
            historyId,
            (hId, logs) => this.workOperations.appendGenerationLogs(hId, logs),
            {
                onRecentLogsUpdated: (recentLogs) =>
                    this.workOperations.updateGenerateRecentLogs(work.id, recentLogs),
            },
        );

        await Promise.all([
            this.workOperations.recordGenerationStartTime(work.id, startTime),
            this.workOperations.updateGenerateStatus(work.id, {
                status: GenerateStatusType.GENERATING,
            }),
            this.workOperations.updateGenerationHistory(work.id, historyId, {
                status: GenerateStatusType.GENERATING,
                startedAt: startTime,
            }),
        ]);

        logCollector.message('Generation started', 'info', 'orchestrator');

        let generationStats: GenerationStats | null = null;
        let generationWarnings: string[] | undefined;

        try {
            const generated = await this.dataGenerator.initialize(work, user, dto, {
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

            await this.throwIfWorkCancelled(work.id);
            throwIfGenerationCancelled(signal);

            if (newItemsCount > 0 || updatedItemsCount > 0) {
                logCollector.message('Markdown generation started', 'info', 'orchestrator');
                await this.markdownGenerator.initialize(work, user, {
                    generation_method: dto.generation_method,
                    pr_update: generated.prUpdate,
                    signal,
                });
                logCollector.message('Markdown generation completed', 'info', 'orchestrator');
            }

            await this.throwIfWorkCancelled(work.id);
            throwIfGenerationCancelled(signal);

            if (newItemsCount > 0 || generated.hasExistingItems) {
                logCollector.message('Website generation started', 'info', 'orchestrator');
                await this.websiteGenerator.initialize(
                    work,
                    user,
                    dto.website_repository_creation_method,
                    { signal },
                );
                logCollector.message('Website generation completed', 'info', 'orchestrator');
            }

            await this.throwIfWorkCancelled(work.id);

            const endTime = new Date();

            logCollector.message('Generation completed successfully', 'info', 'orchestrator');

            await Promise.all([
                this.workOperations.recordGenerationFinishTime(work.id, endTime),
                this.workOperations.updateGenerateStatus(work.id, {
                    status: GenerateStatusType.GENERATED,
                    step: null,
                    warnings: generationWarnings,
                    recentLogs: logCollector.getRecentLogs(),
                }),
                this.workOperations.updateGenerationHistory(work.id, historyId, {
                    status: GenerateStatusType.GENERATED,
                    finishedAt: endTime,
                    durationInSeconds: calculateDurationSeconds(startTime, endTime),
                    warnings: generationWarnings ?? null,
                    ...buildStatsUpdate(generationStats),
                }),
            ]);

            return GenerateStatusType.GENERATED;
        } catch (error) {
            const endTime = new Date();
            const failure = this.resolveGenerationFailure(error, signal);

            logCollector.message(failure.logMessage, failure.logLevel, 'orchestrator');

            await Promise.all([
                this.workOperations.recordGenerationFinishTime(work.id, endTime),
                this.workOperations.updateGenerateStatus(work.id, {
                    status: failure.status,
                    error: failure.errorMessage,
                    warnings: generationWarnings,
                    recentLogs: logCollector.getRecentLogs(),
                }),
                this.workOperations.updateGenerationHistory(work.id, historyId, {
                    status: failure.status,
                    finishedAt: endTime,
                    durationInSeconds: calculateDurationSeconds(startTime, endTime),
                    errorMessage: failure.errorMessage,
                    warnings: generationWarnings ?? null,
                    ...buildStatsUpdate(generationStats),
                }),
            ]);

            if (failure.wasCancelled) {
                return GenerateStatusType.CANCELLED;
            }

            this.logger.error('Generation failed', error as Error);

            await this.handleErrorNotification(error, user, work);

            throw error;
        } finally {
            await logCollector.dispose();
            await this.workOperations.emitGenerationCompleted(work.id);
        }
    }

    private resolveGenerationFailure(
        error: unknown,
        signal?: AbortSignal,
    ): {
        status: GenerateStatusType;
        errorMessage: string;
        logMessage: string;
        logLevel: 'warn' | 'error';
        wasCancelled: boolean;
    } {
        const wasCancelled = isGenerationCancelledError(error) || Boolean(signal?.aborted);

        if (wasCancelled) {
            return {
                status: GenerateStatusType.CANCELLED,
                errorMessage: GENERATION_CANCELLED,
                logMessage: 'Generation cancelled',
                logLevel: 'warn',
                wasCancelled: true,
            };
        }

        // Security: git/network errors (e.g. from isomorphic-git) frequently embed
        // credential-bearing URLs such as `https://oauth2:<token>@github.com/...` in
        // their message chain. `normalizeGeneratorError` returns the verbatim chain
        // when no known-pattern branch matches, and this string is persisted to
        // `work.generateStatus.error` / generation history and served to users via the
        // Works API. Strip any `scheme://user:password@host` userinfo before it leaves
        // here so leaked tokens never reach storage. Legitimate messages have no such
        // userinfo and are left unchanged.
        const errorMessage = redactUrlCredentials(normalizeGeneratorError(error));

        return {
            status: GenerateStatusType.ERROR,
            errorMessage,
            logMessage: `Generation failed: ${errorMessage}`,
            logLevel: 'error',
            wasCancelled: false,
        };
    }

    private async throwIfWorkCancelled(workId: string): Promise<void> {
        if (await this.isWorkCancelled(workId)) {
            throw createGenerationCancelledError();
        }
    }

    private async isWorkCancelled(workId: string): Promise<boolean> {
        const generateStatus = await this.workOperations.getGenerateStatus(workId);
        return generateStatus?.status === GenerateStatusType.CANCELLED;
    }
}
