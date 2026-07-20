import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository, type FindOptionsWhere } from 'typeorm';
import {
    Goal,
    GoalStatus,
    type GoalComparator,
    type GoalMetricSource,
    type GoalOutcome,
    type GoalWindow,
} from '../entities/goal.entity';
import { GoalMetricSample } from '../entities/goal-metric-sample.entity';
import { MissionGoal } from '../entities/mission-goal.entity';
import { Mission } from '../entities/mission.entity';
import { GoalEvaluationService } from './goal-evaluation.service';
import {
    DEFAULT_CHECK_FREQUENCY_MINUTES,
    MIN_CHECK_FREQUENCY_MINUTES,
    toGoalDto,
    toGoalMetricSampleDto,
    toMissionGoalLinkDto,
    type CreateGoalInput,
    type GoalDto,
    type GoalEvaluationEntry,
    type GoalMetricSampleDto,
    type ListGoalsFilter,
    type MissionGoalLinkDto,
    type UpdateGoalInput,
} from './types';

const GOAL_COMPARATORS: ReadonlyArray<GoalComparator> = ['gte', 'lte'];
const GOAL_WINDOWS: ReadonlyArray<GoalWindow> = ['day', 'week', 'month', 'total', 'point'];
const GOAL_OUTCOMES: ReadonlyArray<GoalOutcome> = [
    'achieved',
    'missed',
    'abandoned',
] as GoalOutcome[];

/**
 * Goal lifecycle state-machine (mirrors the MissionsService idiom):
 *
 *   activate: DRAFT | PAUSED | COMPLETED → ACTIVE
 *             (COMPLETED → ACTIVE clears `outcome` — spec FR-13's
 *             "auto-set outcomes are human-overridable" includes
 *             re-opening a completed Goal)
 *   pause:    ACTIVE → PAUSED
 *   COMPLETED is written by evaluation (achieved/missed) or by a
 *   PATCH that sets a non-null `outcome` (human override).
 */
const ACTIVATABLE_STATUSES: ReadonlyArray<GoalStatus> = [
    GoalStatus.DRAFT,
    GoalStatus.PAUSED,
    GoalStatus.COMPLETED,
];
const PAUSABLE_STATUSES: ReadonlyArray<GoalStatus> = [GoalStatus.ACTIVE];

/** Serialized-size cap for `metricSource` (DoS guard on simple-json). */
const MAX_METRIC_SOURCE_JSON_CHARS = 4000;

/**
 * Goals & Metrics — PR-8 (spec FR-9..FR-14).
 *
 * CRUD + lifecycle for user-owned Goals, plus the Mission ↔ Goal
 * link surface (`mission_goals`). All reads are userId-scoped with
 * 404-no-leak semantics (same response whether the row is missing or
 * foreign — the MissionsService idiom).
 *
 * Evaluation itself lives in {@link GoalEvaluationService}; this
 * service only delegates for `evaluateNow`.
 */
@Injectable()
export class GoalsService {
    private readonly logger = new Logger(GoalsService.name);

    constructor(
        @InjectRepository(Goal)
        private readonly goals: Repository<Goal>,
        @InjectRepository(GoalMetricSample)
        private readonly samples: Repository<GoalMetricSample>,
        @InjectRepository(MissionGoal)
        private readonly missionGoals: Repository<MissionGoal>,
        // Mission ownership checks for the link surface. Injected as a
        // plain repository (not MissionsService) to keep the modules
        // decoupled — linking only needs an ownership probe.
        @InjectRepository(Mission)
        private readonly missions: Repository<Mission>,
        private readonly evaluationService: GoalEvaluationService,
    ) {}

    // ─── CRUD ───────────────────────────────────────────────────────

    async listForUser(userId: string, filter: ListGoalsFilter = {}): Promise<GoalDto[]> {
        const where: FindOptionsWhere<Goal> = {
            userId,
            ...(filter.status ? { status: filter.status } : {}),
        };
        const rows = await this.goals.find({
            where,
            order: { updatedAt: 'DESC' },
            take: filter.limit,
            skip: filter.offset,
        });
        return rows.map(toGoalDto);
    }

    async getForUser(userId: string, goalId: string): Promise<GoalDto> {
        return toGoalDto(await this.findOrThrow(userId, goalId));
    }

    /**
     * Append-only observation history (progress sparkline / audit).
     * Newest-first; `limit` defaults to 100.
     */
    async listSamples(userId: string, goalId: string, limit = 100): Promise<GoalMetricSampleDto[]> {
        await this.findOrThrow(userId, goalId);
        const rows = await this.samples.find({
            where: { goalId },
            order: { sampledAt: 'DESC' },
            take: Math.min(500, Math.max(1, limit)),
        });
        return rows.map(toGoalMetricSampleDto);
    }

