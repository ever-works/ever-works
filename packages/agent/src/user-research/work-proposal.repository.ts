import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, In, Repository, type EntityManager } from 'typeorm';
import {
    IdeaFailureKind,
    WorkProposal,
    WorkProposalSource,
    WorkProposalStatus,
    type WorkProposalCategory,
    type WorkProposalField,
    type WorkProposalRecommendedPlugin,
} from '../entities/work-proposal.entity';
import {
    buildCaseInsensitiveLikeClause,
    prepareCaseInsensitiveContainsPattern,
} from '../database/utils';
import {
    DomainEventPublisher,
    recordAfterWrite,
    type AggregateTombstone,
    type PublishOptions,
} from '../domain-events/domain-event-publisher.service';

export interface CreateWorkProposalInput {
    userId: string;
    title: string;
    description: string;
    slugSuggestion: string;
    suggestedCategories: WorkProposalCategory[];
    suggestedFields: WorkProposalField[];
    recommendedPlugins: WorkProposalRecommendedPlugin[];
    generatedPrompt: string;
    reasoning: string;
    source: WorkProposalSource;
    generationRunId?: string;
    /**
     * Optional FK to the spawning Mission (Phase 0 PR 0.1).
     * Set by the Mission tick worker (Phase 3 PR J) when creating
     * Ideas with `source = MISSION`. NULL for all other sources.
     */
    missionId?: string | null;
}

export interface ListWorkProposalOptions {
    missionId?: string | null;
    search?: string;
    limit?: number;
    offset?: number;
}

/** The statuses a transition may start from, its target, and the columns it also writes. */
type IdeaTransition = {
    readonly from: readonly WorkProposalStatus[];
    readonly to: WorkProposalStatus;
    readonly set?: Partial<Pick<WorkProposal, 'acceptedWorkId' | 'failureMessage' | 'failureKind'>>;
};

/** Input of {@link WorkProposalRepository.createExternal} (EW-P2-1). */
export interface CreateExternalIdeaInput {
    userId: string;
    tenantId: string | null;
    organizationId: string;
    title: string;
    description: string;
    slugSuggestion: string;
    missionId?: string | null;
    /** The integration key that wrote it (`createdBy` unless {@link createdBy} says otherwise). */
    integrationKeyId: string;
    /**
     * Who created it (`writeAttribution`): the integration key, or the person an
     * `X-Act-As-User` write acts as. Omitted = the integration key.
     */
    createdBy?: { type: 'user' | 'agent' | 'integration'; id: string };
    /** `team` / `organization` by hand; omitted = automatic (D11). */
    visibility?: 'team' | 'organization';
}

/**
 * Data access for Ideas (`work_proposals`). It is also the Ideas' domain-event
 * recording point (EW-P2-1, `idea.*`): every create, status transition and delete
 * of the platform goes through here, so recording here covers them all. Recording
 * is best-effort and runs AFTER the write in its own transaction
 * ({@link recordAfterWrite}): a failure is logged, never thrown, and the
 * integration's reconcile repairs a missed event.
 */
@Injectable()
export class WorkProposalRepository {
    private readonly logger = new Logger(WorkProposalRepository.name);

    constructor(
        @InjectRepository(WorkProposal)
        private readonly repository: Repository<WorkProposal>,
        // EW-P2-1 — `idea.*` domain events. Appended LAST + @Optional(): a graph
        // without DomainEventsModule (unit tests, the worker) records nothing.
        @Optional() private readonly domainEvents?: DomainEventPublisher,
    ) {}

    /** Record `idea.created` (no version bump) or a full-snapshot `idea.*` change. */
    async recordIdeaEvent(id: string, type: string, options: PublishOptions = {}): Promise<void> {
        await recordAfterWrite(
            this.domainEvents,
            (publisher, manager) =>
                type === 'idea.created'
                    ? publisher.created(manager, 'idea', id, type, options)
                    : publisher.changed(manager, 'idea', id, type, options),
            (message) => this.logger.warn(message),
            `${type} for idea ${id}`,
        );
    }

