import {
    BadRequestException,
    Injectable,
    Logger,
    NotFoundException,
    Optional,
} from '@nestjs/common';
import type { RecordListView } from '@ever-works/contracts';
import { RecordAccessPolicy } from '../record-visibility/record-access-policy.service';
import {
    RecordVisibilityService,
    type TeamSideChange,
} from '../record-visibility/record-visibility.service';
import { InjectRepository } from '@nestjs/typeorm';
import { ILike, In, Repository, type EntityManager, type FindOptionsWhere } from 'typeorm';
import {
    DomainEventPublisher,
    recordAfterWrite,
} from '../domain-events/domain-event-publisher.service';
import { withoutAggregateVersion } from '../domain-events/domain-event-context';
import {
    Mission,
    MissionOutcome,
    MissionStatus,
    MissionType,
    type MissionGuardrailsOverride,
} from '../entities/mission.entity';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { ActivityActionType, ActivityStatus } from '../entities/activity-log.types';
import { MissionAttachment } from '../entities/mission-attachment.entity';
import { MissionGoal } from '../entities/mission-goal.entity';
import { WorkProposal } from '../entities/work-proposal.entity';
import { UserUpload } from '../entities/user-upload.entity';
import { MissionAttachmentRepository } from '../database/repositories/attachment.repositories';
import {
    MissionWorkRepository,
    type MissionWorkWithMission,
    type MissionWorkWithWork,
} from '../database/repositories/mission-work.repository';
import { MISSION_WORK_RELATIONS, type MissionWorkRelation } from '../entities/mission-work.entity';
import { Work } from '../entities/work.entity';
import { TitlerService } from '../titler/titler.service';
import { MissionTickService } from './mission-tick.service';
import { toMissionDto, type MissionDto } from './types';
// Security: lexical SSRF predicate (blocks non-HTTP(S) schemes, literal
// private/loopback/link-local IPs, and cloud-metadata hostnames). Reused to
// validate full-URL forms of `missionTemplateRepo` so a malicious value can
// never be persisted for the Phase 8 scaffolder to clone/fetch.
import { isSafeWebhookUrl } from '../utils';
import {
    ownershipStamp,
    ownershipWhere,
    ownershipWhereWith,
    type OwnershipScope,
} from '../database/ownership-scope';

// Upload IDs are SHA-256 hex strings (the `id` field returned by
// POST /api/uploads/file). 64 lowercase hex chars — NOT UUID-shaped
// (Codex + Greptile P1 on PR #1044).
const SHA256_RE = /^[0-9a-f]{64}$/i;

// Security: `missionTemplateRepo` is documented as a GitHub-style `owner/repo`
// slug (e.g. `ever-works/p2p-marketplace-mission-template`) and is consumed by
// the Phase 8 scaffolder to clone/fetch a template repo. Accept ONLY the
// documented slug shape: 2+ path segments of [A-Za-z0-9._-] joined by single
// `/`, no leading/trailing slash. This intentionally rejects every SSRF /
// scheme-injection vector (`file://`, `git://`, `http://`, `ssh://`,
// credentials with `@`, whitespace, backslashes) because they all contain
// characters or `://` outside this set. Full HTTPS git URLs are handled
// separately via `isSafeWebhookUrl` so legitimate `https://github.com/...`
// inputs still pass while private-IP / non-TLS hosts are blocked.
const TEMPLATE_REPO_SLUG_RE = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+$/;

// `missionTemplateRepo` ALSO doubles as the template SELECTOR for the seeded
// catalog: the product's mission-create flow stores the chosen catalog id
// (e.g. `starter-business` — see `NewPageClient` + `MISSION_TEMPLATES`)
// directly in this column, and a scaffolder resolves it via
// `findMissionTemplateConfig()` rather than cloning the raw string. A bare
// single-segment slug (`[A-Za-z0-9._-]+`, no `/`) therefore must be accepted
// too. It is SSRF-safe by construction: with no `:`, `/`, `@`, whitespace or
// backslash it cannot encode a scheme, host, port or credential — the exact
// vectors the URL branch below guards against.
const TEMPLATE_REPO_BARE_SLUG_RE = /^[A-Za-z0-9._-]+$/;

/**
 * Input shape for `MissionsService.create`. Mirrors the writable
 * subset of `Mission` minus the FK fields the system owns
 * (`sourceMissionId` is set by Clone; `missionRepo` is set by
 * Phase 8 PR X's scaffolder). Validation lives at the DTO layer
 * (`CreateMissionDto` in apps/api).
 */
export interface CreateMissionInput {
    /**
     * Phase 3 PR I — optional. When omitted/empty, the service
     * derives a short title from `description` via the shared
     * TitlerService (heuristic today; AI-backed in a follow-up
     * without touching this signature).
     */
    title?: string;
    description: string;
    type: MissionType;
    schedule?: string | null;
    autoBuildWorks?: boolean;
    outstandingIdeasCap?: number | null;
    guardrailsOverride?: MissionGuardrailsOverride | null;
    missionTemplateRepo?: string | null;
    /** EW-P2-5 — the starting status. Omitted = ACTIVE (today's default). */
    status?: MissionStatus.ACTIVE | MissionStatus.PAUSED;
    /** EW-P2-5 — who created it when it is not the owner (an integration key / act-as person). */
    createdBy?: { type: 'user' | 'agent' | 'integration'; id: string };
    /** EW-P2-5 — a hand-picked `team` / `organization` (integration writes). Omitted = D11. */
    visibility?: 'team' | 'organization';
    /** EW-P2-5 — Teams (`team_resources` type `mission`) of the Mission's Organization. */
    teamIds?: string[];
}

/**
 * Input shape for `MissionsService.update`. All fields optional —
 * undefined leaves the existing value alone. `null` on the
 * nullable fields explicitly clears them.
 */
export interface UpdateMissionInput {
    title?: string;
    description?: string;
    type?: MissionType;
    schedule?: string | null;
    autoBuildWorks?: boolean;
    outstandingIdeasCap?: number | null;
    guardrailsOverride?: MissionGuardrailsOverride | null;
    missionTemplateRepo?: string | null;
}

