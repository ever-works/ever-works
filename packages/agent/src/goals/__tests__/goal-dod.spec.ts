import type { GoalDoDCriterion } from '../../entities/goal.entity';
import {
    MAX_DOD_TEXT_CHARS,
    MAX_GOAL_DOD_CRITERIA,
    dodProgressSignature,
    hasDefinitionOfDone,
    normalizeDoDCriteria,
    summarizeDoD,
    validateDoDCriteria,
} from '../goal-dod';

/**
 * Autonomy layer — pure Definition-of-Done rules.
 *
 * The behaviour that matters here is what COUNTS: proposed criteria must
 * stay out of the rollup (a planning run must not be able to move its own
 * finish line), waived must close a criterion without claiming it was
 * done, and the progress signature must ignore cosmetic edits so stuck
 * detection measures real progress.
 */

function criterion(overrides: Partial<GoalDoDCriterion> = {}): GoalDoDCriterion {
    return { id: 'c1', text: 'Ship the pricing page', status: 'open', ...overrides };
}

describe('summarizeDoD', () => {
    it('rolls up done / waived / open and reports completion', () => {
        const summary = summarizeDoD([
            criterion({ id: 'a', status: 'done' }),
            criterion({ id: 'b', status: 'waived' }),
            criterion({ id: 'c', status: 'open' }),
        ]);
        expect(summary).toMatchObject({
            total: 3,
            done: 1,
            waived: 1,
            open: 1,
            closed: 2,
            complete: false,
        });
    });

    it('is complete when every approved criterion is done or waived', () => {
        expect(
            summarizeDoD([
                criterion({ id: 'a', status: 'done' }),
                criterion({ id: 'b', status: 'waived' }),
            ]).complete,
        ).toBe(true);
    });

    it('is NOT complete with an empty checklist', () => {
        // An empty Definition of Done means "nobody said what done is" —
        // treating that as finished would let the loop declare victory on
        // a Goal nobody has specified.
        expect(summarizeDoD([]).complete).toBe(false);
        expect(summarizeDoD(null).complete).toBe(false);
    });

    it('excludes proposed criteria from the rollup entirely', () => {
        const summary = summarizeDoD([
            criterion({ id: 'a', status: 'done' }),
            criterion({ id: 'p1', status: 'open', proposed: true, source: 'planner' }),
        ]);
        // A planning run appending an open criterion must not flip the Goal
        // from complete to incomplete before an operator has approved it.
        expect(summary.total).toBe(1);
        expect(summary.open).toBe(0);
        expect(summary.proposed).toBe(1);
        expect(summary.complete).toBe(true);
    });

    it('does not let a proposed DONE criterion satisfy the Goal either', () => {
        const summary = summarizeDoD([
            criterion({ id: 'a', status: 'open' }),
            criterion({ id: 'p1', status: 'done', proposed: true }),
        ]);
        expect(summary.done).toBe(0);
        expect(summary.complete).toBe(false);
    });
});

describe('hasDefinitionOfDone', () => {
    it('ignores proposed-only checklists', () => {
        expect(hasDefinitionOfDone({ dodCriteria: [criterion({ proposed: true })] })).toBe(false);
        expect(hasDefinitionOfDone({ dodCriteria: [criterion()] })).toBe(true);
        expect(hasDefinitionOfDone({ dodCriteria: null })).toBe(false);
    });
});

