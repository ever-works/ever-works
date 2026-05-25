import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, LessThan, Repository } from 'typeorm';
import { User } from '@ever-works/agent/entities';
import { DistributedTaskLockService } from '@ever-works/agent/cache';
import { UserRepository } from '@ever-works/agent/database';
import {
    DEFAULT_MAX_PENDING_WORK_PROPOSALS,
    UserResearchService,
    UserResearchLimitsService,
    UserResearchRateLimitedError,
    WorkProposalService,
    WorkProposalSource,
    WorkProposalStatus,
} from '@ever-works/agent/user-research';

export interface ScheduledBatchSummary {
    candidates: number;
    queued: number;
    skipped: number;
    failed: number;
    batchSize: number;
    staleDays: number;
}

const SCHEDULED_RERUN_BATCH_SIZE = 20;
const SCHEDULED_RERUN_STALE_DAYS = 30;
const PIPELINE_LOCK_TTL_MS = 2 * 60 * 60 * 1000;
const PIPELINE_LOCK_KEY_PREFIX = 'work-proposals:pipeline';

@Injectable()
export class WorkProposalsApiService {
    private readonly logger = new Logger(WorkProposalsApiService.name);
    private readonly inFlight = new Set<string>();

    constructor(
        private readonly research: UserResearchService,
        private readonly proposals: WorkProposalService,
        private readonly limits: UserResearchLimitsService,
        private readonly users: UserRepository,
        @InjectRepository(User) private readonly userOrmRepo: Repository<User>,
        private readonly config: ConfigService,
        private readonly taskLockService?: DistributedTaskLockService,
    ) {}

    async list(userId: string, statuses: WorkProposalStatus[] = [WorkProposalStatus.PENDING]) {
        return this.proposals.list(userId, statuses);
    }

    async dismiss(userId: string, proposalId: string): Promise<boolean> {
        return this.proposals.dismiss(userId, proposalId);
    }

    async accept(userId: string, proposalId: string, workId: string): Promise<boolean> {
        const proposal = await this.proposals.getForUser(userId, proposalId);
        if (!proposal) return false;
        return this.proposals.markAccepted(userId, proposalId, workId);
    }

    async getForUser(userId: string, proposalId: string) {
        return this.proposals.getForUser(userId, proposalId);
    }

    async isResearching(userId: string): Promise<boolean> {
        return this.inFlight.has(userId);
    }

    /**
     * Combined status used by the dashboard to decide whether to render
     * the "Suggest more ideas" affordance. Reports both whether a refresh
     * is currently running and whether the user has any daily quota left.
     */
    async getRefreshStatus(userId: string): Promise<{
        researching: boolean;
        canRefresh: boolean;
        refreshDisabledReason?: 'rate-limited' | 'at-limit';
    }> {
        const researching = await this.isPipelineRunning(userId);
        const canRun = await this.limits.canRun(userId);
        if (!canRun) {
            return { researching, canRefresh: false, refreshDisabledReason: 'rate-limited' };
        }

        if (await this.hasReachedPendingProposalLimit(userId)) {
            return { researching, canRefresh: false, refreshDisabledReason: 'at-limit' };
        }

        return { researching, canRefresh: true };
    }

    async getPreferences(userId: string): Promise<{ optOut: boolean }> {
        const user = await this.users.findById(userId);
        return { optOut: user?.userResearchOptOut ?? false };
    }

    async updatePreferences(userId: string, optOut: boolean): Promise<{ optOut: boolean }> {
        await this.users.update(userId, { userResearchOptOut: optOut });
        return { optOut };
    }

    /** Fold a newly-created Work's categories/tags into inferredInterests.topics. */
    async ingestWorkCreated(
        userId: string,
        signals: { categories?: string[]; tags?: string[]; name?: string },
    ): Promise<void> {
        try {
            const user = await this.users.findById(userId);
            if (!user || !user.inferredInterests) return;
            const existing = new Set(user.inferredInterests.topics ?? []);
            signals.categories?.forEach((c) => existing.add(c.toLowerCase()));
            signals.tags?.forEach((t) => existing.add(t.toLowerCase()));
            const topics = Array.from(existing).slice(0, 20);
            await this.users.update(userId, {
                inferredInterests: { ...user.inferredInterests, topics },
            });
        } catch (err) {
            this.logger.warn(
                `Failed to ingest work-created signals for ${userId}: ${(err as Error).message}`,
            );
        }
    }

    async refresh(
        userId: string,
        source: WorkProposalSource = WorkProposalSource.USER_REFRESH,
    ): Promise<{ status: 'queued' | 'rate-limited' | 'at-limit'; error?: string }> {
        if (await this.isPipelineRunning(userId)) {
            return { status: 'queued', error: 'already in flight' };
        }

        if (await this.hasReachedPendingProposalLimit(userId)) {
            return { status: 'at-limit', error: 'pending proposal limit reached' };
        }

        try {
            await this.limits.assertCanRun(userId);
        } catch (err) {
            if (err instanceof UserResearchRateLimitedError) {
                return { status: 'rate-limited', error: err.message };
            }
            throw err;
        }

        this.inFlight.add(userId);
        void this.runPipelineLocked(userId, source).finally(() => this.inFlight.delete(userId));
        return { status: 'queued' };
    }

