import {
    BadRequestException,
    Injectable,
    Logger,
    NotFoundException,
    Optional,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ILike, Repository, type FindOptionsWhere } from 'typeorm';
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
import { UserUpload } from '../entities/user-upload.entity';
import { MissionAttachmentRepository } from '../database/repositories/attachment.repositories';
import { TitlerService } from '../titler/titler.service';
import { MissionTickService } from './mission-tick.service';
import { toMissionDto, type MissionDto } from './types';
// Security: lexical SSRF predicate (blocks non-HTTP(S) schemes, literal
// private/loopback/link-local IPs, and cloud-metadata hostnames). Reused to
// validate full-URL forms of `missionTemplateRepo` so a malicious value can
// never be persisted for the Phase 8 scaffolder to clone/fetch.
import { isSafeWebhookUrl } from '../utils';

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
        // PR-3 - Mission lifecycle activity logging (closes audit gap G3).
        // `@Optional()` like every other secondary dep here; best-effort at
        // call sites so an activity failure never fails the operation.
        @Optional()
        private readonly activityLog?: ActivityLogService,
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
    async listForUser(userId: string, filter: ListMissionsFilter = {}): Promise<MissionDto[]> {
        const baseWhere: FindOptionsWhere<Mission> = {
            userId,
            ...(filter.status ? { status: filter.status } : {}),
        };
        const search = filter.search?.trim();
        const where: FindOptionsWhere<Mission> | FindOptionsWhere<Mission>[] = search
            ? [
                  { ...baseWhere, title: ILike(`%${search}%`) },
                  { ...baseWhere, description: ILike(`%${search}%`) },
              ]
            : baseWhere;
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
    async getForUser(userId: string, missionId: string): Promise<MissionDto> {
        const row = await this.findOrThrow(userId, missionId);
        return toMissionDto(row);
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
    async create(userId: string, input: CreateMissionInput): Promise<MissionDto> {
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
        const saved = await this.missions.save(
            this.missions.create({
                userId,
                title,
                description,
                type: input.type,
                status: MissionStatus.ACTIVE,
                schedule: this.normalizeSchedule(input.type, input.schedule ?? null),
                autoBuildWorks: input.autoBuildWorks ?? false,
                outstandingIdeasCap: input.outstandingIdeasCap ?? null,
                guardrailsOverride: input.guardrailsOverride ?? null,
                // Security: validate/normalize before persisting (SSRF defense-in-depth).
                missionTemplateRepo: this.normalizeTemplateRepo(input.missionTemplateRepo),
                missionRepo: null, // Phase 8 PR X scaffolder sets this.
                sourceMissionId: null, // Mission Clone (PR HH) sets this.
            }),
        );
        await this.recordActivity(userId, ActivityActionType.MISSION_CREATED, 'create', {
            missionId: saved.id,
            title: saved.title,
        });
        return toMissionDto(saved);
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
    ): Promise<MissionDto> {
        const existing = await this.findOrThrow(userId, missionId);

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

        const saved = await this.missions.save(existing);
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
    async pause(userId: string, missionId: string): Promise<MissionDto> {
        const dto = await this.transition(
            userId,
            missionId,
            PAUSABLE_STATUSES,
            MissionStatus.PAUSED,
            'pause',
        );
        await this.recordActivity(userId, ActivityActionType.MISSION_PAUSED, 'pause', {
            missionId,
        });
        return dto;
    }

    async resume(userId: string, missionId: string): Promise<MissionDto> {
        const dto = await this.transition(
            userId,
            missionId,
            RESUMABLE_STATUSES,
            MissionStatus.ACTIVE,
            'resume',
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
    async delete(userId: string, missionId: string): Promise<{ deleted: true }> {
        const existing = await this.findOrThrow(userId, missionId);
        await this.missions.remove(existing);
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
        const mission = await this.findOrThrow(userId, missionId);
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
    async listAttachments(userId: string, missionId: string): Promise<MissionAttachment[]> {
        await this.findOrThrow(userId, missionId);
        if (!this.missionAttachments) return [];
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
    ): Promise<MissionAttachment> {
        await this.findOrThrow(userId, missionId);
        if (!uploadId || !SHA256_RE.test(uploadId)) {
            throw new BadRequestException(`Invalid uploadId`);
        }
        // Security: the uploadId must reference a real upload owned by the
        // caller (404 — don't leak existence). Closes the dangling/foreign
        // attachment edge the hunt found.
        if (this.uploadsRepo) {
            const owned = await this.uploadsRepo.findOne({
                where: { sha256: uploadId.toLowerCase(), userId },
            });
            if (!owned) throw new NotFoundException(`Upload ${uploadId} not found.`);
        }
        if (!this.missionAttachments) {
            throw new BadRequestException(
                `MissionAttachmentRepository is not wired — attach the MissionAttachment provider before calling addAttachment`,
            );
        }
        try {
            return await this.missionAttachments.add(missionId, uploadId);
        } catch (err) {
            // Duplicate (missionId, uploadId) — swallow and re-read.
            // Mirrors the idempotency contract on Task attachments.
            if (err instanceof Error && /duplicate key|unique constraint/i.test(err.message)) {
                const existing = (await this.missionAttachments.findByMissionId(missionId)).find(
                    (a) => a.uploadId === uploadId,
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
    ): Promise<{ deleted: true }> {
        await this.findOrThrow(userId, missionId);
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

    // ─── internals ──────────────────────────────────────────────────

    private async findOrThrow(userId: string, missionId: string): Promise<Mission> {
        const row = await this.missions.findOne({ where: { id: missionId, userId } });
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
    ): Promise<MissionDto> {
        const existing = await this.findOrThrow(userId, missionId);
        if (!allowedFrom.includes(existing.status)) {
            throw new BadRequestException(
                `Mission cannot be ${verb}d from status "${existing.status}". Allowed: ${allowedFrom.join(', ')}.`,
            );
        }
        existing.status = target;
        // PR-3: re-activating a failed Mission clears the conclusion
        // fields - a revived Mission has no verdict yet.
        if (target === MissionStatus.ACTIVE) {
            existing.outcome = null;
            existing.completedAt = null;
        }
        mutate?.(existing);
        const saved = await this.missions.save(existing);
        return toMissionDto(saved);
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
