import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Directory, User, GenerateStatusType } from '@ever-works/agent/entities';
import { DIRECTORY_OPERATIONS } from '@ever-works/agent/directory-operations';
import type { DirectoryOperations } from '@ever-works/agent/directory-operations';
import { NOTIFICATION_OPERATIONS } from '@ever-works/agent/notification-operations';
import type { NotificationOperations } from '@ever-works/agent/notification-operations';
import { DirectoryImportPayload, DirectoryImportResult } from '@ever-works/agent/tasks';
import { classifyGenerationError, notifyForClassifiedError } from '@ever-works/agent/services';
import { ImportExecutorService } from '@ever-works/agent/import';

export type TriggerImportOptions = {
    directory: Directory;
    user: User;
    payload: DirectoryImportPayload;
    gitToken?: string;
};

export type TriggerImportCancellationOptions = {
    directory: Directory;
    historyId: string;
    historyStartedAt?: string;
};

@Injectable()
export class TriggerImportOrchestrator {
    private readonly logger = new Logger(TriggerImportOrchestrator.name);

    constructor(
        private readonly importExecutor: ImportExecutorService,
        @Inject(DIRECTORY_OPERATIONS)
        private readonly directoryOperations: DirectoryOperations,
        @Optional()
        @Inject(NOTIFICATION_OPERATIONS)
        private readonly notificationOperations?: NotificationOperations,
    ) {}

    async run({ directory, user, payload, gitToken }: TriggerImportOptions): Promise<void> {
        const startTime = this.resolveStartTime(payload.historyStartedAt);

        await Promise.all([
            this.directoryOperations.recordGenerationStartTime(directory.id, startTime),
            this.directoryOperations.updateGenerateStatus(directory.id, {
                status: GenerateStatusType.GENERATING,
                step: 'import_started',
            }),
            this.directoryOperations.updateGenerationHistory(directory.id, payload.historyId, {
                status: GenerateStatusType.GENERATING,
                startedAt: startTime,
            }),
        ]);

        let hasError = false;
        let result: DirectoryImportResult | null = null;

        try {
            const token = gitToken;

            if (payload.sourceType === 'data_repo') {
                if (!token) {
                    throw new Error('GitHub token not available');
                }
                result = await this.importExecutor.importFromDataRepo({
                    directory,
                    user,
                    source: { owner: payload.sourceOwner, repo: payload.sourceRepo },
                    token,
                });
            } else if (payload.sourceType === 'awesome_readme') {
                result = await this.importExecutor.importFromAwesomeReadme({
                    directory,
                    user,
                    sourceUrl: payload.sourceUrl,
                    token,
                    aiProviderOverride: payload.providers?.ai,
                });
            } else if (payload.sourceType === 'link_existing') {
                if (!token) {
                    throw new Error('GitHub token not available');
                }
                result = await this.importExecutor.linkExistingDataRepo({
                    directory,
                    user,
                    source: { owner: payload.sourceOwner, repo: payload.sourceRepo },
                    token,
                    createMissingRepos: payload.options?.createMissingRepos ?? false,
                });
            } else {
                throw new Error(`Unsupported source type: ${payload.sourceType}`);
            }

            if (!result.success) {
                throw new Error(result.error || 'Import failed');
            }

            await this.directoryOperations.updateGenerationHistory(
                directory.id,
                payload.historyId,
                {
                    newItemsCount: result.itemsImported ?? 0,
                    totalItemsCount: result.itemsImported ?? 0,
                    metrics: result.metrics
                        ? {
                              total_tokens_used: result.metrics.total_tokens_used ?? 0,
                              total_cost: result.metrics.total_cost ?? 0,
                              new_items_added_to_store: result.itemsImported ?? 0,
                              total_items_in_store: result.itemsImported ?? 0,
                          }
                        : undefined,
                },
            );
        } catch (error) {
            hasError = true;

            await Promise.all([
                this.directoryOperations.recordGenerationFinishTime(directory.id, new Date()),
                this.directoryOperations.updateGenerateStatus(directory.id, {
                    status: GenerateStatusType.ERROR,
                    error: error instanceof Error ? error.message : String(error),
                }),
            ]);

            const endTime = new Date();
            const duration = Math.round((endTime.getTime() - startTime.getTime()) / 1000);
            await this.directoryOperations.updateGenerationHistory(
                directory.id,
                payload.historyId,
                {
                    status: GenerateStatusType.ERROR,
                    finishedAt: endTime,
                    durationInSeconds: duration,
                    errorMessage: error instanceof Error ? error.message : String(error),
                    newItemsCount: result?.itemsImported ?? 0,
                    totalItemsCount: result?.itemsImported ?? 0,
                },
            );

            this.logger.error('Import failed', error as Error);

            await this.handleErrorNotification(error, user, directory);

            throw error;
        } finally {
            if (!hasError) {
                const endTime = new Date();
                const duration = Math.round((endTime.getTime() - startTime.getTime()) / 1000);

                await Promise.all([
                    this.directoryOperations.recordGenerationFinishTime(directory.id, endTime),
                    this.directoryOperations.updateGenerateStatus(directory.id, {
                        status: GenerateStatusType.GENERATED,
                        step: null,
                    }),
                    this.directoryOperations.updateGenerationHistory(
                        directory.id,
                        payload.historyId,
                        {
                            status: GenerateStatusType.GENERATED,
                            finishedAt: endTime,
                            durationInSeconds: duration,
                            newItemsCount: result?.itemsImported ?? 0,
                            totalItemsCount: result?.itemsImported ?? 0,
                        },
                    ),
                    this.directoryOperations.updateDirectory(directory.id, {
                        itemsCount: result?.itemsImported ?? 0,
                    }),
                ]);
            }

            await this.directoryOperations.emitGenerationCompleted(directory);
        }
    }

    async handleCancellation({
        directory,
        historyId,
        historyStartedAt,
    }: TriggerImportCancellationOptions): Promise<void> {
        const finishedAt = new Date();
        const startTime = this.resolveStartTime(historyStartedAt);
        const duration = Math.max(
            0,
            Math.round((finishedAt.getTime() - startTime.getTime()) / 1000),
        );
        const message = 'Import cancelled';

        await Promise.all([
            this.directoryOperations.recordGenerationFinishTime(directory.id, finishedAt),
            this.directoryOperations.updateGenerateStatus(directory.id, {
                status: GenerateStatusType.CANCELLED,
                error: message,
                step: null,
            }),
            this.directoryOperations.updateGenerationHistory(directory.id, historyId, {
                status: GenerateStatusType.CANCELLED,
                finishedAt,
                durationInSeconds: duration,
                errorMessage: message,
            }),
        ]);

        await this.directoryOperations.emitGenerationCompleted(directory);
    }

    private resolveStartTime(historyStartedAt?: string): Date {
        if (!historyStartedAt) {
            return new Date();
        }

        const parsed = new Date(historyStartedAt);

        if (Number.isNaN(parsed.getTime())) {
            this.logger.warn(
                `Invalid historyStartedAt provided (${historyStartedAt}), falling back to current time`,
            );
            return new Date();
        }

        return parsed;
    }

    private async handleErrorNotification(
        error: unknown,
        user: User,
        directory: Directory,
    ): Promise<void> {
        if (!this.notificationOperations) {
            return;
        }

        const classification = classifyGenerationError(error);

        if (classification.type !== 'unknown') {
            await notifyForClassifiedError(
                this.notificationOperations,
                user.id,
                directory.id,
                directory.name,
                classification,
            );
        }
    }
}