export interface ListMissionsFilter {
    /** Record visibility (EW-P1-3) list tab: `mine` (default), `shared`, `organization`. */
    view?: RecordListView;
    status?: MissionStatus;
    search?: string;
    limit?: number;
    offset?: number;
}

/**
 * Mission lifecycle state-machine. Spec §1.3 defines the four
 * statuses (ACTIVE / PAUSED / COMPLETED / FAILED). The transitions
 * here enforce which user-initiated actions are valid from which
 * source status:
 *
 *   pause:    ACTIVE          → PAUSED
 *   resume:   PAUSED          → ACTIVE
 *   complete: ACTIVE | PAUSED → COMPLETED
 *   FAILED is a terminal status set only by the tick worker
 *   (PR J) on fatal generation errors — no user action lands here.
 *
 * `runNow` is gated to ACTIVE | PAUSED only (no point running a
 * Mission that's already COMPLETED or FAILED). The actual tick
 * dispatch is a placeholder until PR J wires Trigger.dev.
 */
const PAUSABLE_STATUSES: ReadonlyArray<MissionStatus> = [MissionStatus.ACTIVE];
// PR-3: FAILED is revivable - resume doubles as the recovery path once
// the tick worker starts persisting fatal failures (review finding P4).
const RESUMABLE_STATUSES: ReadonlyArray<MissionStatus> = [
    MissionStatus.PAUSED,
    MissionStatus.FAILED,
];
const COMPLETABLE_STATUSES: ReadonlyArray<MissionStatus> = [
    MissionStatus.ACTIVE,
    MissionStatus.PAUSED,
];
const RUNNABLE_STATUSES: ReadonlyArray<MissionStatus> = [
    MissionStatus.ACTIVE,
    MissionStatus.PAUSED,
];

/**
 * Phase 3 PR G — MissionsService skeleton (Missions/Ideas/Works
 * build).
 *
 * This PR only ships the listForUser read path so the module's DI
 * graph is exercised at boot and `GET /me/missions` returns []
 * gracefully for users with no Missions yet. Full CRUD + lifecycle
 * (pause / resume / complete / delete / run-now) lands in PR H.
 *
 * The service intentionally injects the raw TypeORM `Repository<Mission>`
 * rather than a custom `MissionRepository` class — the Mission
 * data-access surface is small enough that a custom repository
 * doesn't earn its keep yet. If/when query complexity grows
 * (Phase 3 PR J's tick worker may want hand-tuned queries) we can
 * extract a repository later without changing the service contract.
 */
/**
 * Runs inside a Mission create's transaction, after the row and its `mission.created` event
 * (T17a pattern): the integration API links the new Mission to its `externalRef` there. A
 * throw rolls the create back.
 */
export type MissionWithinCreate = (
    mission: { readonly id: string },
    manager: EntityManager,
) => Promise<void>;

@Injectable()
export class MissionsService {
    private readonly logger = new Logger(MissionsService.name);

    constructor(
        @InjectRepository(Mission)
        private readonly missions: Repository<Mission>,
        // Phase 3 PR I — shared titler. Used by create() when the
        // caller's title is empty or missing.
        private readonly titler: TitlerService,
        // Phase 3 PR J — Mission tick worker. Optional so the
        // existing MissionsService unit-test (which constructs
        // the service hand-rolled with only repo + titler) keeps
        // compiling without rewiring all four downstream deps.
        // In production DI both providers live in MissionsModule
        // and the @Optional() resolves to a real instance.
        @Optional()
        private readonly tickService?: MissionTickService,
        // `@Optional()` for the same reason as `tickService` — hand-rolled
        // tests construct MissionsService without the attachments dep.
        // Production DI provides it via MissionsModule.
        @Optional()
        private readonly missionAttachments?: MissionAttachmentRepository,
        // Upload-ownership validation for addAttachment — `user_uploads` indexes
        // every upload by (userId, sha256). `@Optional()` so hand-rolled tests
        // (no repo) skip; production/e2e DI provides it.
        @Optional()
        @InjectRepository(UserUpload)
        private readonly uploadsRepo?: Repository<UserUpload>,
        // PR-2 (domain-model evolution) — the explicit Mission↔Work M:N
        // edge + Work-ownership validation for attach. `@Optional()` for
        // the same hand-rolled-test reason as the deps above.
        @Optional()
        private readonly missionWorks?: MissionWorkRepository,
        @Optional()
        @InjectRepository(Work)
        private readonly worksRepo?: Repository<Work>,
        // PR-3 - Mission lifecycle activity logging (closes audit gap G3).
        // `@Optional()` like every other secondary dep here; best-effort at
        // call sites so an activity failure never fails the operation.
        @Optional()
        private readonly activityLog?: ActivityLogService,
        // Record visibility (EW-P1-3) — the shared / org tabs and the readable get.
        // Appended LAST + @Optional(): absent means reads stay owner-only.
        @Optional() private readonly accessPolicy?: RecordAccessPolicy,
        // EW-P2-5 — `mission.*` domain events: every write and its event commit
        // together. TRAILING + @Optional(): a graph without it records nothing.
        @Optional() private readonly domainEvents?: DomainEventPublisher,
        // EW-P2-5 — integration-created Missions' Teams + D11 (`createExternal`).
        @Optional() private readonly recordVisibility?: RecordVisibilityService,
    ) {}