    async create(userId: string, input: CreateGoalInput): Promise<GoalDto> {
        const metricSource = this.validateMetricSource(input.metricSource, {
            requireProvider: false,
        });
        this.assertComparator(input.comparator);
        this.assertWindow(input.window);
        this.assertFiniteNumber(input.targetValue, 'targetValue');

        const saved = await this.goals.save(
            this.goals.create({
                userId,
                title: input.title.trim().slice(0, 200),
                description: input.description?.trim() || null,
                metricSource,
                comparator: input.comparator,
                targetValue: input.targetValue,
                unit: input.unit.trim().slice(0, 32),
                window: input.window,
                baselineValue: input.baselineValue ?? null,
                deadline: input.deadline ?? null,
                checkFrequencyMinutes: this.clampFrequency(input.checkFrequencyMinutes),
                nextCheckAt: null,
                status: GoalStatus.DRAFT,
                outcome: null,
            }),
        );
        return toGoalDto(saved);
    }

    /**
     * Partial update. Undefined leaves the field alone; `null` clears
     * nullable fields. Status is NOT directly writable — use
     * activate/pause — with ONE exception per spec FR-13: writing a
     * non-null `outcome` (human override) completes the Goal, and
     * writing `outcome: null` clears an auto-set outcome without
     * changing status (re-open via activate).
     */
    async update(userId: string, goalId: string, input: UpdateGoalInput): Promise<GoalDto> {
        const existing = await this.findOrThrow(userId, goalId);

        if (input.title !== undefined) existing.title = input.title.trim().slice(0, 200);
        if (input.description !== undefined) {
            existing.description = input.description?.trim() || null;
        }
        if (input.metricSource !== undefined) {
            existing.metricSource = this.validateMetricSource(input.metricSource, {
                // An ACTIVE goal must keep an evaluable source.
                requireProvider: existing.status === GoalStatus.ACTIVE,
            });
        }
        if (input.comparator !== undefined) {
            this.assertComparator(input.comparator);
            existing.comparator = input.comparator;
        }
        if (input.window !== undefined) {
            this.assertWindow(input.window);
            existing.window = input.window;
        }
        if (input.targetValue !== undefined) {
            this.assertFiniteNumber(input.targetValue, 'targetValue');
            existing.targetValue = input.targetValue;
        }
        if (input.unit !== undefined) existing.unit = input.unit.trim().slice(0, 32);
        if (input.baselineValue !== undefined) {
            if (input.baselineValue !== null) {
                this.assertFiniteNumber(input.baselineValue, 'baselineValue');
            }
            existing.baselineValue = input.baselineValue;
        }
        if (input.deadline !== undefined) existing.deadline = input.deadline;
        if (input.checkFrequencyMinutes !== undefined) {
            existing.checkFrequencyMinutes = this.clampFrequency(input.checkFrequencyMinutes);
        }
        if (input.outcome !== undefined) {
            if (input.outcome !== null && !GOAL_OUTCOMES.includes(input.outcome)) {
                throw new BadRequestException(
                    `Invalid outcome "${input.outcome}". Allowed: ${GOAL_OUTCOMES.join(', ')} or null.`,
                );
            }
            existing.outcome = input.outcome;
            if (input.outcome !== null && existing.status !== GoalStatus.COMPLETED) {
                // Human override completes the Goal (FR-13) — and, per
                // invariant I-4, touches NOTHING on any linked Mission.
                existing.status = GoalStatus.COMPLETED;
                existing.nextCheckAt = null;
            }
        }

        return toGoalDto(await this.goals.save(existing));
    }

    async delete(userId: string, goalId: string): Promise<{ deleted: true }> {
        const existing = await this.findOrThrow(userId, goalId);
        // DB-level cascades remove samples + mission_goals edges.
        await this.goals.remove(existing);
        return { deleted: true };
    }

    // ─── lifecycle ──────────────────────────────────────────────────

