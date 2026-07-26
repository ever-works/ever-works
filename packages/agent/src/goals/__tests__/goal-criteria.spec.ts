import {
    computeResolvedScore,
    constraintViolated,
    criterionRatio,
    criterionSatisfied,
    hasWeightedCriteria,
    isHardConstraint,
    isMeasurableConstraint,
    isWeightedGoalAchieved,
    resolveSourceFor,
    validateGoalJudgment,
    type CriterionObservation,
} from '../goal-criteria';
import type { GoalConstraint, GoalCriterion } from '../../entities/goal.entity';

/**
 * Goal weighted criteria + hard constraints (judgment layer G1).
 *
 * The load-bearing property of this whole feature is ADDITIVITY: a Goal
 * that declares no criteria must be evaluated by the pre-G1 code path,
 * byte for byte. `hasWeightedCriteria` is the single predicate that
 * guarantees it, so it is tested first and hardest.
 */
describe('goal-criteria (G1)', () => {
    function criterion(over: Partial<GoalCriterion> = {}): GoalCriterion {
        return {
            id: 'mrr',
            name: 'Monthly revenue',
            weight: 1,
            target: 1000,
            direction: 'gte',
            ...over,
        };
    }

    describe('hasWeightedCriteria — the additivity gate', () => {
        it('⭐ is false for a Goal with no criteria, so single-metric Goals keep working', async () => {
            // THE ADDITIVITY TEST. Every existing Goal row has NULL here.
            // If this ever returns true for them, the weighted path takes
            // over and every shipped Goal silently changes meaning.
            expect(hasWeightedCriteria({ criteria: null })).toBe(false);
            expect(hasWeightedCriteria({ criteria: undefined })).toBe(false);
            expect(hasWeightedCriteria({ criteria: [] })).toBe(false);
            expect(hasWeightedCriteria(null)).toBe(false);
        });

        it('is true only once at least one criterion is declared', () => {
            expect(hasWeightedCriteria({ criteria: [criterion()] })).toBe(true);
        });
    });

    describe('criterionRatio', () => {
        it('scores a gte criterion as progress toward the target, capped at 1', () => {
            expect(criterionRatio(500, 1000, 'gte')).toBeCloseTo(0.5);
            expect(criterionRatio(1000, 1000, 'gte')).toBe(1);
            expect(criterionRatio(5000, 1000, 'gte')).toBe(1);
        });

        it('gives an lte criterion full credit at or under target', () => {
            expect(criterionRatio(50, 100, 'lte')).toBe(1);
            expect(criterionRatio(100, 100, 'lte')).toBe(1);
        });

        it('⭐ decays an lte overage across a 2x band instead of a 0/1 cliff', () => {
            // A binary cliff would make the weighted score useless for the
            // "how close are we?" question it exists to answer: 5% over
            // budget and 300% over would score identically.
            expect(criterionRatio(150, 100, 'lte')).toBeCloseTo(0.5);
            expect(criterionRatio(200, 100, 'lte')).toBe(0);
            expect(criterionRatio(400, 100, 'lte')).toBe(0);
        });

        it('treats a zero gte target as already met and a zero lte target strictly', () => {
            expect(criterionRatio(0, 0, 'gte')).toBe(1);
            expect(criterionRatio(3, 0, 'lte')).toBe(0);
        });

        it('separates SATISFIED (raw comparison) from the ratio', () => {
            // 0.9 is "nearly there", not "there" — the achieve rule reads
            // satisfaction, the UI reads the ratio.
            expect(criterionRatio(900, 1000, 'gte')).toBeCloseTo(0.9);
            expect(criterionSatisfied(900, 1000, 'gte')).toBe(false);
            expect(criterionSatisfied(1000, 1000, 'gte')).toBe(true);
        });
    });

    describe('computeResolvedScore', () => {
        function obs(
            id: string,
            value: number | null,
            over: Partial<GoalCriterion> = {},
        ): CriterionObservation {
            return {
                criterion: criterion({ id, ...over }),
                value,
                ...(value === null ? { error: 'provider down' } : {}),
            };
        }

        it('weights criteria by their declared weight', () => {
            const score = computeResolvedScore(
                [
                    obs('a', 1000, { weight: 3, target: 1000 }),
                    obs('b', 0, { weight: 1, target: 1000 }),
                ],
                { violated: [], violatedHard: [] },
            );
            // (1*3 + 0*1) / 4
            expect(score.score).toBeCloseTo(0.75);
        });

        it('⭐ renormalizes over the criteria that RESOLVED, so an outage is unknown not failed', async () => {
            // A provider outage on one metric must degrade precision, not
            // drag the score to zero and mark a healthy Goal as missed.
            const score = computeResolvedScore(
                [obs('a', 1000, { target: 1000 }), obs('b', null, { target: 1000 })],
                { violated: [], violatedHard: [] },
            );
            expect(score.score).toBe(1);
            expect(score.criteria[1].value).toBeNull();
            expect(score.criteria[1].error).toBe('provider down');
        });

        it('scores 0 when nothing resolved, and says why per criterion', () => {
            const score = computeResolvedScore([obs('a', null)], {
                violated: [],
                violatedHard: [],
            });
            expect(score.score).toBe(0);
            expect(score.criteria[0].error).toBe('provider down');
        });

        it('defends against a nonsense weight written straight into the json column', () => {
            const score = computeResolvedScore(
                [
                    obs('a', 1000, { weight: 0 as number, target: 1000 }),
                    obs('b', 0, { weight: Number.NaN as number, target: 1000 }),
                ],
                { violated: [], violatedHard: [] },
            );
            // Both clamp to 1 rather than producing NaN / division by zero.
            expect(score.score).toBeCloseTo(0.5);
        });

        it('records violated constraint ids, hard ones separately', () => {
            const soft: GoalConstraint = {
                id: 'soft',
                name: 's',
                category: 'quality',
                hard: false,
            };
            const hard: GoalConstraint = { id: 'hard', name: 'h', category: 'safety' };
            const score = computeResolvedScore([obs('a', 1000)], {
                violated: [soft, hard],
                violatedHard: [hard],
            });
            expect(score.violatedConstraintIds).toEqual(['soft', 'hard']);
            expect(score.violatedHardConstraintIds).toEqual(['hard']);
        });
    });

    describe('isWeightedGoalAchieved', () => {
        const base = { criteria: [], violatedConstraintIds: [], violatedHardConstraintIds: [] };

        it('requires EVERY criterion satisfied — a high score is not enough', () => {
            const score = {
                ...base,
                score: 0.95,
                criteria: [
                    { id: 'a', value: 1000, target: 1000, weight: 9, ratio: 1, satisfied: true },
                    { id: 'b', value: 5, target: 100, weight: 1, ratio: 0.05, satisfied: false },
                ],
                at: new Date().toISOString(),
            };
            expect(isWeightedGoalAchieved(score)).toBe(false);
        });

        it('⭐ a violated HARD constraint vetoes a perfect score', () => {
            // This is the whole reason hard constraints exist ("escalate on
            // hard"): "we hit every number, by breaking a rule" is not an
            // achievement.
            const score = {
                ...base,
                score: 1,
                criteria: [
                    { id: 'a', value: 1000, target: 1000, weight: 1, ratio: 1, satisfied: true },
                ],
                violatedHardConstraintIds: ['never-send-unconfirmed'],
                violatedConstraintIds: ['never-send-unconfirmed'],
                at: new Date().toISOString(),
            };
            expect(isWeightedGoalAchieved(score)).toBe(false);
        });

        it('achieves when every criterion is satisfied and no hard constraint is broken', () => {
            const score = {
                ...base,
                score: 1,
                criteria: [
                    { id: 'a', value: 1000, target: 1000, weight: 1, ratio: 1, satisfied: true },
                ],
                at: new Date().toISOString(),
            };
            expect(isWeightedGoalAchieved(score)).toBe(true);
        });
    });

    describe('constraints', () => {
        it('flags a max/min violation', () => {
            const c: GoalConstraint = {
                id: 'spend',
                name: 'spend cap',
                category: 'cost',
                maxValue: 100,
            };
            expect(constraintViolated(c, 101)).toBe(true);
            expect(constraintViolated(c, 100)).toBe(false);
            expect(constraintViolated({ ...c, maxValue: undefined, minValue: 10 }, 9)).toBe(true);
        });

        it('⭐ never auto-violates a DECLARATIVE constraint the platform cannot measure', () => {
            // "Never send unconfirmed email" has no metric. Reporting it as
            // violated (or as satisfied) would be a claim the platform has
            // no evidence for.
            const declarative: GoalConstraint = {
                id: 'never-send-unconfirmed',
                name: 'Never send without confirmation',
                category: 'safety',
            };
            expect(isMeasurableConstraint(declarative)).toBe(false);
            expect(constraintViolated(declarative, 999)).toBe(false);
        });

        it('defaults `hard` to true — a constraint is a rule until it says otherwise', () => {
            expect(isHardConstraint({ hard: undefined })).toBe(true);
            expect(isHardConstraint({ hard: false })).toBe(false);
        });
    });

    describe('resolveSourceFor — inheritance', () => {
        const goal = {
            metricSource: { pluginId: 'stripe', metricId: 'income' },
            window: 'month' as const,
        };

        it("falls back to the Goal's own metric + window", () => {
            expect(resolveSourceFor(goal, {})).toEqual({
                source: goal.metricSource,
                window: 'month',
            });
        });

        it('honours a per-criterion override', () => {
            const override = { pluginId: 'custom-http', metricId: 'churn' };
            expect(resolveSourceFor(goal, { metricSource: override, window: 'week' })).toEqual({
                source: override,
                window: 'week',
            });
        });
    });

    describe('validateGoalJudgment', () => {
        it('accepts an omitted payload (the single-metric Goal)', () => {
            expect(validateGoalJudgment({})).toEqual([]);
        });

        it('rejects duplicate criterion ids', () => {
            const errors = validateGoalJudgment({
                criteria: [criterion({ id: 'a' }), criterion({ id: 'a' })],
            });
            expect(errors.some((e) => e.message.includes('duplicate'))).toBe(true);
        });

        it('rejects a non-positive weight and a non-finite target', () => {
            const errors = validateGoalJudgment({
                criteria: [criterion({ id: 'a', weight: 0 }), criterion({ id: 'b', target: NaN })],
            });
            expect(errors.some((e) => e.message.includes('positive weight'))).toBe(true);
            expect(errors.some((e) => e.message.includes('finite target'))).toBe(true);
        });

        it('rejects an unknown constraint category', () => {
            const errors = validateGoalJudgment({
                constraints: [{ id: 'c', name: 'x', category: 'vibes' as never }],
            });
            expect(errors.some((e) => e.message.includes('unknown category'))).toBe(true);
        });

        it('reports EVERY problem at once rather than the first', () => {
            const errors = validateGoalJudgment({
                criteria: [criterion({ id: '' as never }), criterion({ id: 'b', weight: -1 })],
                constraints: [{ id: 'c', name: 'x', category: 'nope' as never }],
            });
            expect(errors.length).toBeGreaterThanOrEqual(3);
        });
    });
});
