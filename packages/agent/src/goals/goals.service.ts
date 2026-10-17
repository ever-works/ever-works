import {
    BadRequestException,
    Injectable,
    Logger,
    NotFoundException,
    Optional,
    UnprocessableEntityException,
} from '@nestjs/common';
import { RecordAccessPolicy } from '../record-visibility/record-access-policy.service';
import { RecordVisibilityService } from '../record-visibility/record-visibility.service';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Not, Repository, type EntityManager, type FindOptionsWhere } from 'typeorm';
import {
    DomainEventPublisher,
    recordAfterWrite,
} from '../domain-events/domain-event-publisher.service';
import { withoutAggregateVersion } from '../domain-events/domain-event-context';
import {
    isExternalMetricSource,
    recordGoalProgress,
    rescoreFromExternalValues,
} from './goal-domain-events';
import { DEFAULT_GOAL_KIND, GOAL_KINDS, isGoalKind, type GoalKind } from '@ever-works/contracts';
import {
    Goal,
    GoalStatus,
    type GoalComparator,
    type GoalDoDCriterion,
    type GoalMetricSource,
    type GoalOutcome,
    type GoalWindow,
} from '../entities/goal.entity';
import { GoalMetricSample } from '../entities/goal-metric-sample.entity';
import { MissionGoal } from '../entities/mission-goal.entity';
import { Mission } from '../entities/mission.entity';
import { GoalEvaluationService } from './goal-evaluation.service';
import { validateGoalJudgment } from './goal-criteria';
import { hasDefinitionOfDone, normalizeDoDCriteria, validateDoDCriteria } from './goal-dod';
import { isDeliveryGoal, metricOnlyFieldsPresent, validateGoalKindInput } from './goal-kind';
import {
    ownershipStamp,
    ownershipWhere,
    ownershipWhereWith,
    type OwnershipScope,
} from '../database/ownership-scope';
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
/**
 * Runs inside a Goal create's transaction, after the row and its `goal.created` event (T17a
 * pattern): the integration API links the new Goal to its `externalRef` there. A throw rolls
 * the create back.
 */
