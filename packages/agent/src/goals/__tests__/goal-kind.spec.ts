import {
    GOAL_METRIC_ONLY_FIELDS,
    isDeliveryGoal,
    isMetricGoal,
    metricOnlyFieldsPresent,
    resolveGoalKind,
    validateDeliveryGoalInput,
    validateGoalKindInput,
    validateMetricGoalInput,
    type GoalKindValidationError,
} from '../goal-kind';

/**
 * Self-build slice AG (EW-795) — the per-kind shape rule, pinned once.
 *
 * `GoalsService.create`, the DTO and the evaluation service all lean on
 * these helpers, so this suite is the specification of "what must a
 * metric Goal carry, what must a delivery Goal NOT carry". Fail closed:
 * a Goal that satisfies neither rule has no completion rule and is
 * rejected, never coerced.
 */

const METRIC = {
    metricSource: { pluginId: 'stripe', metricId: 'income' },
    comparator: 'gte',
    targetValue: 1000,
    unit: 'usd',
    window: 'month',
};

const DOD = [{ id: 'api', text: 'API endpoint merged', status: 'open' }];

const fields = (errors: GoalKindValidationError[]) => errors.map((e) => e.field);

describe('resolveGoalKind / isDeliveryGoal / isMetricGoal (read paths)', () => {
    it('renders a row without the column, or with an unknown value, as the metric Goal it is', () => {
        expect(resolveGoalKind({ goalKind: undefined as never })).toBe('metric');
        expect(resolveGoalKind(null)).toBe('metric');
        expect(resolveGoalKind(undefined)).toBe('metric');
        expect(resolveGoalKind({ goalKind: 'outcome' as never })).toBe('metric');
    });

    it('recognises both kinds', () => {
        expect(isMetricGoal({ goalKind: 'metric' })).toBe(true);
        expect(isMetricGoal({ goalKind: 'delivery' })).toBe(false);
        expect(isDeliveryGoal({ goalKind: 'delivery' })).toBe(true);
        expect(isDeliveryGoal({ goalKind: 'metric' })).toBe(false);
    });
});

describe('metricOnlyFieldsPresent', () => {
    it('treats undefined AND null as absent by default (the create wire contract)', () => {
        expect(metricOnlyFieldsPresent({ targetValue: undefined, unit: null })).toEqual([]);
    });

    it('treats null as a write when asked (update on a delivery Goal)', () => {
        expect(
            metricOnlyFieldsPresent({ baselineValue: null }, { treatNullAsPresent: true }),
        ).toEqual(['baselineValue']);
    });

    it('reports every set field in the canonical order', () => {
        expect(metricOnlyFieldsPresent({ unit: 'usd', metricSource: {}, criteria: [] })).toEqual([
            'metricSource',
            'unit',
            'criteria',
        ]);
    });

    it('covers exactly the metric-only vocabulary', () => {
        expect([...GOAL_METRIC_ONLY_FIELDS]).toEqual([
            'metricSource',
            'comparator',
            'targetValue',
            'unit',
            'window',
            'baselineValue',
            'criteria',
            'constraints',
        ]);
    });
});

describe('validateGoalKindInput — metric (the default)', () => {
    it('accepts the classic payload with no goalKind at all', () => {
        expect(validateGoalKindInput(METRIC)).toEqual([]);
    });

    it('accepts an explicit metric kind and a null kind', () => {
        expect(validateGoalKindInput({ ...METRIC, goalKind: 'metric' })).toEqual([]);
        expect(validateGoalKindInput({ ...METRIC, goalKind: null })).toEqual([]);
    });

    it.each(['metricSource', 'comparator', 'targetValue', 'unit', 'window'])(
        'still requires %s — exactly as before the kind existed',
        (field) => {
            expect(fields(validateGoalKindInput({ ...METRIC, [field]: undefined }))).toEqual([
                field,
            ]);
            expect(fields(validateGoalKindInput({ ...METRIC, [field]: null }))).toEqual([field]);
        },
    );

    it('rejects a non-finite target, an array metricSource, unknown members and a blank unit', () => {
        expect(fields(validateMetricGoalInput({ ...METRIC, targetValue: Number.NaN }))).toEqual([
            'targetValue',
        ]);
        expect(fields(validateMetricGoalInput({ ...METRIC, targetValue: '1000' }))).toEqual([
            'targetValue',
        ]);
        expect(fields(validateMetricGoalInput({ ...METRIC, metricSource: [] }))).toEqual([
            'metricSource',
        ]);
        expect(fields(validateMetricGoalInput({ ...METRIC, comparator: 'eq' }))).toEqual([
            'comparator',
        ]);
        expect(fields(validateMetricGoalInput({ ...METRIC, window: 'year' }))).toEqual(['window']);
        expect(fields(validateMetricGoalInput({ ...METRIC, unit: '   ' }))).toEqual(['unit']);
    });

    it('reports every missing field at once', () => {
        expect(fields(validateGoalKindInput({}))).toEqual([
            'metricSource',
            'comparator',
            'targetValue',
            'unit',
            'window',
        ]);
    });

    it('tolerates a seed checklist on a metric Goal', () => {
        expect(validateGoalKindInput({ ...METRIC, dodCriteria: DOD })).toEqual([]);
    });
});

