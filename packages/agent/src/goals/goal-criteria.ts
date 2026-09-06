import {
    GOAL_CONSTRAINT_CATEGORIES,
    type Goal,
    type GoalConstraint,
    type GoalCriterion,
    type GoalMetricSource,
    type GoalResolvedScore,
    type GoalWindow,
} from '../entities/goal.entity';

/**
 * Judgment layer G1 — pure helpers for weighted criteria + constraints.
 *
 * Side-effect free and taking plain row shapes, exactly like
 * `tasks-domain/task-gates.ts`: the evaluation service, the write-path
 * validator and the specs all share ONE set of rules instead of three
 * re-derivations that drift.
 */

/** A criterion's weight is clamped into this range at validation time. */
export const MIN_CRITERION_WEIGHT = 0.0001;
export const MAX_CRITERION_WEIGHT = 1000;

/** Bounds on how much structure one Goal may carry (DoS guard on simple-json). */
export const MAX_GOAL_CRITERIA = 20;
export const MAX_GOAL_CONSTRAINTS = 20;

/** Serialized-size cap for the criteria/constraints columns. */
export const MAX_GOAL_JUDGMENT_JSON_CHARS = 16_000;

/**
 * Does this Goal use the weighted path at all?
 *
 * The single most important predicate in G1: `false` means the Goal is
 * exactly the single-metric Goal it always was, and evaluation must take
 * the byte-identical original path. Everything weighted hangs off this.
 */
export function hasWeightedCriteria(
    goal: Pick<Goal, 'criteria'> | null | undefined,
): goal is Pick<Goal, 'criteria'> & { criteria: GoalCriterion[] } {
    return Array.isArray(goal?.criteria) && goal.criteria.length > 0;
}

/** Constraints declared on the Goal, defensively normalized to an array. */
export function resolveConstraints(
    goal: Pick<Goal, 'constraints'> | null | undefined,
): GoalConstraint[] {
    return Array.isArray(goal?.constraints) ? goal.constraints : [];
}

/** `hard` defaults to TRUE — a constraint is a rule until it says otherwise. */
export function isHardConstraint(constraint: Pick<GoalConstraint, 'hard'>): boolean {
    return constraint.hard !== false;
}

/**
 * The metric a criterion/constraint reads: its own override, else the
 * Goal's. Inheritance is what keeps the common "same metric, several
 * thresholds" Goal free of repetition.
 *
 * `source` is `null` when neither the node nor the Goal names one — a
 * delivery Goal has no `metricSource` (and refuses criteria/constraints on
 * write), but the type must be honest so a caller cannot dereference a
 * source that is not there.
 */
export function resolveSourceFor(
    goal: Pick<Goal, 'metricSource' | 'window'>,
    node: { metricSource?: GoalMetricSource; window?: GoalWindow },
): { source: GoalMetricSource | null; window: GoalWindow } {
    return {
        source: node.metricSource ?? goal.metricSource ?? null,
        window: node.window ?? goal.window,
    };
}

/**
 * How satisfied one criterion is, as a 0..1 ratio.
 *
 * `gte` (higher is better): `value / target`, clamped to 1. A target of 0
 * is already met by any non-negative value — dividing by it would produce
 * Infinity, so it short-circuits to 1.
 *
 * `lte` (lower is better): full credit at or under target, then decaying
 * to 0 as the value reaches twice the target. The 2x band is a deliberate
 * choice over a hard 0/1 step: a Goal that is 5% over budget should score
 * far better than one that is 300% over, and a binary cliff would make
 * the weighted score useless for exactly the "how close are we?" question
 * it exists to answer.
 */
export function criterionRatio(value: number, target: number, direction: 'gte' | 'lte'): number {
    if (!Number.isFinite(value)) return 0;
    if (direction === 'gte') {
        if (target <= 0) return 1;
        return clamp01(value / target);
    }
    if (value <= target) return 1;
    if (target <= 0) {
        // Target 0 with a positive value: no meaningful band to decay
        // across, so any overage is a miss.
        return 0;
    }
    return clamp01((2 * target - value) / target);
}

