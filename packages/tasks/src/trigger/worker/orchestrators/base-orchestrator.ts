import { Logger, Optional } from '@nestjs/common';
import { Directory, User, GenerateStatusType } from '@ever-works/agent/entities';
import { DirectoryOperationsService } from '@ever-works/agent/directory-operations';
import { NotificationService } from '@ever-works/agent/notifications';
import { classifyGenerationError, notifyForClassifiedError } from '@ever-works/agent/services';
import { calculateDurationSeconds } from '@ever-works/agent/utils';

export type OrchestratorTerminalOptions = {
    directory: Directory;
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
        protected readonly directoryOperations: DirectoryOperationsService,
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
        directory,
        historyId,
        historyStartedAt,
        errorMessage,
    }: OrchestratorFailureOptions): Promise<void> {
        // Always attempt to write the terminal state for both directory and history.
        // We cannot rely on directory.status === ERROR implying history.status === ERROR:
        // if the orchestrator's catch block wrote directory=ERROR but then the history
        // update threw, history stays in GENERATING. Writing ERROR twice is idempotent.
        const finishedAt = new Date();
        const startTime = this.resolveStartTime(historyStartedAt);
        const duration = Math.max(0, calculateDurationSeconds(startTime, finishedAt));

        await this.recordTerminalState({
            directoryId: directory.id,
            historyId,
            finishedAt,
            duration,
            status: GenerateStatusType.ERROR,
            message: errorMessage,
        });

        await this.directoryOperations.emitGenerationCompleted(directory.id);
    }

    async handleCancellation({
        directory,
        historyId,
        historyStartedAt,
    }: OrchestratorTerminalOptions): Promise<void> {
        const finishedAt = new Date();
        const startTime = this.resolveStartTime(historyStartedAt);
        const duration = Math.max(0, calculateDurationSeconds(startTime, finishedAt));
        const message = `${this.operationLabel} cancelled`;

        await this.recordTerminalState({
            directoryId: directory.id,
            historyId,
            finishedAt,
            duration,
            status: GenerateStatusType.CANCELLED,
            message,
        });

        await this.directoryOperations.emitGenerationCompleted(directory.id);
    }

    protected async handleErrorNotification(
        error: unknown,
        user: User,
        directory: Directory,
    ): Promise<void> {
        if (!this.notificationService) {
            return;
        }

        const classification = classifyGenerationError(error);

        if (classification.type !== 'unknown') {
            await notifyForClassifiedError(
                this.notificationService,
                user.id,
                directory.id,
                directory.name,
                classification,
            );
        }
    }

    private async recordTerminalState(opts: {
        directoryId: string;
        historyId: string;
        finishedAt: Date;
        duration: number;
        status: GenerateStatusType;
        message: string;
    }): Promise<void> {
        await Promise.all([
            this.directoryOperations.recordGenerationFinishTime(opts.directoryId, opts.finishedAt),
            this.directoryOperations.updateGenerateStatus(opts.directoryId, {
                status: opts.status,
                error: opts.message,
                step: null,
            }),
            this.directoryOperations.updateGenerationHistory(opts.directoryId, opts.historyId, {
                status: opts.status,
                finishedAt: opts.finishedAt,
                durationInSeconds: opts.duration,
                errorMessage: opts.message,
            }),
        ]);
    }
}
