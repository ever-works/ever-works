import { Injectable, Logger } from '@nestjs/common';
import type { IngestedEventWorkHint, WorkExternalRefKind } from '@ever-works/contracts';
import { WORK_EXTERNAL_REFS_MAX_PER_KIND } from '@ever-works/contracts';
import { WorkRepository } from '../database/repositories/work.repository';
import type { Work } from '../entities/work.entity';
import { matchWorkByRepo, parseRepoFullName } from '../works/work-repo-match';

/** Normalize an external id the same way on both sides of every compare. */
function normalizeRef(value: string): string {
    return value.trim().toLowerCase();
}

/**
 * `workId` routing for ingested events — turns the connector-supplied
 * {@link IngestedEventWorkHint} (a Slack channel, a GitHub repo, a
 * Linear team, a Notion database, a Zoom meeting) into a real platform
 * `workId`.
 *
 * Three rules define the whole service:
 *
 *   1. **Owner-scoped, always.** Every lookup starts from
 *      `WorkRepository.findByUser(userId)`. Two users may claim the same
 *      Slack channel; neither ever sees the other's events, and a hint
 *      can never route an event into a Work its owner does not own.
 *   2. **Null is a normal outcome.** An unmatched (or malformed, or
 *      absent) hint leaves the event user-scoped exactly as it is today.
 *      Routing is an upgrade, never a precondition.
 *   3. **Never throws.** A repository failure logs and returns null —
 *      the ingest spine must not lose an event because the router had a
 *      bad day.
 *
 * `repo` hints resolve through the repositories a Work already declares
 * (the shared `matchWorkByRepo`); every other kind resolves through the
 * `works.externalRefs` claim map.
 */
@Injectable()
export class WorkHintResolverService {
    private readonly logger = new Logger(WorkHintResolverService.name);

    constructor(private readonly works: WorkRepository) {}

    /**
     * Resolve a hint to a `workId` owned by `userId`, or null.
     *
     * @param hint the connector's hint; `undefined`/`null` short-circuits
     *             to null without touching the database.
     */
    async resolve(userId: string, hint?: IngestedEventWorkHint | null): Promise<string | null> {
        if (!hint || typeof hint !== 'object') return null;
        const externalId = typeof hint.externalId === 'string' ? hint.externalId.trim() : '';
        if (!externalId) return null;

        let works: Work[];
        try {
            works = await this.works.findByUser(userId);
        } catch (error) {
            this.logger.warn(
                `workHint resolution failed for user ${userId} (${hint.kind}) — leaving the ` +
                    `event user-scoped: ${error instanceof Error ? error.message : String(error)}`,
            );
            return null;
        }

        if (hint.kind === 'repo') {
            const parsed = parseRepoFullName(externalId);
            if (!parsed) return null;
            return matchWorkByRepo(works, parsed.owner, parsed.repo)?.id ?? null;
        }

        return this.matchByExternalRef(works, hint.kind, externalId);
    }

    /**
     * Verify that a connector-supplied `workId` really belongs to this
     * user. The push endpoint (`POST /api/ingest/events`) accepts a
     * caller-chosen `workId`, so without this an authenticated user
     * could stamp another tenant's Work onto their own events and have
     * the spine write Activity rows + Memory observations against it.
     *
     * Returns the id when it checks out, null when it provably does not.
     * A lookup FAILURE keeps the id (fail-open on infrastructure, closed
     * on identity) — same posture as the rest of the spine.
     */
    async verifyOwnedWorkId(userId: string, workId: string): Promise<string | null> {
        try {
            const work = await this.works.findById(workId);
            if (!work) return null;
            return work.userId === userId ? workId : null;
        } catch (error) {
            this.logger.warn(
                `workId ownership check failed for ${workId} — keeping the caller's value: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            return workId;
        }
    }

    /** Claim-map match: first Work whose `externalRefs[kind]` contains the id. */
    private matchByExternalRef(
        works: readonly Work[],
        kind: WorkExternalRefKind,
        externalId: string,
    ): string | null {
        const target = normalizeRef(externalId);
        for (const work of works) {
            const claimed = work.externalRefs?.[kind];
            if (!Array.isArray(claimed) || claimed.length === 0) continue;
            // Bounded scan: the column is capped per kind at write time,
            // and a hand-edited row must not turn routing into an
            // unbounded loop over one Work.
            const bounded = claimed.slice(0, WORK_EXTERNAL_REFS_MAX_PER_KIND);
            for (const ref of bounded) {
                if (typeof ref === 'string' && normalizeRef(ref) === target) {
                    return work.id;
                }
            }
        }
        return null;
    }
}