describe('dodProgressSignature', () => {
    it('changes when a criterion status changes', () => {
        const before = dodProgressSignature([criterion({ id: 'a', status: 'open' })]);
        const after = dodProgressSignature([criterion({ id: 'a', status: 'done' })]);
        expect(before).not.toEqual(after);
    });

    it('does NOT change when only evidence or note is edited', () => {
        // Rewording why something was waived is not progress; if it reset
        // the stuck clock, a loop could look busy forever without moving.
        const before = dodProgressSignature([criterion({ id: 'a', status: 'waived' })]);
        const after = dodProgressSignature([
            criterion({ id: 'a', status: 'waived', note: 'superseded by the new plan' }),
        ]);
        expect(before).toEqual(after);
    });

    it('is order-independent', () => {
        const a = dodProgressSignature([
            criterion({ id: 'a', status: 'done' }),
            criterion({ id: 'b', status: 'open' }),
        ]);
        const b = dodProgressSignature([
            criterion({ id: 'b', status: 'open' }),
            criterion({ id: 'a', status: 'done' }),
        ]);
        expect(a).toEqual(b);
    });

    it('ignores proposed criteria', () => {
        const withoutProposal = dodProgressSignature([criterion({ id: 'a', status: 'open' })]);
        const withProposal = dodProgressSignature([
            criterion({ id: 'a', status: 'open' }),
            criterion({ id: 'p', status: 'open', proposed: true }),
        ]);
        expect(withoutProposal).toEqual(withProposal);
    });
});

describe('validateDoDCriteria', () => {
    it('accepts null and a well-formed list', () => {
        expect(validateDoDCriteria(null)).toEqual([]);
        expect(validateDoDCriteria([criterion()])).toEqual([]);
    });

    it('rejects a non-array', () => {
        expect(validateDoDCriteria({ id: 'a' })).toEqual([
            { field: 'dodCriteria', message: 'dodCriteria must be an array' },
        ]);
    });

    it('reports EVERY problem at once rather than the first', () => {
        const errors = validateDoDCriteria([
            { id: '', text: 'x', status: 'open' },
            { id: 'dup', text: '', status: 'nope' },
            { id: 'dup', text: 'ok', status: 'open' },
        ]);
        const messages = errors.map((e) => e.message);
        expect(messages).toEqual(
            expect.arrayContaining([
                'every criterion needs a non-empty id',
                "criterion 'dup' needs non-empty text",
                expect.stringContaining("criterion 'dup' status must be one of"),
                "duplicate criterion id 'dup'",
            ]),
        );
    });

    it('rejects over-long text and over-large lists', () => {
        const longText = 'x'.repeat(MAX_DOD_TEXT_CHARS + 1);
        expect(validateDoDCriteria([criterion({ text: longText })])[0].message).toContain(
            'exceeds',
        );

        const tooMany = Array.from({ length: MAX_GOAL_DOD_CRITERIA + 1 }, (_, i) =>
            criterion({ id: `c${i}` }),
        );
        expect(validateDoDCriteria(tooMany).map((e) => e.message)).toEqual(
            expect.arrayContaining([`at most ${MAX_GOAL_DOD_CRITERIA} criteria are allowed`]),
        );
    });

    it('rejects an unknown source', () => {
        const errors = validateDoDCriteria([
            criterion({ source: 'robot' as GoalDoDCriterion['source'] }),
        ]);
        expect(errors[0].message).toContain('source must be one of');
    });
});

describe('normalizeDoDCriteria', () => {
    const now = new Date('2026-08-15T10:00:00.000Z');

    it('trims text, defaults the source, and stamps updatedAt', () => {
        const [normalized] = normalizeDoDCriteria([criterion({ text: '  Ship it  ' })], now);
        expect(normalized.text).toBe('Ship it');
        expect(normalized.source).toBe('operator');
        expect(normalized.updatedAt).toBe(now.toISOString());
    });

    it('collapses blank evidence / note to null', () => {
        const [normalized] = normalizeDoDCriteria([criterion({ evidence: '   ', note: '' })], now);
        expect(normalized.evidence).toBeNull();
        expect(normalized.note).toBeNull();
    });

    it('omits `proposed` on an approved criterion and keeps it on a proposal', () => {
        const [approved] = normalizeDoDCriteria([criterion()], now);
        expect('proposed' in approved).toBe(false);

        const [proposed] = normalizeDoDCriteria([criterion({ proposed: true })], now);
        expect(proposed.proposed).toBe(true);
    });

    it('drops stray properties that arrived on the wire', () => {
        const [normalized] = normalizeDoDCriteria(
            [{ ...criterion(), hacked: true } as unknown as GoalDoDCriterion],
            now,
        );
        expect(normalized).not.toHaveProperty('hacked');
    });
});