export type GoalWithinCreate = (
    goal: { readonly id: string },
    manager: EntityManager,
) => Promise<void>;

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
        // Record visibility (EW-P1-3) — the shared / org tabs and the readable get.
        // Appended LAST + @Optional(): absent means reads stay owner-only.
        @Optional() private readonly accessPolicy?: RecordAccessPolicy,
        // EW-P2-2 — `goal.*` domain events: every write and its event commit together.
        // TRAILING + @Optional(): a graph without DomainEventsModule records nothing.
        @Optional() private readonly domainEvents?: DomainEventPublisher,
        // EW-P2-2 — integration-created Goals' Teams + D11 (`createExternal`).
        @Optional() private readonly recordVisibility?: RecordVisibilityService,
    ) {}

    // ─── CRUD ───────────────────────────────────────────────────────

    async listForUser(
        userId: string,
        filter: ListGoalsFilter = {},
        scope?: OwnershipScope,
    ): Promise<GoalDto[]> {
        const view = filter.view ?? 'mine';
        if (view !== 'mine' && this.accessPolicy) {
            const { rows } = await this.accessPolicy.listVisible<Goal>({
                aggregate: 'goal',
                userId,
                scope,
                view,
                take: filter.limit,
                skip: filter.offset,
                refine: (qb, alias) => {
                    if (filter.status) {
                        qb.andWhere(`${alias}.status = :goalStatus`, { goalStatus: filter.status });
                    }
                    if (filter.archived === true) qb.andWhere(`${alias}.archivedAt IS NOT NULL`);
                    else if (filter.archived !== 'all') qb.andWhere(`${alias}.archivedAt IS NULL`);
                },
            });
            return rows.map(toGoalDto);
        }
        const whereBranches: FindOptionsWhere<Goal>[] = (
            scope ? ownershipWhere<Goal>(userId, scope) : [{ userId }]
        ).map((branch) => ({
            ...branch,
            ...(filter.status ? { status: filter.status } : {}),
            // Archive is a VIEW, not a deletion: the default catalog hides
            // archived Goals, `archived: true` shows only those, and
            // `'all'` drops the predicate entirely. Every pre-existing row
            // has a NULL `archivedAt`, so the default filter matches all of
            // them and the catalog is unchanged for anyone who never
            // archives anything.
            ...this.archivedPredicate(filter.archived),
        }));
        const where: FindOptionsWhere<Goal> | FindOptionsWhere<Goal>[] = scope
            ? whereBranches
            : whereBranches[0];
        const rows = await this.goals.find({
            where,
            order: { updatedAt: 'DESC' },
            take: filter.limit,
            skip: filter.offset,
        });
        return rows.map(toGoalDto);
    }

    async getForUser(userId: string, goalId: string, scope?: OwnershipScope): Promise<GoalDto> {
        return toGoalDto(await this.findOrThrow(userId, goalId, scope));
    }

    /**
     * Record visibility (EW-P1-3) — the READ of one Goal: the owner exactly as
     * {@link getForUser}, or anyone `visibleTo(principal)` admits in the active
     * Organization. Only `GET /api/me/goals/:id` uses it; every other route keeps
     * {@link getForUser} / `findOrThrow` as its owner gate, so no write is widened.
     */
    async getReadable(userId: string, goalId: string, scope?: OwnershipScope): Promise<GoalDto> {
        try {
            return await this.getForUser(userId, goalId, scope);
        } catch (error) {
            if (!(error instanceof NotFoundException) || !this.accessPolicy) throw error;
            const shared = await this.accessPolicy.findVisibleNotOwned<Goal>({
                aggregate: 'goal',
                userId,
                id: goalId,
                scope,
            });
            if (!shared) throw error;
            return toGoalDto(shared);
        }
    }

    /**
     * Append-only observation history (progress sparkline / audit).
     * Newest-first; `limit` defaults to 100.
     */
    async listSamples(
        userId: string,
        goalId: string,
        limit = 100,
        scope?: OwnershipScope,
    ): Promise<GoalMetricSampleDto[]> {
        await this.findOrThrow(userId, goalId, scope);
        const rows = await this.samples.find({
            where: { goalId },
            order: { sampledAt: 'DESC' },
            take: Math.min(500, Math.max(1, limit)),
        });
        return rows.map(toGoalMetricSampleDto);
    }

    /**
     * Create a Goal of either kind (self-build slice AG, EW-795).
     *
     * The kind decides the shape, and the check is FAIL-CLOSED both ways:
     * a metric Goal (the default — every caller that never heard of kinds)
     * still needs all four metric fields and is validated by exactly the
     * per-field assertions it always was; a delivery Goal must carry none
     * of them and at least one approved Definition-of-Done criterion; an
     * unknown kind is refused. `validateGoalKindInput` then re-checks the
     * chosen shape as one rule shared with the specs.
     */
    async create(
        userId: string,
        input: CreateGoalInput,
        scope?: OwnershipScope,
        options: { automaticVisibility?: boolean; withinCreate?: GoalWithinCreate } = {},
    ): Promise<GoalDto> {
        const goalKind = this.resolveWriteKind(input.goalKind);
        if (options.withinCreate && !this.domainEvents) {
            throw new Error('Goal withinCreate needs DomainEventsModule (one transaction)');
        }

        let metricSource: GoalMetricSource | null = null;
        if (goalKind === 'metric') {
            // The legacy per-field assertions run FIRST and unchanged — their
            // exact messages are pinned by the e2e validation matrix.
            metricSource = this.validateMetricSource(input.metricSource, {
                requireProvider: false,
            });
            this.assertComparator(input.comparator);
            this.assertWindow(input.window);
            this.assertFiniteNumber(input.targetValue, 'targetValue');
            this.assertUnit(input.unit);
            this.assertJudgment({ criteria: input.criteria, constraints: input.constraints });
        }
        this.assertGoalKindShape({ ...input, goalKind });
        const dodCriteria = this.normalizeDodInput(input.dodCriteria);

        const saved = await this.persist(
            this.goals.create({
                userId,
                ...ownershipStamp(scope),
                title: input.title.trim().slice(0, 200),
                description: input.description?.trim() || null,
                goalKind,
                ...(goalKind === 'metric'
                    ? {
                          metricSource,
                          comparator: input.comparator,
                          targetValue: input.targetValue,
                          unit: (input.unit as string).trim().slice(0, 32),
                          window: input.window as GoalWindow,
                          baselineValue: input.baselineValue ?? null,
                          // Judgment layer G1 - additive. Omitted stays NULL,
                          // which IS the single-metric Goal this service
                          // already created.
                          criteria: input.criteria ?? null,
                          constraints: input.constraints ?? null,
                      }
                    : {
                          // A delivery Goal carries no metric at all. `window`
                          // stays NOT NULL at the column level and is never
                          // read for this kind.
                          metricSource: null,
                          comparator: null,
                          targetValue: null,
                          unit: null,
                          window: 'total' as GoalWindow,
                          baselineValue: null,
                          criteria: null,
                          constraints: null,
                      }),
                deadline: input.deadline ?? null,
                checkFrequencyMinutes: this.clampFrequency(input.checkFrequencyMinutes),
                nextCheckAt: null,
                status: GoalStatus.DRAFT,
                outcome: null,
                dodCriteria,
                ...(input.createdBy
                    ? { createdByType: input.createdBy.type, createdById: input.createdBy.id }
                    : {}),
                ...(input.visibility
                    ? { visibility: input.visibility, visibilityExplicit: true }
                    : {}),
            }),
            async (publisher, manager, row) => {
                const hasTeams = !!input.teamIds && input.teamIds.length > 0;
                // An integration create always derives its scope (D11): without Teams or a
                // hand-set visibility an Organization's Goal is `organization`, never the
                // column default `private` (which no integration could then read back).
                if (hasTeams || options.automaticVisibility) {
                    if (!this.recordVisibility) {
                        throw new Error('Goal teamIds need RecordVisibilityModule');
                    }
                    if (hasTeams) {
                        await this.recordVisibility.setTeamsIn(
                            manager,
                            'goal',
                            row.id,
                            input.teamIds as string[],
                            userId,
                        );
                    }
                    await this.recordVisibility.recomputeAutomaticIn(manager, 'goal', row.id, {
                        recordEvent: false,
                    });
                }
                await publisher.created(manager, 'goal', row.id, 'goal.created');
                // T17a pattern — e.g. the integration API's externalRef link, in this
                // transaction: a throw rolls the Goal back.
                if (options.withinCreate) await options.withinCreate({ id: row.id }, manager);
            },
        );
        return toGoalDto(saved);
    }

    /**
     * EW-P2-2 — create a Goal for an integration (contract v1 B.6 `POST /goals`).
     * Always `draft` (D9: activation stays a person's action in Ever Works). A metric
     * Goal must read the EXTERNAL source (`pluginId: 'external'`) — its own and every
     * criterion's: a provider read can be metered spend, and an integration pushes its
     * values through {@link recordExternalSample} instead. `teamIds` become
     * `team_resources` rows of the Organization and decide the scope (D11) unless
     * `visibility` is set by hand. The row, its Teams and `goal.created` commit together,
     * and so does `withinCreate` (T17a pattern: the integration API's `externalRef` link,
     * so a throw there undoes the create).
     */
    async createExternal(
        userId: string,
        input: CreateGoalInput,
        scope: OwnershipScope,
        options: { withinCreate?: GoalWithinCreate } = {},
    ): Promise<GoalDto> {
        GoalsService.assertExternalSources(input);
        if (input.visibility !== undefined) {
            RecordVisibilityService.assertIntegrationVisibility(input.visibility);
        }
        if (!scope.organizationId) {
            throw new BadRequestException('An integration Goal is created in an Organization.');
        }
        return this.create(
            userId,
            {
                ...input,
                teamIds: input.teamIds ? [...new Set(input.teamIds)] : undefined,
            },
            scope,
            { automaticVisibility: true, withinCreate: options.withinCreate },
        );
    }

    /**
     * EW-P2-2 — an integration may only name the external metric source (the Goal's
     * and each criterion's; a criterion without one inherits the Goal's). `422
     * domain_rule` otherwise.
     */
    static assertExternalSources(input: {
        metricSource?: GoalMetricSource | null;
        criteria?: ReadonlyArray<{ metricSource?: GoalMetricSource }> | null;
        constraints?: ReadonlyArray<{ metricSource?: GoalMetricSource }> | null;
    }): void {
        const offending: string[] = [];
        if (input.metricSource && !isExternalMetricSource(input.metricSource)) {
            offending.push('metricSource');
        }
        (input.criteria ?? []).forEach((criterion, index) => {
            if (criterion.metricSource && !isExternalMetricSource(criterion.metricSource)) {
                offending.push(`criteria[${index}].metricSource`);
            }
        });
        (input.constraints ?? []).forEach((constraint, index) => {
            if (constraint.metricSource && !isExternalMetricSource(constraint.metricSource)) {
                offending.push(`constraints[${index}].metricSource`);
            }
        });
        if (offending.length > 0) {
            throw new UnprocessableEntityException(
                `An integration can only use the external metric source (pluginId "external"): ${offending.join(', ')}.`,
            );
        }
    }

    /**
     * EW-P2-2 — one externally measured value (`POST /api/integrations/v1/goals/:id/samples`).
     *
     * The Goal (or, with `criterionId`, that criterion) must read the external
     * source. The sample row is appended; a Goal-level sample at or after the current
     * observation becomes `currentValue` (and the baseline when there is none yet); a
     * Goal with criteria is re-scored from the latest pushed values. Records
     * `goal.progress_changed` (at most one per Goal per 5 minutes; the version still
     * moves). It never activates, completes or schedules anything: the outcome rules
     * run on an ACTIVE Goal's evaluation (D9).
     */
    async recordExternalSample(
        userId: string,
        goalId: string,
        input: { criterionId?: string | null; value: number; sampledAt: Date },
        scope?: OwnershipScope,
    ): Promise<GoalDto> {
        const goal = await this.findOrThrow(userId, goalId, scope);
        if (isDeliveryGoal(goal)) {
            throw new UnprocessableEntityException(
                'A delivery Goal has no metric: track its Definition of Done instead.',
            );
        }
        this.assertFiniteNumber(input.value, 'value');
        if (!(input.sampledAt instanceof Date) || Number.isNaN(input.sampledAt.getTime())) {
            throw new BadRequestException('sampledAt must be a date-time.');
        }
        if (input.sampledAt.getTime() > Date.now() + 5 * 60_000) {
            throw new BadRequestException('sampledAt cannot be in the future.');
        }
        const criterionId = input.criterionId?.trim() || null;
        if (criterionId) {
            const criterion = (goal.criteria ?? []).find((entry) => entry.id === criterionId);
            if (!criterion) throw new NotFoundException(`Goal criterion ${criterionId} not found`);
            if (!isExternalMetricSource(criterion.metricSource ?? goal.metricSource)) {
                throw new UnprocessableEntityException(
                    `Criterion ${criterionId} reads a provider, not the external source.`,
                );
            }
        } else if (!isExternalMetricSource(goal.metricSource)) {
            throw new UnprocessableEntityException(
                'This Goal reads a provider, not the external source: it takes no samples.',
            );
        }

        const apply = async (manager: EntityManager) => {
            // Re-read the Goal in the write's transaction (row-locked where the driver has
            // row locks; SQLite already serializes writers), so two samples racing on one
            // Goal never apply their observation / score to a stale copy.
            const current = await this.reloadForUpdate(manager, goal);
            await manager.getRepository(GoalMetricSample).insert({
                goalId,
                criterionId,
                sampledAt: input.sampledAt,
                value: input.value,
            });
            const before = {
                currentValue: current.currentValue ?? null,
                score: current.resolvedScore,
            };
            const changedFields: string[] = [];
            if (
                !criterionId &&
                (!current.currentValueAt ||
                    input.sampledAt.getTime() >= current.currentValueAt.getTime())
            ) {
                current.currentValue = input.value;
                current.currentValueAt = input.sampledAt;
                changedFields.push('currentValue', 'currentValueAt');
                if (current.baselineValue === null || current.baselineValue === undefined) {
                    current.baselineValue = input.value;
                    changedFields.push('baselineValue');
                }
            }
            if (Array.isArray(current.criteria) && current.criteria.length > 0) {
                current.resolvedScore = await rescoreFromExternalValues(manager, current);
                changedFields.push('resolvedScore');
            }
            changedFields.push('progress');
            const saved = await manager.getRepository(Goal).save(withoutAggregateVersion(current));
            return { saved, before, changedFields };
        };

        const publisher = this.domainEvents;
        if (!publisher) {
            const { saved } = await this.goals.manager.transaction(apply);
            return toGoalDto(saved);
        }
        const saved = await publisher.transaction(async (manager) => {
            const result = await apply(manager);
            await recordGoalProgress(publisher, manager, goalId, {
                changedFields: result.changedFields,
                previous: {
                    currentValue: result.before.currentValue,
                    ...(result.changedFields.includes('resolvedScore')
                        ? { score: result.before.score?.score ?? null }
                        : {}),
                },
            });
            return result.saved;
        });
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
    async update(
        userId: string,
        goalId: string,
        input: UpdateGoalInput,
        scope?: OwnershipScope,
    ): Promise<GoalDto> {
        const existing = await this.findOrThrow(userId, goalId, scope);

        if (isDeliveryGoal(existing)) {
            // The kind is immutable and a delivery Goal has no metric: any
            // attempt to give it one (even `null`, which is a "clear" write
            // on a metric Goal) is a client error, not a no-op.
            const offending = metricOnlyFieldsPresent(input, { treatNullAsPresent: true });
            if (offending.length > 0) {
                throw new BadRequestException(
                    `Delivery Goals carry no metric target; ${offending.join(', ')} cannot be set.`,
                );
            }
        }

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
        if (input.criteria !== undefined || input.constraints !== undefined) {
            // Validate the SUBMITTED shape only: an untouched column is
            // already-valid data and must not be re-litigated by a
            // stricter later rule.
            this.assertJudgment({
                ...(input.criteria !== undefined ? { criteria: input.criteria } : {}),
                ...(input.constraints !== undefined ? { constraints: input.constraints } : {}),
            });
            if (input.criteria !== undefined) {
                existing.criteria = input.criteria;
                // Clearing the weighted path invalidates the score that
                // path produced - leaving a stale 0.42 on a now
                // single-metric Goal would be a lie on the UI.
                if (input.criteria === null || input.criteria.length === 0) {
                    existing.resolvedScore = null;
                }
            }
            if (input.constraints !== undefined) existing.constraints = input.constraints;
        }
        const statusBefore = existing.status;
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

        const changedFields = Object.keys(input).filter(
            (key) => (input as Record<string, unknown>)[key] !== undefined,
        );
        const statusChanged = existing.status !== statusBefore;
        return toGoalDto(
            await this.persist(existing, (publisher, manager, row) =>
                publisher.changed(
                    manager,
                    'goal',
                    row.id,
                    statusChanged ? 'goal.status_changed' : 'goal.updated',
                    {
                        changedFields: statusChanged
                            ? [...new Set([...changedFields, 'status'])]
                            : changedFields,
                        ...(statusChanged ? { previous: { status: statusBefore } } : {}),
                    },
                ),
            ),
        );
    }

    async delete(
        userId: string,
        goalId: string,
        scope?: OwnershipScope,
    ): Promise<{ deleted: true }> {
        const existing = await this.findOrThrow(userId, goalId, scope);
        const publisher = this.domainEvents;
        if (!publisher) {
            // DB-level cascades remove samples + mission_goals edges.
            await this.goals.remove(existing);
            return { deleted: true };
        }
        // `goal.deleted` carries the last snapshot, its version claimed first (under the
        // row lock), in the delete's own transaction.
        await publisher.transaction(async (manager) => {
            // The delete cascades to its Mission links (ON DELETE CASCADE): read them
            // first, so each linked Mission records `mission.goal.unlinked` too.
            const links = await manager.getRepository(MissionGoal).find({
                where: { goalId },
                select: { missionId: true, isPrimary: true },
            });
            const tombstone = await publisher.beforeDelete(manager, 'goal', goalId);
            await manager.getRepository(Goal).delete({ id: goalId });
            await publisher.deleted(manager, tombstone, 'goal.deleted');
            for (const link of links) {
                await publisher.child(
                    manager,
                    'mission',
                    link.missionId,
                    'mission.goal.unlinked',
                    { missionId: link.missionId, goalId, isPrimary: link.isPrimary, deleted: true },
                    { changedFields: ['goals'] },
                );
            }
        });
        return { deleted: true };
    }

    // ─── lifecycle ──────────────────────────────────────────────────

    /**
     * DRAFT | PAUSED | COMPLETED → ACTIVE.
     *
     * A metric Goal requires an evaluable `metricSource` (explicit
     * pluginId + metricId — spec FR-3: multiple providers may be enabled,
     * so a Goal always names its provider). A delivery Goal requires at
     * least one APPROVED Definition-of-Done criterion — without one it has
     * no finish line to evaluate against. Re-activating a COMPLETED Goal
     * clears its outcome. `nextCheckAt` is set to "now" for BOTH kinds so
     * the next dispatcher tick evaluates immediately: for a delivery Goal
     * that tick reads no provider, it only re-checks the DoD and the
     * deadline (so deadline → MISSED still works without a plugin).
     */
    async activate(userId: string, goalId: string, scope?: OwnershipScope): Promise<GoalDto> {
        const existing = await this.findOrThrow(userId, goalId, scope);
        if (!ACTIVATABLE_STATUSES.includes(existing.status)) {
            throw new BadRequestException(
                `Goal cannot be activated from status "${existing.status}". Allowed: ${ACTIVATABLE_STATUSES.join(', ')}.`,
            );
        }
        if (isDeliveryGoal(existing)) {
            if (!hasDefinitionOfDone(existing)) {
                throw new BadRequestException(
                    'Delivery Goals need at least one approved Definition-of-Done criterion before activation.',
                );
            }
        } else {
            this.validateMetricSource(existing.metricSource, { requireProvider: true });
        }
        const statusBefore = existing.status;
        existing.status = GoalStatus.ACTIVE;
        existing.outcome = null;
        existing.nextCheckAt = new Date();
        return toGoalDto(
            await this.persist(existing, (publisher, manager, row) =>
                publisher.changed(manager, 'goal', row.id, 'goal.status_changed', {
                    changedFields: ['status', 'outcome'],
                    previous: { status: statusBefore },
                }),
            ),
        );
    }

    /** ACTIVE → PAUSED; clears `nextCheckAt` so the dispatcher skips it. */
    async pause(userId: string, goalId: string, scope?: OwnershipScope): Promise<GoalDto> {
        const existing = await this.findOrThrow(userId, goalId, scope);
        if (!PAUSABLE_STATUSES.includes(existing.status)) {
            throw new BadRequestException(
                `Goal cannot be paused from status "${existing.status}". Allowed: ${PAUSABLE_STATUSES.join(', ')}.`,
            );
        }
        existing.status = GoalStatus.PAUSED;
        existing.nextCheckAt = null;
        return toGoalDto(
            await this.persist(existing, (publisher, manager, row) =>
                publisher.changed(manager, 'goal', row.id, 'goal.status_changed', {
                    changedFields: ['status'],
                    previous: { status: GoalStatus.ACTIVE },
                }),
            ),
        );
    }

    /**
     * Manual tick (`POST /me/goals/:id/evaluate-now`). Bypasses the
     * `nextCheckAt` schedule but NOT the budget guard — the metric
     * read goes through the same `MetricsFacadeService.getMetricValue`
     * path as a scheduled evaluation. Only ACTIVE Goals can be
     * evaluated (activation is what validates the metric source). For a
     * delivery Goal the tick reads no provider; it re-checks the DoD.
     */
    async evaluateNow(
        userId: string,
        goalId: string,
        scope?: OwnershipScope,
    ): Promise<{ entry: GoalEvaluationEntry; goal: GoalDto }> {
        const existing = await this.findOrThrow(userId, goalId, scope);
        if (existing.status !== GoalStatus.ACTIVE) {
            throw new BadRequestException(
                `Goal must be active to evaluate now (status is "${existing.status}").`,
            );
        }
        const entry = await this.evaluationService.evaluateOne(existing);
        const fresh = await this.findOrThrow(userId, goalId, scope);
        return { entry, goal: toGoalDto(fresh) };
    }

    // ─── Mission ↔ Goal links ───────────────────────────────────────

    async listForMission(
        userId: string,
        missionId: string,
        scope?: OwnershipScope,
    ): Promise<MissionGoalLinkDto[]> {
        await this.findMissionOrThrow(userId, missionId, scope);
        // The edge row is a pure join keyed by its ownership-validated
        // endpoints — do NOT re-filter it by its own stamp: edges created
        // before scope stamping (and edges of an upgraded-from-account
        // Mission, whose backfill covers `missions` but not `mission_goals`)
        // would silently vanish from an in-scope Mission and become
        // impossible to manage. Link visibility instead follows the GOAL
        // endpoint below: a link whose Goal is not visible in the current
        // scope is dropped, so out-of-scope goalIds still are not disclosed.
        const links = await this.missionGoals.find({
            where: { userId, missionId },
            order: { createdAt: 'ASC' },
        });
        if (links.length === 0) return [];
        const goalRows = await this.goals.find({
            where: ownershipWhereWith<Goal>(userId, scope, {
                id: In(links.map((l) => l.goalId)),
            }),
        });
        const byId = new Map(goalRows.map((g) => [g.id, g]));
        return links
            .filter((link) => byId.has(link.goalId))
            .map((link) => toMissionGoalLinkDto(link, byId.get(link.goalId) ?? null));
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
        scope?: OwnershipScope,
    ): Promise<MissionGoalLinkDto> {
        await this.findMissionOrThrow(userId, missionId, scope);
        const goal = await this.findOrThrow(userId, goalId, scope);

        if (isPrimary) {
            // Demote-before-promote so the Postgres partial unique
            // index never sees two primaries. The index
            // (`uq_mission_goals_primary`) is per-MISSION and knows nothing
            // about scope stamps, so the demotion query must not be
            // scope-filtered either: a legacy (null/null-stamped) primary
            // edge that the current scope's filter cannot see would
            // otherwise survive, and saving the new primary would hit the
            // index and 500 instead of demoting. The Mission was
            // ownership-validated above; `userId` confines the write.
            const currentPrimaries = await this.missionGoals.find({
                where: { userId, missionId, isPrimary: true },
            });
            await Promise.all(
                currentPrimaries.map((primary) => {
                    primary.isPrimary = false;
                    return this.missionGoals.save(primary);
                }),
            );
            // EW-P2-5 — a demoted Goal lost its primary Mission (`primaryMissionId`).
            for (const demoted of currentPrimaries) {
                if (demoted.goalId !== goalId) {
                    await this.recordGoalMissionLink(missionId, demoted.goalId, false, 'demoted');
                }
            }
        }

        // Both endpoints were ownership-validated above; the edge itself is
        // keyed by them. A scope filter here would make a legacy
        // (pre-stamping) edge invisible, so the create below would hit the
        // unique (missionId, goalId) index and the duplicate-recovery
        // re-read would ALSO miss it and rethrow a 500.
        const linkWhere = { userId, missionId, goalId };
        let link = await this.missionGoals.findOne({ where: linkWhere });
        if (link) {
            if (link.isPrimary !== isPrimary) {
                link.isPrimary = isPrimary;
                link = await this.missionGoals.save(link);
                await this.recordGoalMissionLink(missionId, goalId, isPrimary, 'linked');
            }
            return toMissionGoalLinkDto(link, goal);
        }

        try {
            link = await this.missionGoals.save(
                this.missionGoals.create({
                    missionId,
                    goalId,
                    userId,
                    isPrimary,
                    ...ownershipStamp(scope),
                }),
            );
        } catch (err) {
            // Duplicate (missionId, goalId) race — re-read and apply
            // the isPrimary intent (mirrors the MissionAttachment
            // idempotency contract).
            if (err instanceof Error && /duplicate key|unique constraint/i.test(err.message)) {
                const existing = await this.missionGoals.findOne({ where: linkWhere });
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
        await this.recordGoalMissionLink(missionId, goalId, isPrimary, 'linked');
        return toMissionGoalLinkDto(link, goal);
    }

    /**
     * EW-P2-5 — a Mission ↔ Goal link change: `mission.goal.linked` / `.unlinked` (child:
     * the link; aggregate: the Mission with its new version) and `goal.updated` (the Goal
     * DTO's `missionIds` / `primaryMissionId`). Best-effort after the write; a demotion
     * (another Goal became primary) records only the demoted Goal's `goal.updated`.
     */
    private async recordGoalMissionLink(
        missionId: string,
        goalId: string,
        isPrimary: boolean,
        change: 'linked' | 'unlinked' | 'demoted',
    ): Promise<void> {
        await recordAfterWrite(
            this.domainEvents,
            async (publisher, manager) => {
                if (change !== 'demoted') {
                    await publisher.child(
                        manager,
                        'mission',
                        missionId,
                        `mission.goal.${change}`,
                        {
                            missionId,
                            goalId,
                            isPrimary,
                            ...(change === 'unlinked' ? { deleted: true } : {}),
                        },
                        { changedFields: ['goals'] },
                    );
                }
                await publisher.changed(manager, 'goal', goalId, 'goal.updated', {
                    changedFields: ['missionIds', 'primaryMissionId'],
                });
            },
            (message) => this.logger.warn(message),
            `mission.goal.${change} for mission ${missionId} / goal ${goalId}`,
        );
    }

    /**
     * Detach a Goal from a Mission. Deletes the edge only — the Goal
     * itself (and its samples) is untouched.
     */
    async unlinkFromMission(
        userId: string,
        missionId: string,
        goalId: string,
        scope?: OwnershipScope,
    ): Promise<{ deleted: true }> {
        await this.findMissionOrThrow(userId, missionId, scope);
        await this.findOrThrow(userId, goalId, scope);
        // Endpoints validated above; do not scope-filter the edge itself or
        // a legacy (pre-stamping) link of an in-scope pair becomes
        // impossible to unlink.
        const link = await this.missionGoals.findOne({
            where: { userId, missionId, goalId },
        });
        if (!link) {
            throw new NotFoundException(`Goal link not found`);
        }
        const wasPrimary = link.isPrimary === true;
        await this.missionGoals.remove(link);
        await this.recordGoalMissionLink(missionId, goalId, wasPrimary, 'unlinked');
        return { deleted: true };
    }

    // ─── internals ──────────────────────────────────────────────────

    /**
     * Save a Goal and record its event in ONE transaction (EW-P2-2): the version bump
     * (re-checked against an integration's `If-Match`), the snapshot and the outbox row
     * commit with the write or not at all. Without a publisher it is today's plain save.
     */
    private async persist(
        goal: Goal,
        record: (
            publisher: DomainEventPublisher,
            manager: EntityManager,
            row: Goal,
        ) => Promise<unknown>,
    ): Promise<Goal> {
        const publisher = this.domainEvents;
        if (!publisher) return this.goals.save(withoutAggregateVersion(goal));
        return publisher.transaction(async (manager) => {
            const row = await manager.getRepository(Goal).save(withoutAggregateVersion(goal));
            await record(publisher, manager, row);
            return row;
        });
    }

    /**
     * The Goal's current row inside `manager`'s transaction — `FOR UPDATE` on Postgres and
     * MySQL; SQLite has no row locks and serializes its writers on one connection. Falls
     * back to `goal` when the row is gone (the write then fails on its own terms).
     */
    private async reloadForUpdate(manager: EntityManager, goal: Goal): Promise<Goal> {
        const type = manager.connection.options.type;
        const locks = type === 'postgres' || type === 'mysql' || type === 'mariadb';
        const row = await manager.getRepository(Goal).findOne({
            where: { id: goal.id },
            ...(locks ? { lock: { mode: 'pessimistic_write' as const } } : {}),
        });
        return row ?? goal;
    }

    private archivedPredicate(archived: ListGoalsFilter['archived']): FindOptionsWhere<Goal> {
        if (archived === 'all') return {};
        return archived === true ? { archivedAt: Not(IsNull()) } : { archivedAt: IsNull() };
    }

    private async findOrThrow(
        userId: string,
        goalId: string,
        scope?: OwnershipScope,
    ): Promise<Goal> {
        const row = await this.goals.findOne({
            where: ownershipWhereWith<Goal>(userId, scope, { id: goalId }),
        });
        if (!row) {
            throw new NotFoundException(`Goal not found`);
        }
        return row;
    }

    private async findMissionOrThrow(
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

    /**
     * Judgment layer G1 - reject an invalid criteria/constraint payload
     * with EVERY problem at once. The helper returns a list rather than
     * throwing so this service owns the exception type (the same idiom as
     * `validateMetricSource`).
     */
    private assertJudgment(input: Parameters<typeof validateGoalJudgment>[0]): void {
        const errors = validateGoalJudgment(input);
        if (errors.length > 0) {
            throw new BadRequestException(errors.map((e) => `${e.field}: ${e.message}`).join('; '));
        }
    }

    /**
     * WRITE-path kind resolution: omitted means `metric` (every caller
     * that predates kinds), anything not in the vocabulary is refused. No
     * coercion here — that is `normalizeGoalKind`'s job on READ paths only.
     */
    private resolveWriteKind(value: GoalKind | undefined): GoalKind {
        const kind = value === undefined || value === null ? DEFAULT_GOAL_KIND : value;
        if (!isGoalKind(kind)) {
            throw new BadRequestException(
                `Invalid goalKind "${String(kind)}". Allowed: ${GOAL_KINDS.join(', ')}.`,
            );
        }
        return kind;
    }

    /** The per-kind shape rule (`goal-kind.ts`), reported all at once. */
    private assertGoalKindShape(input: Parameters<typeof validateGoalKindInput>[0]): void {
        const errors = validateGoalKindInput(input);
        if (errors.length > 0) {
            throw new BadRequestException(errors.map((e) => `${e.field}: ${e.message}`).join('; '));
        }
    }

    /**
     * Validate + canonicalise a submitted Definition of Done for the
     * create path. Absent → NULL (no checklist, which is the metric Goal
     * this service always created). The delivery-kind requirement of at
     * least one approved entry is enforced by `assertGoalKindShape`.
     */
    private normalizeDodInput(
        criteria: GoalDoDCriterion[] | null | undefined,
    ): GoalDoDCriterion[] | null {
        if (criteria === undefined || criteria === null) return null;
        const errors = validateDoDCriteria(criteria);
        if (errors.length > 0) {
            throw new BadRequestException(errors.map((e) => `${e.field}: ${e.message}`).join('; '));
        }
        return criteria.length === 0 ? null : normalizeDoDCriteria(criteria);
    }

    private assertUnit(value: unknown): void {
        if (typeof value !== 'string' || value.trim().length === 0) {
            throw new BadRequestException('unit must be a non-empty string.');
        }
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
     * Validate + normalize the metric source — METRIC Goals only; a
     * delivery Goal never reaches this (its `metricSource` is NULL by
     * rule). `requireProvider` hardens the activation path: a DRAFT goal
     * may be sketched with placeholder ids, but activation (and any edit
     * while ACTIVE) demands a concrete pluginId + metricId.
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
