import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, LessThan, Repository } from 'typeorm';
import { User } from '@ever-works/agent/entities';
import { UserRepository } from '@ever-works/agent/database';
import {
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

    async isResearching(userId: string): Promise<boolean> {
        return this.inFlight.has(userId);
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
    ): Promise<{ status: 'queued' | 'rate-limited'; error?: string }> {
        if (this.inFlight.has(userId)) {
            return { status: 'queued', error: 'already in flight' };
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
        void this.runPipeline(userId, source).finally(() => this.inFlight.delete(userId));
        return { status: 'queued' };
    }

    /** Pick stale candidate users and queue a refresh for each. */
    async runScheduledBatch(): Promise<ScheduledBatchSummary> {
        const batchSize = Number(
            this.config.get<string | number>('USER_RESEARCH_SCHEDULED_RERUN_BATCH', 20),
        );
        const staleDays = Number(
            this.config.get<string | number>('USER_RESEARCH_SCHEDULED_RERUN_STALE_DAYS', 30),
        );
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

    private async runPipeline(userId: string, source: WorkProposalSource): Promise<void> {
        try {
            const researched = await this.research.research(userId);
            if (researched.status !== 'completed') {
                this.logger.log(
                    `User research for ${userId} did not complete (status=${researched.status}); skipping proposals`,
                );
                return;
            }
            const generated = await this.proposals.generate(userId, { source });
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