    /**
     * List all Missions owned by `userId`, sorted by `updatedAt`
     * desc (most-recently-touched first). Returns DTOs, not raw
     * entities, so consumers don't accidentally lean on TypeORM
     * internals.
     *
     * Phase 3 PR G placeholder: no status filtering, no pagination.
     * PR H adds filter + pagination; PR R (Phase 6 frontend) drives
     * the design for which controls land where.
     */
    async listForUser(
        userId: string,
        filter: ListMissionsFilter = {},
        scope?: OwnershipScope,
    ): Promise<MissionDto[]> {
        const view = filter.view ?? 'mine';
        if (view !== 'mine' && this.accessPolicy) {
            const { rows } = await this.accessPolicy.listVisible<Mission>({
                aggregate: 'mission',
                userId,
                scope,
                view,
                take: filter.limit,
                skip: filter.offset,
                refine: (qb, alias) => {
                    if (filter.status) {
                        qb.andWhere(`${alias}.status = :missionStatus`, {
                            missionStatus: filter.status,
                        });
                    }
                },
                search: { term: filter.search, columns: ['title', 'description'] },
            });
            return rows.map(toMissionDto);
        }
        const baseWhere = (scope ? ownershipWhere<Mission>(userId, scope) : [{ userId }]).map(
            (branch) => ({
                ...branch,
                ...(filter.status ? { status: filter.status } : {}),
            }),
        );
        const search = filter.search?.trim();
        const where: FindOptionsWhere<Mission> | FindOptionsWhere<Mission>[] = search
            ? baseWhere.flatMap((branch) => [
                  { ...branch, title: ILike(`%${search}%`) },
                  { ...branch, description: ILike(`%${search}%`) },
              ])
            : scope
              ? baseWhere
              : baseWhere[0];
        const rows = await this.missions.find({
            where,
            order: { updatedAt: 'DESC' },
            take: filter.limit,
            skip: filter.offset,
        });
        return rows.map(toMissionDto);
    }

    /**
     * Phase 3 PR H — fetch a single Mission, scoped to its owner.
     * Throws NotFoundException (NestJS auto-maps to 404) when the
     * Mission doesn't exist OR doesn't belong to this user — same
     * response shape either way so the API doesn't leak whether
     * the id exists.
     */
    async getForUser(
        userId: string,
        missionId: string,
        scope?: OwnershipScope,
    ): Promise<MissionDto> {
        const row = await this.findOrThrow(userId, missionId, scope);
        return toMissionDto(row);
    }

    /**
     * Record visibility (EW-P1-3) — the READ of one Mission: the owner exactly as
     * {@link getForUser}, or anyone `visibleTo(principal)` admits in the active
     * Organization. Only `GET /api/me/missions/:id` uses it; every other route keeps
     * {@link getForUser} / `findOrThrow` as its owner gate, so no write is widened.
     */
    async getReadable(
        userId: string,
        missionId: string,
        scope?: OwnershipScope,
    ): Promise<MissionDto> {
        try {
            return await this.getForUser(userId, missionId, scope);
        } catch (error) {
            if (!(error instanceof NotFoundException) || !this.accessPolicy) throw error;
            const shared = await this.accessPolicy.findVisibleNotOwned<Mission>({
                aggregate: 'mission',
                userId,
                id: missionId,
                scope,
            });
            if (!shared) throw error;
            return toMissionDto(shared);
        }
    }

    /**
     * Phase 3 PR H — create a new Mission owned by `userId`.
     * Defaults: status=ACTIVE, autoBuildWorks=false. Caller-side
     * DTO (CreateMissionDto in apps/api) enforces title/description
     * length and the `schedule required iff type=scheduled` rule.
     *
     * The shared titler (Phase 3 PR I) will eventually generate the
     * title from the description automatically when the caller
     * doesn't supply one. For now title is required.
     */
    async create(
        userId: string,
        input: CreateMissionInput,
        scope?: OwnershipScope,
        options: { withinCreate?: MissionWithinCreate } = {},
    ): Promise<MissionDto> {
        if (options.withinCreate && !this.domainEvents) {
            throw new Error('Mission withinCreate needs DomainEventsModule (one transaction)');
        }
        this.assertScheduleConsistency(input.type, input.schedule);
        const description = input.description.trim();
        // Phase 3 PR I — when the caller doesn't pass a title (or
        // passes an empty/whitespace one), generate one from the
        // description via the shared titler. Mission titles use the
        // 'mission' kind hint so the future AI-backed titler can
        // tune its style (ambitious + goal-oriented) per spec §1.3.
        const callerTitle = input.title?.trim();
        const title = callerTitle
            ? callerTitle.slice(0, 200)
            : (
                  await this.titler.generateTitle(description, {
                      kind: 'mission',
                      userId,
                      maxChars: 200,
                  })
              ).slice(0, 200);
        const saved = await this.persist(
            this.missions.create({
                userId,
                ...ownershipStamp(scope),
                title,
                description,
                type: input.type,
                status: input.status ?? MissionStatus.ACTIVE,
                schedule: this.normalizeSchedule(input.type, input.schedule ?? null),
                autoBuildWorks: input.autoBuildWorks ?? false,
                outstandingIdeasCap: input.outstandingIdeasCap ?? null,
                guardrailsOverride: input.guardrailsOverride ?? null,
                // Security: validate/normalize before persisting (SSRF defense-in-depth).
                missionTemplateRepo: this.normalizeTemplateRepo(input.missionTemplateRepo),
                missionRepo: null, // Phase 8 PR X scaffolder sets this.
                sourceMissionId: null, // Mission Clone (PR HH) sets this.
                ...(input.createdBy
                    ? { createdByType: input.createdBy.type, createdById: input.createdBy.id }
                    : {}),
                ...(input.visibility
                    ? { visibility: input.visibility, visibilityExplicit: true }
                    : {}),
            }),
            async (publisher, manager, row) => {
                let teamSide: TeamSideChange | null = null;
                if (input.teamIds && input.teamIds.length > 0) {
                    if (!this.recordVisibility) {
                        throw new Error('Mission teamIds need RecordVisibilityModule');
                    }
                    const teams = await this.recordVisibility.setTeamsIn(
                        manager,
                        'mission',
                        row.id,
                        [...new Set(input.teamIds)],
                        userId,
                    );
                    teamSide = teams?.teamSide ?? null;
                    await this.recordVisibility.recomputeAutomaticIn(manager, 'mission', row.id, {
                        recordEvent: false,
                    });
                }
                await publisher.created(manager, 'mission', row.id, 'mission.created');
                // Review 2026-10-17 F34: the Teams' `team.resource.added`, after the Mission's.
                if (teamSide) await this.recordVisibility!.recordTeamSideIn(manager, teamSide);
                // T17a pattern — e.g. the integration API's externalRef link, in this
                // transaction: a throw rolls the Mission back.
                if (options.withinCreate) await options.withinCreate({ id: row.id }, manager);
            },
        );
        await this.recordActivity(userId, ActivityActionType.MISSION_CREATED, 'create', {
            missionId: saved.id,
            title: saved.title,
        });
        return toMissionDto(saved);
    }