describe('validateGoalKindInput — delivery', () => {
    const DELIVERY = { goalKind: 'delivery', dodCriteria: DOD };

    it('accepts a clean delivery payload', () => {
        expect(validateGoalKindInput(DELIVERY)).toEqual([]);
    });

    it('accepts explicit nulls for the metric fields (absent-or-null is the wire contract)', () => {
        expect(
            validateGoalKindInput({
                ...DELIVERY,
                metricSource: null,
                comparator: null,
                targetValue: null,
                unit: null,
                window: null,
                baselineValue: null,
                criteria: null,
                constraints: null,
            }),
        ).toEqual([]);
    });

    it.each(GOAL_METRIC_ONLY_FIELDS)('rejects a delivery Goal that sets %s', (field) => {
        const value =
            field === 'criteria' || field === 'constraints'
                ? []
                : field === 'metricSource'
                  ? { pluginId: 'p', metricId: 'm' }
                  : field === 'comparator'
                    ? 'gte'
                    : field === 'window'
                      ? 'month'
                      : field === 'unit'
                        ? 'usd'
                        : 1;
        const errors = validateGoalKindInput({ ...DELIVERY, [field]: value });
        expect(fields(errors)).toEqual([field]);
        expect(errors[0].message).toContain('must be omitted for a delivery Goal');
    });

    it('requires at least one Definition-of-Done criterion', () => {
        expect(fields(validateGoalKindInput({ goalKind: 'delivery' }))).toEqual(['dodCriteria']);
        expect(fields(validateGoalKindInput({ goalKind: 'delivery', dodCriteria: [] }))).toEqual([
            'dodCriteria',
        ]);
        expect(fields(validateGoalKindInput({ goalKind: 'delivery', dodCriteria: null }))).toEqual([
            'dodCriteria',
        ]);
    });

    it('passes a malformed checklist through the DoD validator', () => {
        const errors = validateDeliveryGoalInput({
            goalKind: 'delivery',
            dodCriteria: [{ id: '', text: 'x', status: 'open' }],
        });
        expect(errors.length).toBeGreaterThan(0);
        expect(errors.every((e) => e.field === 'dodCriteria')).toBe(true);
    });

    it('refuses proposed (unapproved) criteria at birth — a Goal needs an approved finish line', () => {
        const errors = validateGoalKindInput({
            goalKind: 'delivery',
            dodCriteria: [{ id: 'a', text: 'x', status: 'open', proposed: true }],
        });
        expect(fields(errors)).toEqual(['dodCriteria']);
        expect(errors[0].message).toContain('proposed');
    });

    it('accepts a mix as long as at least one criterion is approved', () => {
        expect(
            validateGoalKindInput({
                goalKind: 'delivery',
                dodCriteria: [
                    { id: 'a', text: 'x', status: 'open' },
                    { id: 'b', text: 'y', status: 'done' },
                ],
            }),
        ).toEqual([]);
    });

    it('reports the offending metric fields AND the missing checklist together', () => {
        expect(fields(validateGoalKindInput({ goalKind: 'delivery', targetValue: 5 }))).toEqual([
            'targetValue',
            'dodCriteria',
        ]);
    });
});

describe('validateGoalKindInput — unknown kind (fail closed)', () => {
    it.each(['outcome', 'Metric', ' delivery ', '', 42, {}])(
        'rejects %j without coercing it',
        (kind) => {
            const errors = validateGoalKindInput({ ...METRIC, goalKind: kind });
            expect(fields(errors)).toEqual(['goalKind']);
            expect(errors[0].message).toContain('metric, delivery');
        },
    );
});