    /**
     * DRAFT | PAUSED | COMPLETED → ACTIVE. Requires an evaluable
     * `metricSource` (explicit pluginId + metricId — spec FR-3:
     * multiple providers may be enabled, so a Goal always names its
     * provider). Re-activating a COMPLETED Goal clears its outcome.
     * `nextCheckAt` is set to "now" so the next dispatcher tick
     * evaluates immediately.
     */
    async activate(userId: string, goalId: string): Promise<GoalDto> {
        const existing = await this.findOrThrow(userId, goalId);
        if (!ACTIVATABLE_STATUSES.includes(existing.status)) {
            throw new BadRequestException(
                `Goal cannot be activated from status "${existing.status}". Allowed: ${ACTIVATABLE_STATUSES.join(', ')}.`,
            );
        }
        this.validateMetricSource(existing.metricSource, { requireProvider: true });
        existing.status = GoalStatus.ACTIVE;
        existing.outcome = null;
        existing.nextCheckAt = new Date();
        return toGoalDto(await this.goals.save(existing));
    }

    /** ACTIVE → PAUSED; clears `nextCheckAt` so the dispatcher skips it. */
    async pause(userId: string, goalId: string): Promise<GoalDto> {
        const existing = await this.findOrThrow(userId, goalId);
        if (!PAUSABLE_STATUSES.includes(existing.status)) {
            throw new BadRequestException(
                `Goal cannot be paused from status "${existing.status}". Allowed: ${PAUSABLE_STATUSES.join(', ')}.`,
            );
        }
        existing.status = GoalStatus.PAUSED;
        existing.nextCheckAt = null;
        return toGoalDto(await this.goals.save(existing));
    }

    /**
     * Manual tick (`POST /me/goals/:id/evaluate-now`). Bypasses the
     * `nextCheckAt` schedule but NOT the budget guard — the metric
     * read goes through the same `MetricsFacadeService.getMetricValue`
     * path as a scheduled evaluation. Only ACTIVE Goals can be
     * evaluated (activation is what validates the metric source).
     */
    async evaluateNow(
        userId: string,
        goalId: string,
    ): Promise<{ entry: GoalEvaluationEntry; goal: GoalDto }> {
        const existing = await this.findOrThrow(userId, goalId);
        if (existing.status !== GoalStatus.ACTIVE) {
            throw new BadRequestException(
                `Goal must be active to evaluate now (status is "${existing.status}").`,
            );
        }
        const entry = await this.evaluationService.evaluateOne(existing);
        const fresh = await this.findOrThrow(userId, goalId);
        return { entry, goal: toGoalDto(fresh) };
    }

    // ─── Mission ↔ Goal links ───────────────────────────────────────

    async listForMission(userId: string, missionId: string): Promise<MissionGoalLinkDto[]> {
        await this.findMissionOrThrow(userId, missionId);
        const links = await this.missionGoals.find({
            where: { missionId },
            order: { createdAt: 'ASC' },
        });
        if (links.length === 0) return [];
        const goalRows = await this.goals.find({
            where: { id: In(links.map((l) => l.goalId)) },
        });
        const byId = new Map(goalRows.map((g) => [g.id, g]));
        return links.map((link) => toMissionGoalLinkDto(link, byId.get(link.goalId) ?? null));
    }

    /**
     * Attach a Goal to a Mission (idempotent on the unique
     * `(missionId, goalId)` pair — re-linking updates `isPrimary`
     * only). Ownership of BOTH sides is validated (404-no-leak).
     *
     * One-primary-per-Mission (spec FR-11): when `isPrimary` is true,
     * every other primary edge on the Mission is demoted in the same
     * call. This service-level enforcement is the only one on SQLite;
     * Postgres additionally has the partial unique index
     * `uq_mission_goals_primary` (migration 1782100000000).
     */
    async linkToMission(
        userId: string,
        missionId: string,
        goalId: string,
        isPrimary = false,
    ): Promise<MissionGoalLinkDto> {
        await this.findMissionOrThrow(userId, missionId);
        const goal = await this.findOrThrow(userId, goalId);

        if (isPrimary) {
            // Demote-before-promote so the Postgres partial unique
            // index never sees two primaries.
            await this.missionGoals.update({ missionId, isPrimary: true }, { isPrimary: false });
        }

        let link = await this.missionGoals.findOne({ where: { missionId, goalId } });
        if (link) {
            if (link.isPrimary !== isPrimary) {
                link.isPrimary = isPrimary;
                link = await this.missionGoals.save(link);
            }
            return toMissionGoalLinkDto(link, goal);
        }

        try {
            link = await this.missionGoals.save(
                this.missionGoals.create({ missionId, goalId, userId, isPrimary }),
            );
        } catch (err) {
            // Duplicate (missionId, goalId) race — re-read and apply
            // the isPrimary intent (mirrors the MissionAttachment
            // idempotency contract).
            if (err instanceof Error && /duplicate key|unique constraint/i.test(err.message)) {
                const existing = await this.missionGoals.findOne({ where: { missionId, goalId } });
                if (existing) {
                    if (existing.isPrimary !== isPrimary) {
                        existing.isPrimary = isPrimary;
                        return toMissionGoalLinkDto(await this.missionGoals.save(existing), goal);
                    }
                    return toMissionGoalLinkDto(existing, goal);
                }
            }
            throw err;
        }
        return toMissionGoalLinkDto(link, goal);
    }