    /**
     * EW-P2-5 — create a Mission for an integration (contract v1 B.6 `POST /missions`,
     * plan D3b: a Gauzy Strategic Initiative). Always `paused` (D9: only a person
     * resumes a Mission in Ever Works, which is what starts its ticks), never
     * auto-building Works, no guardrails (an EW-only setting; a `scheduled` Mission keeps
     * its cron but ticks only once resumed), and a title is
     * required (no AI titler call). `teamIds` and D11 apply in the create's
     * transaction, with `mission.created`, and so does `withinCreate` (T17a pattern: the
     * integration API's `externalRef` link, so a throw there undoes the create).
     */
    async createExternal(
        userId: string,
        input: {
            title: string;
            description: string;
            type?: MissionType.ONE_SHOT | MissionType.SCHEDULED | 'one-shot' | 'scheduled';
            schedule?: string | null;
            teamIds?: string[];
            visibility?: 'team' | 'organization';
            createdBy?: { type: 'user' | 'agent' | 'integration'; id: string };
        },
        scope: OwnershipScope,
        options: { withinCreate?: MissionWithinCreate } = {},
    ): Promise<MissionDto> {
        if (input.visibility !== undefined) {
            RecordVisibilityService.assertIntegrationVisibility(input.visibility);
        }
        if (!scope.organizationId) {
            throw new BadRequestException('An integration Mission is created in an Organization.');
        }
        if (!input.title?.trim()) throw new BadRequestException('title is required');
        if (!input.description?.trim()) throw new BadRequestException('description is required');
        return this.create(
            userId,
            {
                title: input.title,
                description: input.description,
                type: input.type === 'scheduled' ? MissionType.SCHEDULED : MissionType.ONE_SHOT,
                schedule: input.type === 'scheduled' ? (input.schedule ?? null) : null,
                autoBuildWorks: false,
                status: MissionStatus.PAUSED,
                teamIds: input.teamIds,
                visibility: input.visibility,
                createdBy: input.createdBy,
            },
            scope,
            options,
        );
    }

    /**
     * EW-P2-5 — replace the Mission's typed Work links with `links` (integration `PUT
     * /missions/:id/works`): detach the missing pairs, attach the new ones, each with
     * its `mission.work.*` event. Every Work must be the caller's in the scope (404).
     */
    async setWorks(
        userId: string,
        missionId: string,
        links: ReadonlyArray<{ workId: string; relation: MissionWorkRelation }>,
        scope?: OwnershipScope,
    ): Promise<MissionWorkWithWork[]> {
        await this.findOrThrow(userId, missionId, scope);
        const wanted = new Map(links.map((link) => [`${link.workId}:${link.relation}`, link]));
        const current = await this.listWorks(userId, missionId, scope);
        const present = new Set(current.map((row) => `${row.workId}:${row.relation}`));
        // Every new Work must be the caller's (404) BEFORE the first detach, so a foreign
        // Work never leaves a half-replaced set behind.
        if (this.worksRepo) {
            for (const [key, link] of wanted) {
                if (present.has(key)) continue;
                const work = await this.worksRepo.findOne({
                    where: scope
                        ? ownershipWhere<Work>(userId, scope).map((branch) => ({
                              ...branch,
                              id: link.workId,
                          }))
                        : { id: link.workId, userId },
                    select: { id: true },
                });
                if (!work) throw new NotFoundException(`Work not found`);
            }
        }
        for (const row of current) {
            if (!wanted.has(`${row.workId}:${row.relation}`)) {
                await this.detachWork(userId, missionId, row.workId, row.relation, scope);
            }
        }
        for (const [key, link] of wanted) {
            if (present.has(key)) continue;
            await this.attachWork(userId, missionId, link.workId, link.relation, scope);
        }
        return this.listWorks(userId, missionId, scope);
    }

    /**
     * Phase 3 PR H — partial update. Only writes fields the caller
     * explicitly included. Re-validates the schedule-vs-type
     * consistency rule when EITHER field is being touched (changing
     * type from scheduled→one-shot must also clear schedule;
     * changing type→scheduled must provide one).
     */
    async update(
        userId: string,
        missionId: string,
        input: UpdateMissionInput,
        scope?: OwnershipScope,
    ): Promise<MissionDto> {
        const existing = await this.findOrThrow(userId, missionId, scope);

        const nextType = input.type ?? existing.type;
        const nextSchedule =
            input.schedule !== undefined
                ? input.schedule
                : input.type !== undefined && input.type !== existing.type
                  ? null // Type changed but caller didn't pass schedule — derive null and let the consistency check fail loudly when needed.
                  : existing.schedule;

        this.assertScheduleConsistency(nextType, nextSchedule);

        if (input.title !== undefined) existing.title = input.title.trim().slice(0, 200);
        if (input.description !== undefined) existing.description = input.description.trim();
        if (input.type !== undefined) existing.type = input.type;
        if (input.schedule !== undefined) {
            existing.schedule = this.normalizeSchedule(nextType, input.schedule);
        } else if (input.type !== undefined && input.type !== MissionType.SCHEDULED) {
            // Type flipped away from SCHEDULED — clear the orphan cron.
            existing.schedule = null;
        }
        if (input.autoBuildWorks !== undefined) existing.autoBuildWorks = input.autoBuildWorks;
        if (input.outstandingIdeasCap !== undefined)
            existing.outstandingIdeasCap = input.outstandingIdeasCap;
        if (input.guardrailsOverride !== undefined)
            existing.guardrailsOverride = input.guardrailsOverride;
        if (input.missionTemplateRepo !== undefined)
            // Security: validate/normalize before persisting (SSRF defense-in-depth).
            existing.missionTemplateRepo = this.normalizeTemplateRepo(input.missionTemplateRepo);

        const changedFields = Object.keys(input).filter(
            (key) => (input as Record<string, unknown>)[key] !== undefined,
        );
        const saved = await this.persist(existing, (publisher, manager, row) =>
            publisher.changed(manager, 'mission', row.id, 'mission.updated', { changedFields }),
        );
        return toMissionDto(saved);
    }

