import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { User, WorkAgentPreference, type WorkProposal } from '@ever-works/agent/entities';
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
import {
    DEFAULT_AUTO_GENERATE_CADENCE_MINUTES,
    parseAutoGenerateCadenceMinutes,
    WorkAgentService,
} from '@ever-works/agent/work-agent';
import type { WorkBuildRequestDto } from '@ever-works/agent/work-agent';

export interface ScheduledBatchSummary {
    candidates: number;
    due: number;
    queued: number;
    skipped: number;
    failed: number;
    batchSize: number;
    scanLimit: number;
    defaultCadenceMinutes: number;
}

const SCHEDULED_RERUN_BATCH_SIZE = 20;
const SCHEDULED_RERUN_SCAN_LIMIT = 200;
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
        @InjectRepository(WorkAgentPreference)
        private readonly workAgentPreferences: Repository<WorkAgentPreference>,
        private readonly config: ConfigService,
        private readonly workAgent: WorkAgentService,
        private readonly taskLockService?: DistributedTaskLockService,
    ) {}

    async list(
        userId: string,
        statuses: WorkProposalStatus[] = [WorkProposalStatus.PENDING],
        opts: { missionId?: string | null; search?: string; limit?: number; offset?: number } = {},
    ) {
        return this.proposals.list(userId, statuses, opts);
    }

    async dismiss(userId: string, proposalId: string): Promise<boolean> {
        return this.proposals.dismiss(userId, proposalId);
    }

    /**
     * Idea (WorkProposal) attachment surface — thin forwarders to the
     * agent-side service. The controller maps these to
     * `POST/GET/DELETE /api/me/work-proposals/:id/attachments[/:attachmentId]`.
     */
    async listAttachments(userId: string, proposalId: string) {
        return this.proposals.listAttachments(userId, proposalId);
    }
    async addAttachment(userId: string, proposalId: string, uploadId: string) {
        return this.proposals.addAttachment(userId, proposalId, uploadId);
    }
    async removeAttachment(userId: string, proposalId: string, attachmentId: string) {
        return this.proposals.removeAttachment(userId, proposalId, attachmentId);
    }

    async accept(userId: string, proposalId: string, workId: string): Promise<boolean> {
        // Review §23.1 ruling (ADR-009, 0..N): accept is valid from PENDING
        // (first link — today's contract) AND from ACCEPTED (linking an
        // ADDITIONAL Work to an already-accepted Idea; appends an
        // `idea_works` row and re-points the denormalized `acceptedWorkId`
        // at the newest link). The shared helper lives on the agent-side
        // service so the Goal-completion handler can call it with
        // `[BUILDING]` instead.
        return this.proposals.acceptInternal(userId, proposalId, workId, [
            WorkProposalStatus.PENDING,
            WorkProposalStatus.ACCEPTED,
        ]);
    }

    /** Linked Works for the Idea (review §23.1 provenance panel). */
    async listLinkedWorks(userId: string, proposalId: string) {
        return this.proposals.listLinkedWorks(userId, proposalId);
    }

    /**
     * Phase 1 PR B — `POST /me/work-proposals` user-manual Idea
     * create. The user types a description; the service derives
     * a title (placeholder until the AI titler ships in PR I),
     * persists with source=USER_MANUAL, status=PENDING, and
     * returns the new proposal.
     */
    async createUserManual(
        userId: string,
        input: { description: string; title?: string },
    ): Promise<WorkProposal> {
        const description = input.description?.trim() ?? '';
        if (description.length < 10) {
            throw new BadRequestException('description must be at least 10 characters');
        }
        return this.proposals.createUserManual(userId, {
            description,
            title: input.title,
        });
    }

    /**
     * Phase 1 PR B — `POST /me/work-proposals/:id/build` queue an
     * existing Idea for build. Transitions Idea to QUEUED + creates
     * a `WorkBuildRequest` with `maxWorksPerRun=1` and `ideaId` set
     * back to this Idea. On build completion (Phase 1 PR FF) the
     * build-completion handler reads `ideaId` and calls
     * `acceptInternal(userId, ideaId, workId, [BUILDING])` to
     * finish the cycle.
     *
     * Returns the updated Idea + the freshly-created build request
     * (still exposed under the `goal` response key — that key is the
     * public OpenAPI/MCP wire contract; see BuildWorkProposalResponseDto).
     */
    async build(
        userId: string,
        proposalId: string,
    ): Promise<{ proposal: WorkProposal; goal: WorkBuildRequestDto } | null> {
        const existing = await this.proposals.getForUser(userId, proposalId);
        if (!existing) return null;
        if (
            existing.status !== WorkProposalStatus.PENDING &&
            existing.status !== WorkProposalStatus.FAILED
        ) {
            throw new BadRequestException(
                `Idea cannot be queued for build from status "${existing.status}". Allowed: pending, failed.`,
            );
        }
        const proposal = await this.proposals.queueForBuild(userId, proposalId);
        if (!proposal) return null;

        const { buildRequest: goal } = await this.workAgent.createBuildRequest(userId, {
            instruction: proposal.generatedPrompt?.trim() || proposal.description.trim(),
            maxWorksPerRun: 1,
            ideaId: proposal.id,
        });

        return { proposal, goal };
    }

    /**
     * Phase 1 PR FF — `POST /me/work-proposals/:id/retry` manual
     * Retry button for a FAILED Idea (spec §3.9). Clears the
     * failureMessage + failureKind, transitions FAILED → QUEUED,
     * creates a fresh WorkBuildRequest. Same shape as `build()` but
     * with stricter "must be FAILED" precondition.
     */
    async retry(
        userId: string,
        proposalId: string,
    ): Promise<{ proposal: WorkProposal; goal: WorkBuildRequestDto } | null> {
        const existing = await this.proposals.getForUser(userId, proposalId);
        if (!existing) return null;
        if (existing.status !== WorkProposalStatus.FAILED) {
            throw new BadRequestException(
                `Retry is only valid for FAILED Ideas. Current status: "${existing.status}".`,
            );
        }
        const proposal = await this.proposals.retryFailed(userId, proposalId);
        if (!proposal) return null;

        const { buildRequest: goal } = await this.workAgent.createBuildRequest(userId, {
            instruction: proposal.generatedPrompt?.trim() || proposal.description.trim(),
            maxWorksPerRun: 1,
            ideaId: proposal.id,
        });

        return { proposal, goal };
    }

    /**
     * Phase 1 PR FF — `POST /me/work-proposals/:id/rebuild` for a
     * DONE Idea (spec §3.9, Decision A27). Creates a NEW Work
     * (separate from the original); on build completion the Idea's
     * `acceptedWorkId` is re-pointed to the new Work. The original
     * Work is NOT deleted — user can keep, repurpose, or manually
     * delete it.
     */
    async rebuild(
        userId: string,
        proposalId: string,
    ): Promise<{ proposal: WorkProposal; goal: WorkBuildRequestDto } | null> {
        const existing = await this.proposals.getForUser(userId, proposalId);
        if (!existing) return null;
        if (existing.status !== WorkProposalStatus.ACCEPTED) {
            throw new BadRequestException(
                `Rebuild is only valid for ACCEPTED (Done) Ideas. Current status: "${existing.status}".`,
            );
        }
        const proposal = await this.proposals.beginRebuild(userId, proposalId);
        if (!proposal) return null;

        const { buildRequest: goal } = await this.workAgent.createBuildRequest(userId, {
            instruction: proposal.generatedPrompt?.trim() || proposal.description.trim(),
            maxWorksPerRun: 1,
            ideaId: proposal.id,
        });

        return { proposal, goal };
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

    /** Pick users whose configured auto-generate cadence is due and queue a refresh. */
    async runScheduledBatch(): Promise<ScheduledBatchSummary> {
        const batchSize = SCHEDULED_RERUN_BATCH_SIZE;
        const scanLimit = SCHEDULED_RERUN_SCAN_LIMIT;
        const now = new Date();

        const candidates = await this.userOrmRepo.find({
            where: { isActive: true, userResearchOptOut: false },
            take: scanLimit,
            order: { updatedAt: 'ASC' },
        });

        const preferenceRows = candidates.length
            ? await this.workAgentPreferences.find({
                  where: { userId: In(candidates.map((user) => user.id)) },
              })
            : [];
        const preferencesByUserId = new Map(preferenceRows.map((prefs) => [prefs.userId, prefs]));

        let due = 0;
        let queued = 0;
        let skipped = 0;
        let failed = 0;

        for (const user of candidates) {
            try {
                const prefs = preferencesByUserId.get(user.id);
                const cadenceMinutes =
                    parseAutoGenerateCadenceMinutes(prefs?.autoGenerateCadence) ??
                    DEFAULT_AUTO_GENERATE_CADENCE_MINUTES;

                if (
                    prefs?.dailySuggestionsEnabled === false ||
                    !this.isScheduledRefreshDue(user, cadenceMinutes, now)
                ) {
                    skipped++;
                    continue;
                }

                due++;
                if (due > batchSize) {
                    skipped++;
                    continue;
                }

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
            due,
            queued,
            skipped,
            failed,
            batchSize,
            scanLimit,
            defaultCadenceMinutes: DEFAULT_AUTO_GENERATE_CADENCE_MINUTES,
        };
        if (candidates.length > 0 || failed > 0) {
            this.logger.log(
                `Scheduled rerun batch: ${queued} queued, ${skipped} skipped, ${failed} failed (${due}/${candidates.length} due, batchSize=${batchSize}, scanLimit=${scanLimit})`,
            );
        }
        return summary;
    }

    private isScheduledRefreshDue(user: User, cadenceMinutes: number, now: Date): boolean {
        const researchedAtRaw = user.inferredInterests?.researchedAt;
        if (!researchedAtRaw) return true;

        const researchedAt = new Date(researchedAtRaw);
        if (!Number.isFinite(researchedAt.getTime())) return true;

        const cadenceMs = cadenceMinutes * 60 * 1000;
        return now.getTime() - researchedAt.getTime() >= cadenceMs;
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
            // Phase 1 PR D - read the user's autoGenerateBatchSize pref
            // and pass it through to the generator. Preference failures
            // must not block proposal generation.
            let targetCount: number | null = null;
            try {
                const prefs = await this.workAgent.getPreferences(userId);
                targetCount = prefs.autoGenerateBatchSize ?? null;
            } catch (err) {
                this.logger.debug(
                    `Pref-fetch for autoGenerateBatchSize failed for ${userId}; using default: ${(err as Error).message}`,
                );
            }

            const generated = await this.proposals.generate(userId, {
                source,
                suppressLowConfidence: source !== WorkProposalSource.AUTO_SIGNUP,
                maxPendingProposals: this.getMaxPendingProposals(),
                targetCount,
            });
            this.logger.log(
                `Work-proposals pipeline finished for ${userId}: status=${generated.status}, count=${generated.proposals.length}, target=${targetCount ?? 'default'}`,
            );
        } catch (err) {
            this.logger.error(
                `Work-proposals pipeline failed for ${userId}: ${(err as Error).message}`,
            );
        }
    }
}