/** A criterion is SATISFIED when the raw comparison holds — not the ratio. */
export function criterionSatisfied(
    value: number,
    target: number,
    direction: 'gte' | 'lte',
): boolean {
    return direction === 'gte' ? value >= target : value <= target;
}

/**
 * Is a measurable constraint violated by this observation?
 *
 * Declarative constraints (no `maxValue`/`minValue`) are NEVER reported as
 * violated: the platform must not claim to have checked something it
 * cannot measure. They are carried for prompts and reports only.
 */
export function constraintViolated(constraint: GoalConstraint, value: number): boolean {
    if (!Number.isFinite(value)) return false;
    if (typeof constraint.maxValue === 'number' && value > constraint.maxValue) return true;
    if (typeof constraint.minValue === 'number' && value < constraint.minValue) return true;
    return false;
}

/** True when the constraint declares a threshold this platform can read. */
export function isMeasurableConstraint(constraint: GoalConstraint): boolean {
    return typeof constraint.maxValue === 'number' || typeof constraint.minValue === 'number';
}

export interface CriterionObservation {
    criterion: GoalCriterion;
    /** Observed metric value, or null when the read failed. */
    value: number | null;
    error?: string;
}

/**
 * Fold per-criterion observations into the resolved score.
 *
 * Weights are NORMALIZED over the criteria that actually resolved, so a
 * provider outage on one metric degrades the score's precision instead of
 * silently dragging it toward zero — an unreadable criterion is unknown,
 * not failed. When NOTHING resolved the score is 0 and every entry
 * carries its error, which is the honest report.
 */
export function computeResolvedScore(
    observations: CriterionObservation[],
    violations: { violated: GoalConstraint[]; violatedHard: GoalConstraint[] },
    at: Date = new Date(),
): GoalResolvedScore {
    const entries: GoalResolvedScore['criteria'] = [];
    let weightedSum = 0;
    let resolvedWeight = 0;

    for (const observation of observations) {
        const { criterion, value } = observation;
        const weight = normalizeWeight(criterion.weight);
        const ratio =
            value === null ? 0 : criterionRatio(value, criterion.target, criterion.direction);
        const satisfied =
            value !== null && criterionSatisfied(value, criterion.target, criterion.direction);
        if (value !== null) {
            weightedSum += ratio * weight;
            resolvedWeight += weight;
        }
        entries.push({
            id: criterion.id,
            value,
            target: criterion.target,
            weight,
            ratio,
            satisfied,
            ...(observation.error ? { error: observation.error } : {}),
        });
    }

    return {
        score: resolvedWeight > 0 ? clamp01(weightedSum / resolvedWeight) : 0,
        criteria: entries,
        violatedConstraintIds: violations.violated.map((c) => c.id),
        violatedHardConstraintIds: violations.violatedHard.map((c) => c.id),
        at: at.toISOString(),
    };
}

/**
 * The achieve rule for a weighted Goal:
 *   EVERY criterion satisfied AND NO hard constraint violated.
 *
 * "Every criterion", not "score above a threshold": a weighted score
 * tells you how close you are, but a Goal with an unmet criterion is not
 * achieved no matter how well the others compensate. And a violated hard
 * constraint vetoes regardless — that is the entire point of declaring
 * one (`escalate-on-hard`).
 */
export function isWeightedGoalAchieved(score: GoalResolvedScore): boolean {
    if (score.violatedHardConstraintIds.length > 0) return false;
    if (score.criteria.length === 0) return false;
    return score.criteria.every((entry) => entry.satisfied);
}

// ─── validation (write path) ────────────────────────────────────────

export interface GoalJudgmentValidationError {
    field: 'criteria' | 'constraints';
    message: string;
}

/**
 * Validate criteria/constraints on create/update. Returns the collected
 * problems (empty = valid) rather than throwing, so the service layer
 * owns the exception type and can report every problem at once.
 */