    /**
     * Phase 3 PR H — state-machine transition methods. All four
     * share the same shape: load + assert source status + write +
     * return the freshly-loaded DTO. Errors:
     *   - 404 NotFound when the Mission doesn't exist for this user.
     *   - 400 BadRequest when the current status doesn't allow the
     *     transition (e.g. pause-ing an already-PAUSED Mission).
     */
    async pause(userId: string, missionId: string, scope?: OwnershipScope): Promise<MissionDto> {
        const dto = await this.transition(
            userId,
            missionId,
            PAUSABLE_STATUSES,
            MissionStatus.PAUSED,
            'pause',
            undefined,
            scope,
        );
        await this.recordActivity(userId, ActivityActionType.MISSION_PAUSED, 'pause', {
            missionId,
        });
        return dto;
    }

    /**
     * EW-P2-5 — ACTIVE | PAUSED → FAILED for an integration (contract v1 `PATCH
     * /missions/:id {status: 'failed'}`, Gauzy CR-8): the same stop a fatal tick makes.
     * Revivable: `resume` accepts FAILED.
     */
    async fail(userId: string, missionId: string, scope?: OwnershipScope): Promise<MissionDto> {
        return this.transition(
            userId,
            missionId,
            COMPLETABLE_STATUSES,
            MissionStatus.FAILED,
            'fail',
            undefined,
            scope,
        );
    }

    async resume(userId: string, missionId: string, scope?: OwnershipScope): Promise<MissionDto> {
        const dto = await this.transition(
            userId,
            missionId,
            RESUMABLE_STATUSES,
            MissionStatus.ACTIVE,
            'resume',
            undefined,
            scope,
        );
        await this.recordActivity(userId, ActivityActionType.MISSION_RESUMED, 'resume', {
            missionId,
        });
        return dto;
    }

    /**
     * PR-3 (review §23.2) - Complete keeps its verb and its stored
     * status value ('completed'); it now optionally records a
     * conclusion `outcome` (succeeded | partially_succeeded | failed |
     * cancelled | superseded) plus `completedAt`. Outcome is
     * HUMAN-ONLY judgment: this method is reachable only from
     * user-authenticated surfaces, and the autonomous agent runtime
     * deliberately has no complete-mission tool (invariant I-4 -
     * outcome is never derived from task/idea counts either).
     */
    async complete(
        userId: string,
        missionId: string,
        outcome?: MissionOutcome | null,
        scope?: OwnershipScope,
    ): Promise<MissionDto> {
        if (outcome != null && !Object.values(MissionOutcome).includes(outcome)) {
            throw new BadRequestException(
                `Invalid outcome "${outcome}". Allowed: ${Object.values(MissionOutcome).join(', ')}.`,
            );
        }
        const dto = await this.transition(
            userId,
            missionId,
            COMPLETABLE_STATUSES,
            MissionStatus.COMPLETED,
            'complete',
            (m) => {
                m.outcome = outcome ?? null;
                m.completedAt = new Date();
            },
            scope,
        );
        await this.recordActivity(userId, ActivityActionType.MISSION_COMPLETED, 'complete', {
            missionId,
            outcome: outcome ?? null,
        });
        return dto;
    }

    /**
     * Phase 3 PR H — delete a Mission. Allowed from ANY status
     * (including COMPLETED + FAILED). DB-side cascade rules
     * already preserve child Ideas (`work_proposals.missionId` FK
     * is ON DELETE SET NULL per migration 0.2) and clones
     * (`missions.sourceMissionId` FK is ON DELETE SET NULL per
     * migration 0.10) — so deleting a Mission breaks the
     * back-links but leaves the children intact.
     *
     * Returns `{ deleted: true }` on success, 404 when the Mission
     * doesn't exist for this user.
     */
    async delete(
        userId: string,
        missionId: string,
        scope?: OwnershipScope,
    ): Promise<{ deleted: true }> {
        const existing = await this.findOrThrow(userId, missionId, scope);
        const publisher = this.domainEvents;
        if (publisher) {
            // `mission.deleted` carries the last snapshot (version claimed first, under the
            // row lock) in the delete's own transaction.
            await publisher.transaction(async (manager) => {
                // The delete cascades: its Goal links go (ON DELETE CASCADE) and its Ideas'
                // `missionId` / clones' `sourceMissionId` are cleared (SET NULL). Read them
                // first so each changed record also records its update (no stale links).
                const goalIds = (
                    await manager.getRepository(MissionGoal).find({
                        where: { missionId },
                        select: { goalId: true },
                    })
                ).map((row) => row.goalId);
                const ideaIds = (
                    await manager.getRepository(WorkProposal).find({
                        where: { missionId },
                        select: { id: true },
                    })
                ).map((row) => row.id);
                const cloneIds = (
                    await manager.getRepository(Mission).find({
                        where: { sourceMissionId: missionId },
                        select: { id: true },
                    })
                ).map((row) => row.id);
                const tombstone = await publisher.beforeDelete(manager, 'mission', missionId);
                await manager.getRepository(Mission).delete({ id: missionId });
                await publisher.deleted(manager, tombstone, 'mission.deleted');
                for (const goalId of new Set(goalIds)) {
                    await publisher.changed(manager, 'goal', goalId, 'goal.updated', {
                        changedFields: ['missionIds', 'primaryMissionId'],
                    });
                }
                for (const ideaId of ideaIds) {
                    await publisher.changed(manager, 'idea', ideaId, 'idea.updated', {
                        changedFields: ['missionId'],
                    });
                }
                for (const cloneId of cloneIds) {
                    await publisher.changed(manager, 'mission', cloneId, 'mission.updated', {
                        changedFields: ['sourceMissionId'],
                    });
                }
            });
        } else {
            await this.missions.remove(existing);
        }
        await this.recordActivity(userId, ActivityActionType.MISSION_DELETED, 'delete', {
            missionId,
            title: existing.title,
        });
        return { deleted: true };
    }

