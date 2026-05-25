import { Injectable, Logger, Optional } from '@nestjs/common';
import { Work, User, GenerateStatusType } from '@ever-works/agent/entities';
import { WorkOperationsService, buildImportStatsUpdate } from '@ever-works/agent/work-operations';
import { NotificationService } from '@ever-works/agent/notifications';
import { WorkImportPayload, WorkImportResult } from '@ever-works/agent/tasks';
import { normalizeGeneratorError } from '@ever-works/agent/services';
import { WorkScheduleService } from '@ever-works/agent/services';
import { ImportExecutorService } from '@ever-works/agent/import';
import { calculateDurationSeconds } from '@ever-works/agent/utils';
import { BaseOrchestrator } from './base-orchestrator';

export type TriggerImportOptions = {
    work: Work;
    user: User;
    payload: WorkImportPayload;
    gitToken?: string;
};

export type TriggerImportCancellationOptions = {
    work: Work;
    historyId: string;
    historyStartedAt?: string;
};

@Injectable()
export class TriggerImportOrchestrator extends BaseOrchestrator {
    protected readonly logger = new Logger(TriggerImportOrchestrator.name);
    protected readonly operationLabel = 'Import';

    constructor(
        private readonly importExecutor: ImportExecutorService,
        private readonly workScheduleService: WorkScheduleService,
        workOperations: WorkOperationsService,
        @Optional()
        notificationService?: NotificationService,
    ) {
        super(workOperations, notificationService);
    }

    async run({ work, user, payload, gitToken }: TriggerImportOptions): Promise<void> {
        const startTime = this.resolveStartTime(payload.historyStartedAt);

        await Promise.all([
            this.workOperations.recordGenerationStartTime(work.id, startTime),
            this.workOperations.updateGenerateStatus(work.id, {
                status: GenerateStatusType.GENERATING,
                step: 'import_started',
            }),
            this.workOperations.updateGenerationHistory(work.id, payload.historyId, {
                status: GenerateStatusType.GENERATING,
                startedAt: startTime,
            }),
        ]);

        let result: WorkImportResult | null = null;

        try {
            result = await this.importExecutor.executeBySourceType({
                work,
                user,
                sourceType: payload.sourceType,
                sourceOwner: payload.sourceOwner,
                sourceRepo: payload.sourceRepo,
                sourceUrl: payload.sourceUrl,
                token: gitToken,
                createMissingRepos: payload.options?.createMissingRepos,
                reuseSourceRepositoryAsMain: payload.options?.reuseSourceRepositoryAsMain,
                expansionFactor: payload.enrichmentConfig?.expansionFactor,
                providers: payload.providers,
                worksConfig: payload.worksConfig,
            });

            if (!result.success) {
                throw new Error(result.error || 'Import failed');
            }

            const endTime = new Date();

            if (payload.worksConfig?.scheduleCadence) {
                try {
                    await this.workScheduleService.updateSchedule(
                        work.id,
                        {
                            enable: true,
                            cadence: payload.worksConfig.scheduleCadence,
                            alwaysCreatePullRequest: true,
                            providerOverrides:
                                payload.worksConfig.providers &&
                                Object.keys(payload.worksConfig.providers).length > 0
                                    ? payload.worksConfig.providers
                                    : null,
                        },
                        user,
                    );
                } catch (error) {
                    this.logger.warn(
                        `Failed to restore schedule from .works/works.yml for work ${work.id}: ${
                            error instanceof Error ? error.message : String(error)
                        }`,
                    );
                }
            }

            await Promise.all([
                this.workOperations.recordGenerationFinishTime(work.id, endTime),
                this.workOperations.updateGenerateStatus(work.id, {
                    status: GenerateStatusType.GENERATED,
                    step: null,
                }),
                this.workOperations.updateGenerationHistory(work.id, payload.historyId, {
                    status: GenerateStatusType.GENERATED,
                    finishedAt: endTime,
                    durationInSeconds: calculateDurationSeconds(startTime, endTime),
                    ...buildImportStatsUpdate(result),
                }),
                this.workOperations.updateWork(work.id, {
                    itemsCount: result?.itemsImported ?? 0,
                }),
            ]);
        } catch (error) {
            const endTime = new Date();

            await Promise.all([
                this.workOperations.recordGenerationFinishTime(work.id, endTime),
                this.workOperations.updateGenerateStatus(work.id, {
                    status: GenerateStatusType.ERROR,
                    error: normalizeGeneratorError(error),
                }),
            ]);

            await this.workOperations.updateGenerationHistory(work.id, payload.historyId, {
                status: GenerateStatusType.ERROR,
                finishedAt: endTime,
                durationInSeconds: calculateDurationSeconds(startTime, endTime),
                errorMessage: normalizeGeneratorError(error),
                ...buildImportStatsUpdate(result),
            });

            this.logger.error('Import failed', error as Error);

            await this.handleErrorNotification(error, user, work);

            throw error;
        } finally {
            await this.workOperations.emitGenerationCompleted(work.id);
        }
    }
}