    /**
     * A guarded status transition (`from` -> `to`, owner-scoped) that records
     * `idea.status_changed` with the previous status when the row moved. A write
     * that leaves the status unchanged (BUILDING -> BUILDING on an auto-retry)
     * records nothing.
     */
    private async transition(
        id: string,
        userId: string,
        transition: IdeaTransition,
    ): Promise<boolean> {
        const before = this.domainEvents
            ? await this.repository.findOne({
                  where: { id, userId },
                  select: { id: true, status: true },
              })
            : null;
        const res = await this.repository.update(
            { id, userId, status: In([...transition.from]) },
            { ...(transition.set ?? {}), status: transition.to },
        );
        const ok = (res.affected ?? 0) > 0;
        if (ok && before && before.status !== transition.to) {
            await this.recordIdeaEvent(id, 'idea.status_changed', {
                changedFields: ['status', ...Object.keys(transition.set ?? {})],
                previous: { status: before.status },
            });
        }
        return ok;
    }

    async bulkInsert(items: CreateWorkProposalInput[]): Promise<WorkProposal[]> {
        if (items.length === 0) return [];
        const entities = items.map((i) =>
            this.repository.create({ ...i, status: WorkProposalStatus.PENDING }),
        );
        const saved = await this.repository.save(entities);
        for (const row of saved) await this.recordIdeaEvent(row.id, 'idea.created');
        return saved;
    }

    /**
     * Insert an integration-created Idea (EW-P2-1): always `source = external` and
     * `status = pending` whatever the caller sent, scope stamped from the pinned
     * Organization, `createdBy` = the integration key (or the act-as person). No event: the caller sets the
     * Teams and records `idea.created` once they are in place (see
     * `WorkProposalService.createExternal`). Takes the caller's transaction.
     */
    async insertExternal(
        manager: EntityManager,
        input: CreateExternalIdeaInput,
    ): Promise<WorkProposal> {
        const repository = manager.getRepository(WorkProposal);
        return repository.save(
            repository.create({
                userId: input.userId,
                tenantId: input.tenantId,
                organizationId: input.organizationId,
                title: input.title,
                description: input.description,
                slugSuggestion: input.slugSuggestion,
                missionId: input.missionId ?? null,
                targetWorkId: null,
                extraPrompt: null,
                suggestedCategories: [],
                suggestedFields: [],
                recommendedPlugins: [],
                generatedPrompt: input.description,
                reasoning: 'Created by an integration (EW-P2-1).',
                source: WorkProposalSource.EXTERNAL,
                status: WorkProposalStatus.PENDING,
                createdByType: input.createdBy?.type ?? 'integration',
                createdById: input.createdBy?.id ?? input.integrationKeyId,
                ...(input.visibility
                    ? { visibility: input.visibility, visibilityExplicit: true }
                    : {}),
            }),
        );
    }