    /**
     * Detach a Goal from a Mission. Deletes the edge only — the Goal
     * itself (and its samples) is untouched.
     */
    async unlinkFromMission(
        userId: string,
        missionId: string,
        goalId: string,
    ): Promise<{ deleted: true }> {
        await this.findMissionOrThrow(userId, missionId);
        const link = await this.missionGoals.findOne({ where: { missionId, goalId } });
        if (!link) {
            throw new NotFoundException(`Goal link not found`);
        }
        await this.missionGoals.remove(link);
        return { deleted: true };
    }

    // ─── internals ──────────────────────────────────────────────────

    private async findOrThrow(userId: string, goalId: string): Promise<Goal> {
        const row = await this.goals.findOne({ where: { id: goalId, userId } });
        if (!row) {
            throw new NotFoundException(`Goal not found`);
        }
        return row;
    }

    private async findMissionOrThrow(userId: string, missionId: string): Promise<Mission> {
        const row = await this.missions.findOne({ where: { id: missionId, userId } });
        if (!row) {
            throw new NotFoundException(`Mission not found`);
        }
        return row;
    }

    /** Spec FR-12 — clamp to ≥ 15 minutes; default 60. */
    private clampFrequency(minutes: number | undefined): number {
        if (minutes === undefined || minutes === null) return DEFAULT_CHECK_FREQUENCY_MINUTES;
        if (!Number.isInteger(minutes)) {
            throw new BadRequestException('checkFrequencyMinutes must be an integer.');
        }
        return Math.max(MIN_CHECK_FREQUENCY_MINUTES, minutes);
    }

    /**
     * Validate + normalize the metric source. `requireProvider`
     * hardens the activation path: a DRAFT goal may be sketched with
     * placeholder ids, but activation (and any edit while ACTIVE)
     * demands a concrete pluginId + metricId.
     */
    private validateMetricSource(
        value: unknown,
        { requireProvider }: { requireProvider: boolean },
    ): GoalMetricSource {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
            throw new BadRequestException('metricSource must be an object.');
        }
        const source = value as Record<string, unknown>;
        const pluginId = typeof source.pluginId === 'string' ? source.pluginId.trim() : '';
        const metricId = typeof source.metricId === 'string' ? source.metricId.trim() : '';
        if (!pluginId || !metricId) {
            throw new BadRequestException(
                'metricSource requires non-empty `pluginId` and `metricId` strings.',
            );
        }
        if (pluginId.length > 100 || metricId.length > 200) {
            throw new BadRequestException('metricSource pluginId/metricId too long.');
        }
        let params: Record<string, unknown> | undefined;
        if (source.params !== undefined && source.params !== null) {
            if (
                typeof source.params !== 'object' ||
                Array.isArray(source.params) ||
                source.params === null
            ) {
                throw new BadRequestException('metricSource.params must be an object.');
            }
            params = source.params as Record<string, unknown>;
        }
        const normalized: GoalMetricSource = { pluginId, metricId };
        if (params) {
            normalized.params = params;
        }
        // DoS guard: simple-json is a text column — cap serialized size.
        if (JSON.stringify(normalized).length > MAX_METRIC_SOURCE_JSON_CHARS) {
            throw new BadRequestException('metricSource is too large.');
        }
        // `requireProvider` currently adds no extra checks beyond the
        // non-empty ids above, but is kept explicit so activation-time
        // policy (e.g. "pluginId must be an enabled metrics provider")
        // can tighten here without touching call sites.
        void requireProvider;
        return normalized;
    }

    private assertComparator(value: GoalComparator): void {
        if (!GOAL_COMPARATORS.includes(value)) {
            throw new BadRequestException(
                `Invalid comparator "${value}". Allowed: ${GOAL_COMPARATORS.join(', ')}.`,
            );
        }
    }

    private assertWindow(value: GoalWindow): void {
        if (!GOAL_WINDOWS.includes(value)) {
            throw new BadRequestException(
                `Invalid window "${value}". Allowed: ${GOAL_WINDOWS.join(', ')}.`,
            );
        }
    }

    private assertFiniteNumber(value: number, field: string): void {
        if (typeof value !== 'number' || !Number.isFinite(value)) {
            throw new BadRequestException(`${field} must be a finite number.`);
        }
    }
}