    /**
     * Phase 3 PR J — manually trigger a Mission tick. Delegates
     * to `MissionTickService.runOnce`, which bypasses the cron
     * match check (the whole point of runNow) but still enforces
     * the outstanding-Ideas cap so repeated clicks can't flood
     * the Mission past the user's own throttle.
     *
     * When MissionTickService isn't wired (the hand-rolled unit
     * tests construct MissionsService without the tick dep), the
     * old PR H noop response is returned so those tests keep
     * passing. Production DI always provides it via
     * `MissionsModule`.
     *
     * The state-machine gate (ACTIVE | PAUSED) is enforced before
     * the dispatch — PR J's tick service trusts callers to have
     * validated the Mission is runnable.
     */
    async runNow(
        userId: string,
        missionId: string,
        scope?: OwnershipScope,
    ): Promise<{
        status:
            | 'noop-placeholder'
            | 'queued'
            | 'spawned'
            | 'cap-hit'
            | 'no-ideas'
            | 'failed'
            | 'cron-no-match';
        missionId: string;
        ideasCreated?: number;
        ideasQueued?: number;
        message?: string;
    }> {
        const mission = await this.findOrThrow(userId, missionId, scope);
        if (!RUNNABLE_STATUSES.includes(mission.status)) {
            throw new BadRequestException(
                `Mission cannot be run from status "${mission.status}". Allowed: ${RUNNABLE_STATUSES.join(', ')}.`,
            );
        }
        if (!this.tickService) {
            this.logger.warn(
                `Mission ${missionId} run-now: MissionTickService not wired — returning placeholder.`,
            );
            return { status: 'noop-placeholder', missionId };
        }
        const result = await this.tickService.runOnce(missionId, userId);
        return {
            status: result.outcome,
            missionId,
            ideasCreated: result.ideasCreated,
            ideasQueued: result.ideasQueued,
            message: result.message,
        };
    }

    /**
     * List the Upload edges attached to a Mission. Validates ownership
     * (only the Mission's `userId` can list) before returning rows.
     * Returns an empty array when the attachments repo isn't wired
     * (hand-rolled tests) — same defensive shape as the tick service.
     */
    async listAttachments(
        userId: string,
        missionId: string,
        scope?: OwnershipScope,
    ): Promise<MissionAttachment[]> {
        await this.findOrThrow(userId, missionId, scope);
        if (!this.missionAttachments) return [];
        // The Mission itself is the authority: it was ownership-validated
        // above, and an attachment row carries only (missionId, uploadId)
        // where uploadId is a hash the caller supplied at attach time — no
        // cross-user or cross-Organization data can leak through it. Do NOT
        // re-filter (or fail) the list against the caller's `user_uploads`
        // visibility in the CURRENT scope: legacy rows pre-date scope
        // stamping (upgrade-from-account backfills `missions` but not
        // `user_uploads`), and pre-fix rows may be stored uppercase — either
        // would 404 the owner's entire attachment list of an in-scope
        // Mission and make individual attachments impossible to discover
        // and remove.
        return this.missionAttachments.findByMissionId(missionId);
    }

    /**
     * Attach an uploaded file (by `uploadId` from `POST /api/uploads/file`)
     * to a Mission. Idempotent at the DB layer — the unique
     * (missionId, uploadId) index turns a duplicate attach into a no-op
     * conflict that we swallow and return the existing row.
     */
    async addAttachment(
        userId: string,
        missionId: string,
        uploadId: string,
        scope?: OwnershipScope,
    ): Promise<MissionAttachment> {
        await this.findOrThrow(userId, missionId, scope);
        if (!uploadId || !SHA256_RE.test(uploadId)) {
            throw new BadRequestException(`Invalid uploadId`);
        }
        // Canonicalize ONCE and use the canonical value for the ownership
        // lookup, persistence, and duplicate recovery alike (mirrors
        // AgentsService.addAttachment). `user_uploads.sha256` is stored
        // lowercase, so persisting a raw uppercase input would create an
        // attachment edge the upload join can never resolve again.
        const canonicalUploadId = uploadId.toLowerCase();
        // Security: the uploadId must reference a real upload owned by the
        // caller (404 — don't leak existence). Closes the dangling/foreign
        // attachment edge the hunt found.
        if (this.uploadsRepo) {
            const owned = await this.uploadsRepo.findOne({
                where: ownershipWhereWith<UserUpload>(userId, scope, {
                    sha256: canonicalUploadId,
                }),
            });
            if (!owned) throw new NotFoundException(`Upload ${uploadId} not found.`);
        }
        if (!this.missionAttachments) {
            throw new BadRequestException(
                `MissionAttachmentRepository is not wired — attach the MissionAttachment provider before calling addAttachment`,
            );
        }
        try {
            return await this.missionAttachments.add(missionId, canonicalUploadId);
        } catch (err) {
            // Duplicate (missionId, uploadId) — swallow and re-read.
            // Mirrors the idempotency contract on Task attachments.
            if (err instanceof Error && /duplicate key|unique constraint/i.test(err.message)) {
                const existing = (await this.missionAttachments.findByMissionId(missionId)).find(
                    (a) => a.uploadId === canonicalUploadId,
                );
                if (existing) return existing;
            }
            throw err;
        }
    }