    async findByUser(
        userId: string,
        statuses: WorkProposalStatus[] = [WorkProposalStatus.PENDING],
        opts: ListWorkProposalOptions = {},
    ): Promise<WorkProposal[]> {
        const qb = this.repository
            .createQueryBuilder('p')
            .where('p.userId = :userId', { userId })
            .andWhere('p.status IN (:...statuses)', { statuses });

        // `missionId` filter supports three modes:
        //   - undefined / not passed → no filter (return all Ideas across all
        //     Missions + standalone Ideas with NULL missionId).
        //   - a string UUID → return Ideas tied to that specific Mission.
        //   - `null` explicitly → return only standalone (non-Mission) Ideas
        //     (`missionId IS NULL`).
        if (opts.missionId === null) {
            qb.andWhere('p.missionId IS NULL');
        } else if (typeof opts.missionId === 'string') {
            qb.andWhere('p.missionId = :missionId', { missionId: opts.missionId });
        }

        // `ILIKE` is PostgreSQL-only. SQLite has no such operator, so the
        // previous clause threw and `GET /api/me/work-proposals?search=`
        // returned a raw 500 on every SQLite-backed deployment (demo, OSS
        // self-host, local dev) — the /ideas page rendered its
        // "Could not load Ideas." alert instead of results.
        //
        // `buildCaseInsensitiveLikeClause` emits `LOWER(col) LIKE :p ESCAPE
        // '\'`, which runs on PostgreSQL, MySQL and SQLite alike and is
        // case-insensitive on all three — the same mechanism every other
        // search surface in the repo already uses.
        //
        // It also closes a second gap: this was the only search path that
        // skipped `sanitizeLikePattern`, so `?search=%` matched every row
        // instead of a literal percent sign.
        const searchPattern = prepareCaseInsensitiveContainsPattern(opts.search);
        if (searchPattern) {
            qb.andWhere(
                new Brackets((subQb) => {
                    subQb
                        .where(buildCaseInsensitiveLikeClause('p.title'), { search: searchPattern })
                        .orWhere(buildCaseInsensitiveLikeClause('p.description'), {
                            search: searchPattern,
                        });
                }),
            );
        }

        if (opts.limit !== undefined) qb.take(opts.limit);
        if (opts.offset !== undefined) qb.skip(opts.offset);

        return qb.orderBy('p.generatedAt', 'DESC').getMany();
    }

    async findRecentByUser(userId: string, take = 50): Promise<WorkProposal[]> {
        return this.repository.find({
            where: { userId },
            order: { generatedAt: 'DESC' },
            take,
        });
    }

    async findById(id: string): Promise<WorkProposal | null> {
        return this.repository.findOne({ where: { id } });
    }

    async findByIdForUser(id: string, userId: string): Promise<WorkProposal | null> {
        return this.repository.findOne({ where: { id, userId } });
    }

    /**
     * Hard-delete an Idea the caller owns. Scoped by `userId` so an
     * id belonging to somebody else simply matches no row (returns
     * `false` → the caller surfaces a 404, which is existence-leak
     * safe). `idea_works` rows cascade at the DB level
     * (`@ManyToOne(() => WorkProposal, { onDelete: 'CASCADE' })`);
     * the deletion GUARDS live in `WorkProposalService.delete`.
     */
    async deleteForUser(id: string, userId: string): Promise<boolean> {
        const publisher = this.domainEvents;
        // `idea.deleted` carries the last snapshot, taken (and its version claimed)
        // before the delete, for the caller's own row only.
        let tombstone: AggregateTombstone | null = null;
        if (publisher && (await this.repository.exist({ where: { id, userId } }))) {
            try {
                tombstone = await publisher.transaction((manager) =>
                    publisher.beforeDelete(manager, 'idea', id),
                );
            } catch (err) {
                this.logger.warn(`Could not snapshot idea ${id} before delete: ${String(err)}`);
            }
        }
        const res = await this.repository.delete({ id, userId });
        const ok = (res.affected ?? 0) > 0;
        if (ok && tombstone) {
            const last = tombstone;
            await recordAfterWrite(
                publisher,
                (current, manager) => current.deleted(manager, last, 'idea.deleted'),
                (message) => this.logger.warn(message),
                `idea.deleted for idea ${id}`,
            );
        }
        return ok;
    }

    async markDismissed(id: string, userId: string): Promise<boolean> {
        return this.transition(id, userId, {
            from: [WorkProposalStatus.PENDING],
            to: WorkProposalStatus.DISMISSED,
        });
    }

    /**
     * Restore a dismissed Idea to PENDING (EW-P2-1, integration `POST /ideas/:id/restore`).
     * Only from DISMISSED: an Idea that was built, queued or failed has its own paths.
     */
    async markRestored(id: string, userId: string): Promise<boolean> {
        return this.transition(id, userId, {
            from: [WorkProposalStatus.DISMISSED],
            to: WorkProposalStatus.PENDING,
        });
    }

