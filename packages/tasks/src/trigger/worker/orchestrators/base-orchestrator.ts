import { Logger, Optional } from '@nestjs/common';
import { Work, User, GenerateStatusType } from '@ever-works/agent/entities';
import { WorkOperationsService } from '@ever-works/agent/work-operations';
import { NotificationService } from '@ever-works/agent/notifications';
import { classifyGenerationError, notifyForClassifiedError } from '@ever-works/agent/services';
import { calculateDurationSeconds } from '@ever-works/agent/utils';

export type OrchestratorTerminalOptions = {
    work: Work;
    historyId: string;
    historyStartedAt?: string;
};

export type OrchestratorFailureOptions = OrchestratorTerminalOptions & {
    errorMessage: string;
};

export abstract class BaseOrchestrator {
    protected abstract readonly logger: Logger;
    protected abstract readonly operationLabel: string;

    constructor(
        protected readonly workOperations: WorkOperationsService,
        @Optional()
        protected readonly notificationService?: NotificationService,
    ) {}

    protected resolveStartTime(historyStartedAt?: string): Date {
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

    async handleFailure({
        work,
        historyId,
        historyStartedAt,
        errorMessage,
    }: OrchestratorFailureOptions): Promise<void> {
        // Always attempt to write the terminal state for both work and history.
        // We cannot rely on work.status === ERROR implying history.status === ERROR:
        // if the orchestrator's catch block wrote work=ERROR but then the history
        // update threw, history stays in GENERATING. Writing ERROR twice is idempotent.
        const finishedAt = new Date();
        const startTime = this.resolveStartTime(historyStartedAt);
        const duration = Math.max(0, calculateDurationSeconds(startTime, finishedAt));

        await this.recordTerminalState({
            workId: work.id,
            historyId,
            finishedAt,
            duration,
            status: GenerateStatusType.ERROR,
            message: errorMessage,
        });

        await this.workOperations.emitGenerationCompleted(work.id);
    }

    async handleCancellation({
        work,
        historyId,
        historyStartedAt,
    }: OrchestratorTerminalOptions): Promise<void> {
        const finishedAt = new Date();
        const startTime = this.resolveStartTime(historyStartedAt);
        const duration = Math.max(0, calculateDurationSeconds(startTime, finishedAt));
        const message = `${this.operationLabel} cancelled`;

        await this.recordTerminalState({
            workId: work.id,
            historyId,
            finishedAt,
            duration,
            status: GenerateStatusType.CANCELLED,
            message,
        });

        await this.workOperations.emitGenerationCompleted(work.id);
    }

    protected async handleErrorNotification(
        error: unknown,
        user: User,
        work: Work,
    ): Promise<void> {
        if (!this.notificationService) {
            return;
        }

        const classification = classifyGenerationError(error);

        if (classification.type !== 'unknown') {
            await notifyForClassifiedError(
                this.notificationService,
                user.id,
                work.id,
                work.name,
                classification,
            );
        }
    }

    private async recordTerminalState(opts: {
        workId: string;
        historyId: string;
        finishedAt: Date;
        duration: number;
        status: GenerateStatusType;
        message: string;
    }): Promise<void> {
        await Promise.all([
            this.workOperations.recordGenerationFinishTime(opts.workId, opts.finishedAt),
            this.workOperations.updateGenerateStatus(opts.workId, {
                status: opts.status,
                error: opts.message,
                step: null,
            }),
            this.workOperations.updateGenerationHistory(opts.workId, opts.historyId, {
                status: opts.status,
                finishedAt: opts.finishedAt,
                durationInSeconds: opts.duration,
                errorMessage: opts.message,
            }),
        ]);
    }
}
