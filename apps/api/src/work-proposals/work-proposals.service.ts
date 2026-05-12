import { Injectable, Logger } from '@nestjs/common';
import { UserRepository } from '@ever-works/agent/database';
import {
    UserResearchService,
    UserResearchLimitsService,
    UserResearchRateLimitedError,
    WorkProposalService,
    type WorkProposalSource,
} from '@ever-works/agent/user-research';

@Injectable()
export class WorkProposalsApiService {
    private readonly logger = new Logger(WorkProposalsApiService.name);
    private readonly inFlight = new Set<string>();

    constructor(
        private readonly research: UserResearchService,
        private readonly proposals: WorkProposalService,
        private readonly limits: UserResearchLimitsService,
        private readonly users: UserRepository,
    ) {}

    async list(
        userId: string,
        statuses: Array<'pending' | 'dismissed' | 'accepted'> = ['pending'],
    ) {
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
        source: WorkProposalSource = 'user-refresh',
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
