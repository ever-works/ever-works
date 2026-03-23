import { Injectable, Logger, Optional } from '@nestjs/common';
import { Directory, User, GenerateStatusType } from '@ever-works/agent/entities';
import {
    DirectoryOperationsService,
    buildImportStatsUpdate,
} from '@ever-works/agent/directory-operations';
import { NotificationService } from '@ever-works/agent/notifications';
import { DirectoryImportPayload, DirectoryImportResult } from '@ever-works/agent/tasks';
import { normalizeGeneratorError } from '@ever-works/agent/services';
import { ImportExecutorService } from '@ever-works/agent/import';
import { calculateDurationSeconds } from '@ever-works/agent/utils';
import { BaseOrchestrator } from './base-orchestrator';

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
export class TriggerImportOrchestrator extends BaseOrchestrator {
    protected readonly logger = new Logger(TriggerImportOrchestrator.name);
    protected readonly operationLabel = 'Import';

    constructor(
        private readonly importExecutor: ImportExecutorService,
        directoryOperations: DirectoryOperationsService,
        @Optional()
        notificationService?: NotificationService,
    ) {
        super(directoryOperations, notificationService);
    }

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

        let result: DirectoryImportResult | null = null;

        try {
            result = await this.importExecutor.executeBySourceType({
                directory,
                user,
                sourceType: payload.sourceType,
                sourceOwner: payload.sourceOwner,
                sourceRepo: payload.sourceRepo,
                sourceUrl: payload.sourceUrl,
                token: gitToken,
                createMissingRepos: payload.options?.createMissingRepos,
                aiProviderOverride: payload.providers?.ai,
                enrichmentConfig: payload.enrichmentConfig,
            });

            if (!result.success) {
                throw new Error(result.error || 'Import failed');
            }

            const endTime = new Date();

            await Promise.all([
                this.directoryOperations.recordGenerationFinishTime(directory.id, endTime),
                this.directoryOperations.updateGenerateStatus(directory.id, {
                    status: GenerateStatusType.GENERATED,
                    step: null,
                }),
                this.directoryOperations.updateGenerationHistory(directory.id, payload.historyId, {
                    status: GenerateStatusType.GENERATED,
                    finishedAt: endTime,
                    durationInSeconds: calculateDurationSeconds(startTime, endTime),
                    ...buildImportStatsUpdate(result),
                }),
                this.directoryOperations.updateDirectory(directory.id, {
                    itemsCount: result?.itemsImported ?? 0,
                }),
            ]);
        } catch (error) {
            const endTime = new Date();

            await Promise.all([
                this.directoryOperations.recordGenerationFinishTime(directory.id, endTime),
                this.directoryOperations.updateGenerateStatus(directory.id, {
                    status: GenerateStatusType.ERROR,
                    error: normalizeGeneratorError(error),
                }),
            ]);

            await this.directoryOperations.updateGenerationHistory(
                directory.id,
                payload.historyId,
                {
                    status: GenerateStatusType.ERROR,
                    finishedAt: endTime,
                    durationInSeconds: calculateDurationSeconds(startTime, endTime),
                    errorMessage: normalizeGeneratorError(error),
                    ...buildImportStatsUpdate(result),
                },
            );

            this.logger.error('Import failed', error as Error);

            await this.handleErrorNotification(error, user, directory);

            throw error;
        } finally {
            await this.directoryOperations.emitGenerationCompleted(directory.id);
        }
    }
}