export function validateGoalJudgment(input: {
    criteria?: GoalCriterion[] | null;
    constraints?: GoalConstraint[] | null;
}): GoalJudgmentValidationError[] {
    const errors: GoalJudgmentValidationError[] = [];
    const criteria = input.criteria;
    const constraints = input.constraints;

    if (criteria != null) {
        if (!Array.isArray(criteria)) {
            errors.push({ field: 'criteria', message: 'criteria must be an array' });
        } else {
            if (criteria.length > MAX_GOAL_CRITERIA) {
                errors.push({
                    field: 'criteria',
                    message: `at most ${MAX_GOAL_CRITERIA} criteria are allowed`,
                });
            }
            const seen = new Set<string>();
            for (const criterion of criteria) {
                if (!criterion?.id || typeof criterion.id !== 'string') {
                    errors.push({ field: 'criteria', message: 'every criterion needs an id' });
                    continue;
                }
                if (seen.has(criterion.id)) {
                    errors.push({
                        field: 'criteria',
                        message: `duplicate criterion id '${criterion.id}'`,
                    });
                }
                seen.add(criterion.id);
                if (typeof criterion.target !== 'number' || !Number.isFinite(criterion.target)) {
                    errors.push({
                        field: 'criteria',
                        message: `criterion '${criterion.id}' needs a finite target`,
                    });
                }
                if (
                    typeof criterion.weight !== 'number' ||
                    !Number.isFinite(criterion.weight) ||
                    criterion.weight <= 0
                ) {
                    errors.push({
                        field: 'criteria',
                        message: `criterion '${criterion.id}' needs a positive weight`,
                    });
                }
                if (criterion.direction !== 'gte' && criterion.direction !== 'lte') {
                    errors.push({
                        field: 'criteria',
                        message: `criterion '${criterion.id}' direction must be 'gte' or 'lte'`,
                    });
                }
            }
            if (jsonChars(criteria) > MAX_GOAL_JUDGMENT_JSON_CHARS) {
                errors.push({ field: 'criteria', message: 'criteria payload is too large' });
            }
        }
    }

    if (constraints != null) {
        if (!Array.isArray(constraints)) {
            errors.push({ field: 'constraints', message: 'constraints must be an array' });
        } else {
            if (constraints.length > MAX_GOAL_CONSTRAINTS) {
                errors.push({
                    field: 'constraints',
                    message: `at most ${MAX_GOAL_CONSTRAINTS} constraints are allowed`,
                });
            }
            const seen = new Set<string>();
            for (const constraint of constraints) {
                if (!constraint?.id || typeof constraint.id !== 'string') {
                    errors.push({
                        field: 'constraints',
                        message: 'every constraint needs an id',
                    });
                    continue;
                }
                if (seen.has(constraint.id)) {
                    errors.push({
                        field: 'constraints',
                        message: `duplicate constraint id '${constraint.id}'`,
                    });
                }
                seen.add(constraint.id);
                if (!GOAL_CONSTRAINT_CATEGORIES.includes(constraint.category)) {
                    errors.push({
                        field: 'constraints',
                        message: `constraint '${constraint.id}' has an unknown category`,
                    });
                }
            }
            if (jsonChars(constraints) > MAX_GOAL_JUDGMENT_JSON_CHARS) {
                errors.push({
                    field: 'constraints',
                    message: 'constraints payload is too large',
                });
            }
        }
    }

    return errors;
}

// ─── internals ──────────────────────────────────────────────────────

function clamp01(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.min(1, Math.max(0, value));
}

/**
 * Defensive weight clamp at READ time (not just write time): the column
 * is `simple-json`, so a hand-edited or imported row can hold anything,
 * and a zero/negative/NaN weight would poison the normalization.
 */
function normalizeWeight(weight: number): number {
    if (typeof weight !== 'number' || !Number.isFinite(weight) || weight <= 0) {
        return 1;
    }
    return Math.min(MAX_CRITERION_WEIGHT, Math.max(MIN_CRITERION_WEIGHT, weight));
}

function jsonChars(value: unknown): number {
    try {
        return JSON.stringify(value)?.length ?? 0;
    } catch {
        return Number.MAX_SAFE_INTEGER;
    }
}