    /**
     * Detach an Upload from a Mission. Validates ownership of the
     * Mission AND that the attachment row's `missionId` matches before
     * deleting, so a malicious caller can't pass a foreign
     * `attachmentId` to clean up someone else's edge.
     */
    async removeAttachment(
        userId: string,
        missionId: string,
        attachmentId: string,
        scope?: OwnershipScope,
    ): Promise<{ deleted: true }> {
        await this.findOrThrow(userId, missionId, scope);
        if (!this.missionAttachments) {
            throw new NotFoundException(`Attachment not found`);
        }
        const row = await this.missionAttachments.findOne(attachmentId);
        if (!row || row.missionId !== missionId) {
            throw new NotFoundException(`Attachment not found`);
        }
        await this.missionAttachments.remove(attachmentId);
        return { deleted: true };
    }

    /**
     * PR-2 — list the Works this Mission relates to (the explicit
     * `mission_works` edge; review §8.1). Ownership-gated on the
     * Mission; empty when the repo isn't wired (hand-rolled tests).
     */
    async listWorks(
        userId: string,
        missionId: string,
        scope?: OwnershipScope,
    ): Promise<MissionWorkWithWork[]> {
        await this.findOrThrow(userId, missionId, scope);
        if (!this.missionWorks) return [];
        return scope
            ? this.missionWorks.listForMissionWithWork(missionId, userId, scope)
            : this.missionWorks.listForMissionWithWork(missionId, userId);
    }

    /**
     * PR-2 — attach an EXISTING Work to this Mission with a typed
     * relation. Both endpoints must belong to the caller (Work check
     * mirrors the accept path's IDOR contract: foreign/unknown ids →
     * 404, existence-leak-safe). Idempotent on duplicates. Never
     * transfers ownership — invariant I-7: Missions never own Works.
     */
    async attachWork(
        userId: string,
        missionId: string,
        workId: string,
        relation: MissionWorkRelation,
        scope?: OwnershipScope,
    ): Promise<MissionWorkWithWork[]> {
        await this.findOrThrow(userId, missionId, scope);
        if (!MISSION_WORK_RELATIONS.includes(relation)) {
            throw new BadRequestException(
                `Invalid relation "${relation}". Allowed: ${MISSION_WORK_RELATIONS.join(', ')}.`,
            );
        }
        if (!this.missionWorks || !this.worksRepo) {
            throw new BadRequestException(
                `MissionWorkRepository is not wired — attach the provider before calling attachWork`,
            );
        }
        const work = await this.worksRepo.findOne({
            where: scope
                ? ownershipWhere<Work>(userId, scope).map((branch) => ({ ...branch, id: workId }))
                : { id: workId, userId },
        });
        if (!work) {
            throw new NotFoundException(`Work not found`);
        }
        const inserted = await this.missionWorks.attach({ missionId, workId, userId, relation });
        if (inserted !== false) {
            // EW-P2-5 — `mission.work.linked` (child: the link; aggregate: the Mission).
            await recordAfterWrite(
                this.domainEvents,
                (publisher, manager) =>
                    publisher.child(
                        manager,
                        'mission',
                        missionId,
                        'mission.work.linked',
                        { missionId, workId, relation },
                        { changedFields: ['works'] },
                    ),
                (message) => this.logger.warn(message),
                `mission.work.linked for mission ${missionId}`,
            );
        }
        return scope
            ? this.missionWorks.listForMissionWithWork(missionId, userId, scope)
            : this.missionWorks.listForMissionWithWork(missionId, userId);
    }

    /**
     * PR-2 — detach a relation. Deletes only the edge row; the Work is
     * untouched (I-6). 404 when the edge doesn't exist for this owner.
     */
    async detachWork(
        userId: string,
        missionId: string,
        workId: string,
        relation: MissionWorkRelation,
        scope?: OwnershipScope,
    ): Promise<{ deleted: true }> {
        await this.findOrThrow(userId, missionId, scope);
        if (!this.missionWorks) {
            throw new NotFoundException(`Relation not found`);
        }
        const removed = await this.missionWorks.detach({
            missionId,
            workId,
            userId,
            relation,
            ...(scope ? { scope } : {}),
        });
        if (!removed) {
            throw new NotFoundException(`Relation not found`);
        }
        // EW-P2-5 — `mission.work.unlinked` (child: the removed link + `deleted: true`).
        await recordAfterWrite(
            this.domainEvents,
            (publisher, manager) =>
                publisher.child(
                    manager,
                    'mission',
                    missionId,
                    'mission.work.unlinked',
                    { missionId, workId, relation, deleted: true },
                    { changedFields: ['works'] },
                ),
            (message) => this.logger.warn(message),
            `mission.work.unlinked for mission ${missionId}`,
        );
        return { deleted: true };
    }

    /**
     * PR-2 — reverse lookup: the Missions related to one of the
     * caller's Works (drives the Work-detail "Missions" panel).
     */
    async listMissionsForWork(
        userId: string,
        workId: string,
        scope?: OwnershipScope,
    ): Promise<MissionWorkWithMission[]> {
        if (scope && this.worksRepo) {
            const work = await this.worksRepo.findOne({
                where: ownershipWhere<Work>(userId, scope).map((branch) => ({
                    ...branch,
                    id: workId,
                })),
            });
            if (!work) throw new NotFoundException(`Work not found`);
        }
        if (!this.missionWorks) return [];
        return scope
            ? this.missionWorks.listForWorkWithMission(workId, userId, scope)
            : this.missionWorks.listForWorkWithMission(workId, userId);
    }

    // ─── internals ──────────────────────────────────────────────────

    private async findOrThrow(
        userId: string,
        missionId: string,
        scope?: OwnershipScope,
    ): Promise<Mission> {
        const row = await this.missions.findOne({
            where: ownershipWhereWith<Mission>(userId, scope, { id: missionId }),
        });
        if (!row) {
            throw new NotFoundException(`Mission not found`);
        }
        return row;
    }