    /** Pick stale candidate users and queue a refresh for each. */
    async runScheduledBatch(): Promise<ScheduledBatchSummary> {
        const batchSize = SCHEDULED_RERUN_BATCH_SIZE;
        const staleDays = SCHEDULED_RERUN_STALE_DAYS;
        const cutoff = new Date(Date.now() - staleDays * 24 * 60 * 60 * 1000);

        const candidates = await this.userOrmRepo.find({
            where: [
                { isActive: true, userResearchOptOut: false, inferredInterests: IsNull() },
                { isActive: true, userResearchOptOut: false, updatedAt: LessThan(cutoff) },
            ],
            take: batchSize,
            order: { updatedAt: 'ASC' },
        });

        let queued = 0;
        let skipped = 0;
        let failed = 0;

        for (const user of candidates) {
            const researchedAt = user.inferredInterests?.researchedAt
                ? new Date(user.inferredInterests.researchedAt)
                : null;
            if (researchedAt && researchedAt > cutoff) {
                skipped++;
                continue;
            }
            try {
                const result = await this.refresh(user.id, WorkProposalSource.SCHEDULED);
                if (result.status === 'queued') queued++;
                else skipped++;
            } catch (err) {
                failed++;
                this.logger.warn(
                    `Scheduled rerun dispatch failed for ${user.id}: ${(err as Error).message}`,
                );
            }
        }

        const summary: ScheduledBatchSummary = {
            candidates: candidates.length,
            queued,
            skipped,
            failed,
            batchSize,
            staleDays,
        };
        if (candidates.length > 0 || failed > 0) {
            this.logger.log(
                `Scheduled rerun batch: ${queued} queued, ${skipped} skipped, ${failed} failed (${candidates.length}/${batchSize} candidates, staleDays=${staleDays})`,
            );
        }
        return summary;
    }

    private getPipelineLockKey(userId: string): string {
        return PIPELINE_LOCK_KEY_PREFIX + ':' + userId;
    }

    private async isPipelineRunning(userId: string): Promise<boolean> {
        if (this.inFlight.has(userId)) return true;
        return (await this.taskLockService?.isLocked(this.getPipelineLockKey(userId))) ?? false;
    }

    private getMaxPendingProposals(): number {
        const raw = this.config.get<string | number>(
            'WORK_PROPOSALS_MAX_PENDING',
            DEFAULT_MAX_PENDING_WORK_PROPOSALS,
        );
        const value = Number(raw);
        return Number.isInteger(value) && value > 0 ? value : DEFAULT_MAX_PENDING_WORK_PROPOSALS;
    }

    private async hasReachedPendingProposalLimit(userId: string): Promise<boolean> {
        const pending = await this.proposals.countPending(userId).catch(() => 0);
        return pending >= this.getMaxPendingProposals();
    }

    private async runPipelineLocked(userId: string, source: WorkProposalSource): Promise<void> {
        if (!this.taskLockService) {
            await this.runPipeline(userId, source);
            return;
        }

        const result = await this.taskLockService.runExclusive(
            this.getPipelineLockKey(userId),
            async () => this.runPipeline(userId, source),
            {
                ttlMs: PIPELINE_LOCK_TTL_MS,
                onLocked: () =>
                    this.logger.debug(
                        `Skipping work-proposals pipeline for ${userId}; another instance holds the lock`,
                    ),
            },
        );

        if (!result.acquired) {
            return;
        }
    }

    private getPositiveNumberConfig(key: string, fallback: number): number {
        const raw = this.config.get<string | number>(key, fallback);
        const value = Number(raw);
        return Number.isFinite(value) && value > 0 ? value : fallback;
    }

    private async runPipeline(userId: string, source: WorkProposalSource): Promise<void> {
        try {
            const researched = await this.research.research(userId, {
                timeoutMs: this.getPositiveNumberConfig('USER_RESEARCH_TIMEOUT_MS', 1_800_000),
                maxSteps: 14,
            });

            if (researched.status !== 'completed') {
                this.logger.log(
                    `User research for ${userId} did not complete (status=${researched.status}); skipping proposals`,
                );
                return;
            }
            const generated = await this.proposals.generate(userId, {
                source,
                suppressLowConfidence: source !== WorkProposalSource.AUTO_SIGNUP,
                maxPendingProposals: this.getMaxPendingProposals(),
            });
            this.logger.log(
                `Work-proposals pipeline finished for ${userId}: status=${generated.status}, count=${generated.proposals.length}`,
            );
        } catch (err) {
            this.logger.error(
                `Work-proposals pipeline failed for ${userId}: ${(err as Error).message}`,
            );
        }
    }
}