    /**
     * Edit an Idea's title and/or description (integration `PATCH /ideas/:id`) and
     * record `idea.updated` with the fields that changed. Answers the row (unchanged
     * when nothing differs), `null` when it is not the caller's.
     */
    async updateContent(
        id: string,
        userId: string,
        patch: { title?: string; description?: string },
    ): Promise<WorkProposal | null> {
        const row = await this.repository.findOne({ where: { id, userId } });
        if (!row) return null;
        const set: Partial<Pick<WorkProposal, 'title' | 'description'>> = {};
        const previous: Record<string, unknown> = {};
        if (patch.title !== undefined && patch.title !== row.title) {
            set.title = patch.title;
            previous.title = row.title;
        }
        if (patch.description !== undefined && patch.description !== row.description) {
            set.description = patch.description;
            previous.description = row.description;
        }
        const changedFields = Object.keys(set);
        if (changedFields.length === 0) return row;
        const publisher = this.domainEvents;
        if (!publisher) {
            await this.repository.update({ id, userId }, set);
            return this.repository.findOne({ where: { id, userId } });
        }
        // The edit and its `idea.updated` commit together (unlike the build lifecycle's
        // best-effort recording): an integration `PATCH /ideas/:id` runs under its
        // `If-Match` version, which the publisher re-checks at the version bump, so a
        // stale write must roll back rather than land without its event.
        await publisher.transaction(async (manager) => {
            await manager.getRepository(WorkProposal).update({ id, userId }, set);
            await publisher.changed(manager, 'idea', id, 'idea.updated', {
                changedFields,
                previous,
            });
        });
        return this.repository.findOne({ where: { id, userId } });
    }

    /**
     * Mark a proposal accepted (transition to ACCEPTED + record the
     * `acceptedWorkId`), optionally limiting which source statuses
     * the transition is valid from.
     *
     * Phase 1 PR B extends the original PENDING-only contract: the
     * Goal-completion handler (Phase 1 PR FF) calls this with
     * `fromStatuses = [BUILDING]` because by the time a Goal
     * completes successfully the originating Idea is in BUILDING,
     * not PENDING. The existing user-facing
     * `POST /me/work-proposals/:id/accept` controller keeps calling
     * with the default `[PENDING]` — back-compat preserved.
     */
    async markAccepted(
        id: string,
        userId: string,
        workId: string,
        fromStatuses: WorkProposalStatus[] = [WorkProposalStatus.PENDING],
    ): Promise<boolean> {
        return this.transition(id, userId, {
            from: fromStatuses,
            to: WorkProposalStatus.ACCEPTED,
            set: { acceptedWorkId: workId },
        });
    }

    /**
     * Transition a proposal to `QUEUED` (Phase 1 PR B build-from-Idea
     * flow). Valid only from `PENDING` or `FAILED` (a stuck BUILDING
     * Idea needs the goal-completion or retry path, not re-queueing
     * via this method). Clears `failureMessage` + `failureKind` so a
     * post-retry build doesn't carry stale failure data.
     */
    async markQueuedForBuild(id: string, userId: string): Promise<boolean> {
        return this.transition(id, userId, {
            from: [WorkProposalStatus.PENDING, WorkProposalStatus.FAILED],
            to: WorkProposalStatus.QUEUED,
            set: { failureMessage: null, failureKind: null },
        });
    }

    /**
     * Create a single user-typed Idea (`source = USER_MANUAL`,
     * Phase 1 PR B `POST /me/work-proposals`). Auto-fills empty
     * arrays for the structured-suggestion fields the AI-generated
     * proposals normally carry — the user-manual Idea relies on the
     * description alone, and the build pipeline (PR FF / Phase 7)
     * can enrich during generation.
     */
    async createUserManual(input: {
        userId: string;
        title: string;
        description: string;
        slugSuggestion: string;
        targetWorkId?: string | null;
        extraPrompt?: string | null;
    }): Promise<WorkProposal> {
        const saved = await this.repository.save(
            this.repository.create({
                userId: input.userId,
                title: input.title,
                description: input.description,
                slugSuggestion: input.slugSuggestion,
                targetWorkId: input.targetWorkId ?? null,
                extraPrompt: input.extraPrompt ?? null,
                suggestedCategories: [],
                suggestedFields: [],
                recommendedPlugins: [],
                generatedPrompt: input.description,
                reasoning: 'Manually entered by user via +Add (spec §3.4).',
                source: WorkProposalSource.USER_MANUAL,
                status: WorkProposalStatus.PENDING,
            }),
        );
        await this.recordIdeaEvent(saved.id, 'idea.created');
        return saved;
    }