    private async transition(
        userId: string,
        missionId: string,
        allowedFrom: ReadonlyArray<MissionStatus>,
        target: MissionStatus,
        verb: string,
        mutate?: (mission: Mission) => void,
        scope?: OwnershipScope,
    ): Promise<MissionDto> {
        const existing = await this.findOrThrow(userId, missionId, scope);
        if (!allowedFrom.includes(existing.status)) {
            throw new BadRequestException(
                `Mission cannot be ${verb.endsWith('e') ? `${verb}d` : `${verb}ed`} from status "${existing.status}". Allowed: ${allowedFrom.join(', ')}.`,
            );
        }
        const statusBefore = existing.status;
        existing.status = target;
        // PR-3: re-activating a failed Mission clears the conclusion
        // fields - a revived Mission has no verdict yet.
        if (target === MissionStatus.ACTIVE) {
            existing.outcome = null;
            existing.completedAt = null;
        }
        mutate?.(existing);
        const saved = await this.persist(existing, (publisher, manager, row) =>
            publisher.changed(manager, 'mission', row.id, 'mission.status_changed', {
                changedFields: ['status', 'outcome', 'completedAt'],
                previous: { status: statusBefore },
            }),
        );
        return toMissionDto(saved);
    }

    /**
     * Save a Mission and record its event in ONE transaction (EW-P2-5): the version bump
     * (re-checked against an integration's `If-Match`), the snapshot and the outbox row
     * commit with the write or not at all. Without a publisher it is today's plain save.
     */
    private async persist(
        mission: Mission,
        record: (
            publisher: DomainEventPublisher,
            manager: EntityManager,
            row: Mission,
        ) => Promise<unknown>,
    ): Promise<Mission> {
        const publisher = this.domainEvents;
        if (!publisher) return this.missions.save(withoutAggregateVersion(mission));
        return publisher.transaction(async (manager) => {
            const row = await manager.getRepository(Mission).save(withoutAggregateVersion(mission));
            await record(publisher, manager, row);
            return row;
        });
    }

    /**
     * PR-3 - best-effort activity write (never fails the operation;
     * no-ops when the service isn't wired, e.g. hand-rolled tests).
     */
    private async recordActivity(
        userId: string,
        actionType: ActivityActionType,
        action: string,
        details: Record<string, unknown>,
    ): Promise<void> {
        if (!this.activityLog) return;
        try {
            await this.activityLog.log({
                userId,
                actionType,
                action,
                status: ActivityStatus.COMPLETED,
                summary: `Mission ${action}`,
                details: details as Record<string, any>,
            });
        } catch (error) {
            this.logger.warn(
                `Failed to write mission activity (${actionType}): ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }

    /**
     * Enforce the schedule-vs-type consistency rule:
     *   - type=scheduled  → schedule MUST be a non-empty string.
     *   - type=one-shot   → schedule MUST be null/empty.
     *
     * We check at create + update boundaries rather than via a DB
     * CHECK constraint because the constraint is awkward to express
     * portably across SQLite (test driver) and Postgres.
     */
    private assertScheduleConsistency(
        type: MissionType,
        schedule: string | null | undefined,
    ): void {
        const hasSchedule = typeof schedule === 'string' && schedule.trim().length > 0;
        if (type === MissionType.SCHEDULED && !hasSchedule) {
            throw new BadRequestException(
                'Mission.type=scheduled requires a non-empty `schedule` (cron expression).',
            );
        }
        if (type === MissionType.ONE_SHOT && hasSchedule) {
            throw new BadRequestException(
                'Mission.type=one-shot must NOT have a `schedule` set; pass null or omit.',
            );
        }
    }

    /**
     * Security (SSRF defense-in-depth): validate `missionTemplateRepo` on
     * write so a hostile value never reaches the Phase 8 scaffolder that
     * clones/fetches it. `null`/empty clears the field (unchanged behavior).
     * A non-empty value MUST be either the documented `owner/repo` slug or a
     * well-formed HTTPS git URL that passes the lexical SSRF guard — anything
     * with a `file://`/`git://`/`http://`/`ssh://` scheme, an embedded
     * credential, a private/loopback/metadata host, whitespace, or a backslash
     * is rejected. Legitimate inputs (`owner/repo`, `https://github.com/...`)
     * are unaffected.
     */
    private normalizeTemplateRepo(value: string | null | undefined): string | null {
        if (value === undefined || value === null) return null;
        const trimmed = value.trim();
        if (trimmed.length === 0) return null;
        if (trimmed.length > 200) {
            throw new BadRequestException('Mission.missionTemplateRepo is too long (max 200).');
        }
        // Accept the documented GitHub-style `owner/repo` shorthand outright.
        if (TEMPLATE_REPO_SLUG_RE.test(trimmed)) return trimmed;
        // Accept a bare catalog-id selector (`starter-business`, etc.). Safe:
        // a single `[A-Za-z0-9._-]+` segment cannot carry an SSRF payload.
        if (TEMPLATE_REPO_BARE_SLUG_RE.test(trimmed)) return trimmed;
        // Otherwise the only other acceptable shape is a full HTTPS git URL on
        // a public host. Reuse the shared lexical SSRF guard, but additionally
        // require TLS (`isSafeWebhookUrl` allows http:) and reject embedded
        // credentials so `https://user:pass@host` / `https://169.254.169.254`
        // style payloads can't slip through.
        let parsed: URL | null = null;
        try {
            parsed = new URL(trimmed);
        } catch {
            parsed = null;
        }
        if (
            parsed &&
            parsed.protocol === 'https:' &&
            !parsed.username &&
            !parsed.password &&
            isSafeWebhookUrl(trimmed)
        ) {
            return trimmed;
        }
        throw new BadRequestException(
            'Mission.missionTemplateRepo must be a GitHub-style "owner/repo" slug or an HTTPS git URL on a public host.',
        );
    }

    private normalizeSchedule(type: MissionType, schedule: string | null): string | null {
        if (type === MissionType.ONE_SHOT) return null;
        if (typeof schedule === 'string') {
            const trimmed = schedule.trim();
            return trimmed.length > 0 ? trimmed : null;
        }
        return schedule;
    }
}
