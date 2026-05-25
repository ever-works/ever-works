import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Not, Repository } from 'typeorm';
import { Mission, MissionStatus } from '../entities/mission.entity';
import {
    WorkProposal,
    WorkProposalSource,
    WorkProposalStatus,
} from '../entities/work-proposal.entity';
import { toMissionDto, type MissionDto } from './types';

/**
 * Optional caller-supplied overrides for the cloned Mission.
 * Anything omitted is copied verbatim from the source. `title`
 * defaults to `"Copy of <source.title>"` (clipped to 200).
 */
export interface CloneMissionOverrides {
    /** Title for the new Mission. Defaults to `"Copy of <source>"`. */
    title?: string;
}

/**
 * Outcome of a clone operation. The full new Mission DTO plus a
 * count of how many Ideas were carried over (DISMISSED Ideas are
 * filtered out per Decision A25 — they were already triaged out
 * once and cloning would resurface them as PENDING noise).
 */
export interface CloneMissionResult {
    mission: MissionDto;
    ideasCloned: number;
    /** Ideas that existed on the source but were skipped (DISMISSED). */
    ideasSkipped: number;
}

/**
 * Phase 3 PR HH — Mission Clone (Full Fork). Spec §4.4a +
 * Decisions A25 + A26.
 *
 * What gets cloned:
 *   - Mission metadata (title, description, type, schedule,
 *     autoBuildWorks, outstandingIdeasCap, guardrailsOverride,
 *     missionTemplateRepo).
 *   - Every non-DISMISSED Idea attached to the source Mission,
 *     re-inserted as a brand-new row with:
 *       * fresh UUID
 *       * `missionId = <new mission id>`
 *       * `status = PENDING` (even if the source row was ACCEPTED
 *          or FAILED — the clone is a fresh slate per A25)
 *       * `source = MISSION` (regardless of the source Idea's
 *          original source; the clone's lineage is now its parent
 *          Mission, not whatever generated it the first time)
 *       * cleared failure cols, no acceptedWorkId
 *       * preserved title/description/slug/suggestion blobs/prompt
 *
 * What does NOT get cloned (Decisions A25 + A26):
 *   - Works built from the source Mission's Ideas. They stay
 *     attached to the source Mission via the source's Ideas'
 *     `acceptedWorkId`. The cloned Mission's detail page can
 *     surface them as a read-only "Related Works (inherited)"
 *     panel by querying `sourceMissionId = <clone.id>` →
 *     `Mission(source) → Ideas → Works`. That UI lives in Phase
 *     6 PR GG.
 *   - The source's per-Mission GitHub repo (`missionRepo`). The
 *     clone gets its own repo at scaffold time (Phase 8 PR X
 *     wires this) — until then `missionRepo = null`.
 *   - Status. The clone starts ACTIVE regardless of the source's
 *     current status (a clone of a COMPLETED Mission re-activates).
 *
 * Atomicity: the clone runs in a single TypeORM transaction so
 * a partial clone never leaves orphan Ideas pointing at a
 * non-existent new Mission. The source Mission is loaded inside
 * the transaction too — if the user deletes the source mid-clone
 * we hit a 404 cleanly rather than partially copying.
 */
@Injectable()
export class MissionCloneService {
    private readonly logger = new Logger(MissionCloneService.name);

    constructor(
        @InjectRepository(Mission)
        private readonly missions: Repository<Mission>,
        @InjectRepository(WorkProposal)
        private readonly proposals: Repository<WorkProposal>,
    ) {}

