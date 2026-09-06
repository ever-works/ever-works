import {
    DEFAULT_GOAL_KIND,
    GOAL_KINDS,
    isGoalKind,
    normalizeGoalKind,
    type GoalKind,
} from '@ever-works/contracts';
import type { Goal, GoalComparator, GoalDoDCriterion, GoalWindow } from '../entities/goal.entity';
import { validateDoDCriteria } from './goal-dod';

/**
 * Self-build slice AG (EW-795) — pure helpers for the Goal KIND
 * discriminator.
 *
 * Side-effect free and taking plain row shapes, exactly like
 * `goal-criteria.ts` / `goal-dod.ts`: the write-path validator, the
 * evaluation service, the orchestrator and the specs all share ONE set of
 * rules for "what must a metric Goal carry, what must a delivery Goal NOT
 * carry" instead of four re-derivations that drift apart.
 *
 * The rule, stated once:
 *   - **metric**   ⇒ `metricSource`, `comparator`, `targetValue`, `unit`
 *                    and `window` are all REQUIRED (exactly as before the
 *                    kind existed).
 *   - **delivery** ⇒ every metric-only field must be absent or null, and a
 *                    Definition of Done with at least one APPROVED
 *                    criterion is required. A delivery Goal cannot be born
 *                    with an unapproved finish line.
 *   - anything else ⇒ rejected. A Goal that satisfies neither rule has no
 *                    completion rule and must not exist.
 */

export const GOAL_COMPARATORS: readonly GoalComparator[] = ['gte', 'lte'];
export const GOAL_WINDOWS: readonly GoalWindow[] = ['day', 'week', 'month', 'total', 'point'];

/**
 * Fields that only mean something on a metric Goal. `window` is included
 * even though its column stays NOT NULL (a delivery row stores `'total'`
 * and never reads it): accepting a window on a delivery Goal would let a
 * client believe an aggregation is happening when nothing is measured.
 */
export type GoalMetricOnlyField =
    | 'metricSource'
    | 'comparator'
    | 'targetValue'
    | 'unit'
    | 'window'
    | 'baselineValue'
    | 'criteria'
    | 'constraints';

export const GOAL_METRIC_ONLY_FIELDS: readonly GoalMetricOnlyField[] = [
    'metricSource',
    'comparator',
    'targetValue',
    'unit',
    'window',
    'baselineValue',
    'criteria',
    'constraints',
];

export interface GoalKindValidationError {
    field: string;
    message: string;
}

/** The loose input shape the kind rules inspect (create payloads and row-like objects). */
export type GoalKindShapeInput = {
    goalKind?: unknown;
    dodCriteria?: unknown;
} & Partial<Record<GoalMetricOnlyField, unknown>>;

/** READ-path kind of a row: an unknown/missing value renders as `metric`. */
export function resolveGoalKind(goal: Pick<Goal, 'goalKind'> | null | undefined): GoalKind {
    return normalizeGoalKind(goal?.goalKind);
}

export function isDeliveryGoal(goal: Pick<Goal, 'goalKind'> | null | undefined): boolean {
    return resolveGoalKind(goal) === 'delivery';
}

export function isMetricGoal(goal: Pick<Goal, 'goalKind'> | null | undefined): boolean {
    return resolveGoalKind(goal) === 'metric';
}

/**
 * Which metric-only fields the input actually SETS.
 *
 * `null` counts as absent by default — the wire contract says "absent or
 * null" for a delivery Goal, and a client that serialises every optional
 * field as `null` must not be rejected for it. `update` on a delivery Goal
 * passes `treatNullAsPresent` because there `null` is a write ("clear the
 * baseline") that has no meaning on a Goal without a metric.
 */
export function metricOnlyFieldsPresent(
    input: Partial<Record<GoalMetricOnlyField, unknown>>,
    opts: { treatNullAsPresent?: boolean } = {},
): GoalMetricOnlyField[] {
    return GOAL_METRIC_ONLY_FIELDS.filter((field) => {
        const value = input[field];
        if (value === undefined) return false;
        if (value === null) return opts.treatNullAsPresent === true;
        return true;
    });
}

/**
 * Validate a create payload against its kind, reporting EVERY problem at
 * once. Returns a list rather than throwing so the calling service owns
 * the exception type — the `validateGoalJudgment` / `validateDoDCriteria`
 * idiom.
 *
 * For a metric Goal this is a presence check only; `GoalsService` still
 * runs its per-field assertions (whose exact messages are pinned by the
 * e2e validation matrix) BEFORE calling this, so the two never disagree
 * and this layer is the fail-closed backstop.
 */
export function validateGoalKindInput(input: GoalKindShapeInput): GoalKindValidationError[] {
    const kind =
        input.goalKind === undefined || input.goalKind === null
            ? DEFAULT_GOAL_KIND
            : input.goalKind;
    if (!isGoalKind(kind)) {
        return [
            {
                field: 'goalKind',
                message: `must be one of ${GOAL_KINDS.join(', ')}`,
            },
        ];
    }
    return kind === 'delivery' ? validateDeliveryGoalInput(input) : validateMetricGoalInput(input);
}

/** metric ⇒ all four metric fields + window required. */
export function validateMetricGoalInput(
    input: Partial<Record<GoalMetricOnlyField, unknown>>,
): GoalKindValidationError[] {
    const errors: GoalKindValidationError[] = [];
    const source = input.metricSource;
    if (typeof source !== 'object' || source === null || Array.isArray(source)) {
        errors.push({ field: 'metricSource', message: 'is required for a metric Goal' });
    }
    if (!GOAL_COMPARATORS.includes(input.comparator as GoalComparator)) {
        errors.push({
            field: 'comparator',
            message: `is required for a metric Goal (one of ${GOAL_COMPARATORS.join(', ')})`,
        });
    }
    if (typeof input.targetValue !== 'number' || !Number.isFinite(input.targetValue)) {
        errors.push({ field: 'targetValue', message: 'is required for a metric Goal' });
    }
    if (typeof input.unit !== 'string' || input.unit.trim().length === 0) {
        errors.push({ field: 'unit', message: 'is required for a metric Goal' });
    }
    if (!GOAL_WINDOWS.includes(input.window as GoalWindow)) {
        errors.push({
            field: 'window',
            message: `is required for a metric Goal (one of ${GOAL_WINDOWS.join(', ')})`,
        });
    }
    return errors;
}

/**
 * delivery ⇒ no metric-only field, and a Definition of Done with at least
 * one approved criterion. Proposed (planner-authored, unapproved) entries
 * are refused outright: `summarizeDoD` excludes them from the rollup, so a
 * Goal born with nothing but proposals would have no finish line at all.
 */
export function validateDeliveryGoalInput(input: GoalKindShapeInput): GoalKindValidationError[] {
    const errors: GoalKindValidationError[] = metricOnlyFieldsPresent(input).map((field) => ({
        field,
        message: 'must be omitted for a delivery Goal (delivery Goals carry no metric target)',
    }));

    const dod = input.dodCriteria;
    if (!Array.isArray(dod) || dod.length === 0) {
        errors.push({
            field: 'dodCriteria',
            message: 'a delivery Goal needs at least one Definition-of-Done criterion',
        });
        return errors;
    }
    const dodErrors = validateDoDCriteria(dod);
    if (dodErrors.length > 0) {
        return [...errors, ...dodErrors];
    }
    if ((dod as GoalDoDCriterion[]).some((entry) => entry.proposed === true)) {
        errors.push({
            field: 'dodCriteria',
            message:
                'a delivery Goal cannot be created with proposed (unapproved) criteria — every criterion must be approved',
        });
    }
    return errors;
}