    async countPendingByUser(userId: string): Promise<number> {
        return this.repository.count({
            where: { userId, status: WorkProposalStatus.PENDING },
        });
    }

    /**
     * Phase 3 PR J — count Ideas attached to `missionId` whose
     * status is still "outstanding" (PENDING / QUEUED / BUILDING).
     * Used by the Mission tick worker to enforce the per-Mission
     * `outstandingIdeasCap`: when the count meets or exceeds the
     * cap, the tick generates nothing this cycle.
     *
     * Spec §1.3: ACCEPTED/DISMISSED/FAILED Ideas don't count
     * (they're terminal — they no longer occupy a "slot" for the
     * user to triage). PR FF moves Ideas back to QUEUED on
     * manual Retry, so a retried Idea correctly re-enters the
     * outstanding count.
     */
    async countOutstandingByMission(missionId: string): Promise<number> {
        return this.repository.count({
            where: {
                missionId,
                status: In([
                    WorkProposalStatus.PENDING,
                    WorkProposalStatus.QUEUED,
                    WorkProposalStatus.BUILDING,
                ]),
            },
        });
    }

    /**
     * Transition Idea to BUILDING. Caller: the goal-execution path
     * (when a queued Goal actually starts running). Valid from
     * QUEUED or BUILDING (the latter for the auto-retry loop —
     * Decision A24, Idea stays BUILDING across retries instead of
     * flickering to FAILED and back). Returns true iff the row was
     * affected.
     */
    async markBuilding(id: string, userId: string): Promise<boolean> {
        return this.transition(id, userId, {
            from: [WorkProposalStatus.QUEUED, WorkProposalStatus.BUILDING],
            to: WorkProposalStatus.BUILDING,
        });
    }

    /**
     * Transition Idea to FAILED. Caller: the goal-completion handler
     * on terminal failure (Phase 1 PR FF). Persists the
     * human-readable `message` and the platform-classified `kind` so
     * the Idea Card UI can render the inline error block (spec §3.9)
     * and the user can hit Retry to clear them.
     *
     * Allowed source statuses: BUILDING (normal terminal failure)
     * and QUEUED (failure during the queue → build transition).
     */
    async markFailed(
        id: string,
        userId: string,
        message: string,
        kind: IdeaFailureKind,
    ): Promise<boolean> {
        return this.transition(id, userId, {
            from: [WorkProposalStatus.BUILDING, WorkProposalStatus.QUEUED],
            to: WorkProposalStatus.FAILED,
            set: { failureMessage: message.slice(0, 5000), failureKind: kind },
        });
    }

    /**
     * Transition Idea ACCEPTED → BUILDING for the Re-build path
     * (Phase 1 PR FF `POST /me/work-proposals/:id/rebuild`,
     * Decision A27). The Idea will return to ACCEPTED when the
     * new Goal completes, with `acceptedWorkId` re-pointed at the
     * new Work. Returns the freshly-loaded Idea on success, `null`
     * if the Idea isn't in ACCEPTED for this user.
     */
    async markRebuildingFromAccepted(id: string, userId: string): Promise<boolean> {
        return this.transition(id, userId, {
            from: [WorkProposalStatus.ACCEPTED],
            to: WorkProposalStatus.BUILDING,
            set: { failureMessage: null, failureKind: null },
        });
    }
}