    async cloneForUser(
        userId: string,
        sourceMissionId: string,
        overrides: CloneMissionOverrides = {},
    ): Promise<CloneMissionResult> {
        // The whole clone runs inside a single transaction so the
        // "new Mission + N copied Ideas" pair is atomic — partial
        // failure rolls back the new Mission too. Manager-based
        // approach (instead of QueryRunner.startTransaction) keeps
        // the code small and rides on whatever isolation level
        // TypeORM's data source is configured for.
        return this.missions.manager.transaction(async (tx) => {
            const source = await tx.findOne(Mission, {
                where: { id: sourceMissionId, userId },
            });
            if (!source) {
                throw new NotFoundException(`Mission not found`);
            }
            if (source.id === source.sourceMissionId) {
                // Self-clone is impossible (FK can't reference a row
                // before it exists), but guard anyway so a future
                // bug in this method doesn't silently produce a
                // self-referential clone.
                throw new BadRequestException(`Mission cannot be a clone of itself`);
            }

            const clonedTitle = (overrides.title?.trim() || `Copy of ${source.title}`).slice(
                0,
                200,
            );

            const newMission = await tx.save(
                tx.create(Mission, {
                    userId,
                    title: clonedTitle,
                    description: source.description,
                    type: source.type,
                    status: MissionStatus.ACTIVE,
                    schedule: source.schedule ?? null,
                    autoBuildWorks: source.autoBuildWorks,
                    outstandingIdeasCap: source.outstandingIdeasCap ?? null,
                    guardrailsOverride: source.guardrailsOverride ?? null,
                    missionTemplateRepo: source.missionTemplateRepo ?? null,
                    // Clone gets its own repo at scaffold time
                    // (Phase 8 PR X) — until then NULL.
                    missionRepo: null,
                    // The lineage back-link Decision A25 demands.
                    sourceMissionId: source.id,
                }),
            );

            // Load every Idea attached to the source EXCEPT
            // DISMISSED — those were triaged out and shouldn't
            // resurface. ACCEPTED + FAILED + BUILDING + QUEUED +
            // PENDING all clone as PENDING in the new Mission
            // (fresh-slate semantics, A25). Note: we still count
            // ALL non-PENDING source statuses for the "skipped"
            // metric below (just DISMISSED), so the caller can
            // surface a "we skipped N dismissed Ideas" hint.
            const sourceIdeas = await tx.find(WorkProposal, {
                where: { missionId: source.id, userId },
            });
            const eligible = sourceIdeas.filter(
                (idea) => idea.status !== WorkProposalStatus.DISMISSED,
            );
            const skipped = sourceIdeas.length - eligible.length;

            if (eligible.length > 0) {
                const newIdeaRows = eligible.map((src) =>
                    tx.create(WorkProposal, {
                        userId,
                        missionId: newMission.id,
                        // Fresh-slate status + cleared failure cols + no
                        // acceptedWorkId. The clone is a new chance, not
                        // a copy of state.
                        status: WorkProposalStatus.PENDING,
                        source: WorkProposalSource.MISSION,
                        failureMessage: null,
                        failureKind: null,
                        acceptedWorkId: null,
                        // Preserve the proposal content verbatim so the
                        // user's earlier review effort isn't lost.
                        title: src.title,
                        description: src.description,
                        slugSuggestion: src.slugSuggestion,
                        suggestedCategories: src.suggestedCategories ?? [],
                        suggestedFields: src.suggestedFields ?? [],
                        recommendedPlugins: src.recommendedPlugins ?? [],
                        generatedPrompt: src.generatedPrompt,
                        reasoning: src.reasoning,
                        // generationRunId is intentionally NOT carried
                        // over — the clone is its own run from an audit
                        // perspective. Same reasoning the source-side
                        // user-research generator uses for fresh batches.
                        generationRunId: undefined,
                    }),
                );
                await tx.save(WorkProposal, newIdeaRows);
            }

            this.logger.log(
                `Cloned Mission ${source.id} → ${newMission.id} for user ${userId}: ` +
                    `${eligible.length} idea(s) carried, ${skipped} dismissed-skipped.`,
            );

            return {
                mission: toMissionDto(newMission),
                ideasCloned: eligible.length,
                ideasSkipped: skipped,
            };
        });
    }

    /**
     * Read-side helper for Phase 6 PR GG's "Cloned as: N other
     * Mission(s)" affordance on the source Mission's detail page.
     * Counts every Mission whose `sourceMissionId` points at the
     * given Mission. User-scoped so users can't introspect each
     * other's clone counts.
     *
     * Uses `Not(...)` to defensively exclude self-references — the
     * FK schema permits them but the writer never sets them, and
     * counting them would be misleading.
     */
    async countClonesOf(userId: string, sourceMissionId: string): Promise<number> {
        return this.missions.count({
            where: {
                userId,
                sourceMissionId,
                id: Not(sourceMissionId),
            },
        });
    }
}
