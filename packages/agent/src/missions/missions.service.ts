import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
    Mission,
    MissionStatus,
    MissionType,
    type MissionGuardrailsOverride,
} from '../entities/mission.entity';
import { toMissionDto, type MissionDto } from './types';

/**
 * Input shape for `MissionsService.create`. Mirrors the writable
 * subset of `Mission` minus the FK fields the system owns
 * (`sourceMissionId` is set by Clone; `missionRepo` is set by
 * Phase 8 PR X's scaffolder). Validation lives at the DTO layer
 * (`CreateMissionDto` in apps/api).
 */
export interface CreateMissionInput {
    title: string;
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
const RESUMABLE_STATUSES: ReadonlyArray<MissionStatus> = [MissionStatus.PAUSED];
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
    async listForUser(userId: string): Promise<MissionDto[]> {
        const rows = await this.missions.find({
            where: { userId },
            order: { updatedAt: 'DESC' },
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
        const saved = await this.missions.save(
            this.missions.create({
                userId,
                title: input.title.trim().slice(0, 200),
                description: input.description.trim(),
                type: input.type,
                status: MissionStatus.ACTIVE,
                schedule: this.normalizeSchedule(input.type, input.schedule ?? null),
                autoBuildWorks: input.autoBuildWorks ?? false,
                outstandingIdeasCap: input.outstandingIdeasCap ?? null,
                guardrailsOverride: input.guardrailsOverride ?? null,
                missionTemplateRepo: input.missionTemplateRepo ?? null,
                missionRepo: null, // Phase 8 PR X scaffolder sets this.
                sourceMissionId: null, // Mission Clone (PR HH) sets this.
            }),
        );
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
            existing.missionTemplateRepo = input.missionTemplateRepo;

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
        return this.transition(userId, missionId, PAUSABLE_STATUSES, MissionStatus.PAUSED, 'pause');
    }

    async resume(userId: string, missionId: string): Promise<MissionDto> {
        return this.transition(
            userId,
            missionId,
            RESUMABLE_STATUSES,
            MissionStatus.ACTIVE,
            'resume',
        );
    }

    async complete(userId: string, missionId: string): Promise<MissionDto> {
        return this.transition(
            userId,
            missionId,
            COMPLETABLE_STATUSES,
            MissionStatus.COMPLETED,
            'complete',
        );
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
        return { deleted: true };
    }

    /**
     * Phase 3 PR H — manually trigger a Mission tick. PLACEHOLDER:
     * the actual Trigger.dev dispatch wiring lands in PR J. For
     * now we log + return a noop response so the endpoint is
     * callable end-to-end and the UI (Phase 6 PR R "Run now"
     * button) can wire to it without waiting for PR J.
     *
     * The state-machine gate is enforced even though there's no
     * tick: PR J's tick logic will trust callers to have validated
     * the Mission is runnable.
     */
    async runNow(
        userId: string,
        missionId: string,
    ): Promise<{ status: 'noop-placeholder' | 'queued'; missionId: string }> {
        const mission = await this.findOrThrow(userId, missionId);
        if (!RUNNABLE_STATUSES.includes(mission.status)) {
            throw new BadRequestException(
                `Mission cannot be run from status "${mission.status}". Allowed: ${RUNNABLE_STATUSES.join(', ')}.`,
            );
        }
        this.logger.log(
            `Mission ${missionId} run-now requested (placeholder — actual tick wiring lands in Phase 3 PR J)`,
        );
        return { status: 'noop-placeholder', missionId };
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
    ): Promise<MissionDto> {
        const existing = await this.findOrThrow(userId, missionId);
        if (!allowedFrom.includes(existing.status)) {
            throw new BadRequestException(
                `Mission cannot be ${verb}d from status "${existing.status}". Allowed: ${allowedFrom.join(', ')}.`,
            );
        }
        existing.status = target;
        const saved = await this.missions.save(existing);
        return toMissionDto(saved);
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

    private normalizeSchedule(type: MissionType, schedule: string | null): string | null {
        if (type === MissionType.ONE_SHOT) return null;
        if (typeof schedule === 'string') {
            const trimmed = schedule.trim();
            return trimmed.length > 0 ? trimmed : null;
        }
        return schedule;
    }
}
