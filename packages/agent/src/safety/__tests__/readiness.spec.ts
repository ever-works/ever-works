import {
    LADDERED_CATEGORIES,
    READINESS_MIN_DECISIONS,
    type LadderedActionCategory,
    type ReadinessDecisionSample,
} from '@ever-works/contracts';
import { computeReadiness, type ComputeReadinessInput } from '../readiness';

const NOW = new Date('2026-09-16T12:00:00.000Z');

function samples(
    count: number,
    outcome: ReadinessDecisionSample['outcome'],
    category: LadderedActionCategory = 'message.external',
    daysAgo = 1,
): ReadinessDecisionSample[] {
    const decidedAt = new Date(NOW.getTime() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
    return Array.from({ length: count }, () => ({ category, outcome, decidedAt }));
}

function readinessFor(
    decisions: ReadinessDecisionSample[],
    extra: Partial<ComputeReadinessInput> = {},
) {
    const result = computeReadiness({
        decisions,
        now: NOW,
        currentRungs: { 'message.external': 'draft' },
        ...extra,
    });
    return result.find((entry) => entry.category === 'message.external')!;
}

describe('computeReadiness', () => {
    it('reports every laddered category, in ladder order', () => {
        const result = computeReadiness({ decisions: [], now: NOW });
        expect(result.map((entry) => entry.category)).toEqual([...LADDERED_CATEGORIES]);
    });

    it('is not ready with nothing answered, and says why', () => {
        const entry = readinessFor([]);
        expect(entry.ready).toBe(false);
        expect(entry.blockedBy).toBe('too-few-decisions');
        expect(entry.approvalRate).toBe(0);
    });

    it('is ready at exactly the thresholds', () => {
        // 20 answered, 100% approved, none withdrawn, no other refusals.
        const entry = readinessFor(samples(READINESS_MIN_DECISIONS, 'approved'));
        expect(entry.answered).toBe(20);
        expect(entry.ready).toBe(true);
        expect(entry.blockedBy).toBeNull();
    });

    it('is not ready one decision short', () => {
        const entry = readinessFor(samples(READINESS_MIN_DECISIONS - 1, 'approved'));
        expect(entry.ready).toBe(false);
        expect(entry.blockedBy).toBe('too-few-decisions');
    });

    it('is ready at exactly a 95% approval rate', () => {
        const entry = readinessFor([...samples(95, 'approved'), ...samples(5, 'rejected')]);
        expect(entry.approvalRate).toBeCloseTo(0.95, 10);
        expect(entry.ready).toBe(true);
    });

    it('is not ready just below it', () => {
        const entry = readinessFor([...samples(94, 'approved'), ...samples(6, 'rejected')]);
        expect(entry.ready).toBe(false);
        expect(entry.blockedBy).toBe('approval-rate');
    });

    it('is not ready with a single withdrawal', () => {
        const entry = readinessFor([...samples(40, 'approved'), ...samples(1, 'withdrawn')]);
        expect(entry.withdrawn).toBe(1);
        expect(entry.ready).toBe(false);
        expect(entry.blockedBy).toBe('withdrawn');
    });

    it('is not ready when another rail refused something in the category', () => {
        const entry = readinessFor(samples(40, 'approved'), {
            otherRefusalsByCategory: { 'message.external': 1 },
        });
        expect(entry.ready).toBe(false);
        expect(entry.blockedBy).toBe('other-refusals');
    });

    it('ignores decisions outside the 30-day window', () => {
        const entry = readinessFor(samples(40, 'approved', 'message.external', 31));
        expect(entry.answered).toBe(0);
        expect(entry.blockedBy).toBe('too-few-decisions');
    });

    it('ignores a decision dated in the future', () => {
        const future = new Date(NOW.getTime() + 60_000).toISOString();
        const entry = readinessFor([
            ...samples(40, 'approved'),
            { category: 'message.external', outcome: 'rejected', decidedAt: future },
        ]);
        expect(entry.answered).toBe(40);
    });

    it('ignores an undateable decision rather than throwing', () => {
        const entry = readinessFor([
            ...samples(40, 'approved'),
            { category: 'message.external', outcome: 'rejected', decidedAt: 'not a date' },
        ]);
        expect(entry.answered).toBe(40);
    });

    it('names the rung a promotion would reach', () => {
        const entry = readinessFor(samples(40, 'approved'));
        expect(entry.nextRung).toBe('ask');
    });

    it('answers at-ceiling first, because no record changes that', () => {
        const result = computeReadiness({
            decisions: samples(40, 'approved'),
            now: NOW,
            currentRungs: { 'message.external': 'ask' },
        });
        const entry = result.find((row) => row.category === 'message.external')!;
        expect(entry.nextRung).toBeNull();
        expect(entry.blockedBy).toBe('at-ceiling');
        expect(entry.ready).toBe(false);
    });

    it('never applies anything — it only reports', () => {
        // FR-35/FR-36. The return type is a list of DTOs; there is nothing to
        // write and no writer is reachable from here.
        const result = computeReadiness({ decisions: samples(40, 'approved'), now: NOW });
        expect(Array.isArray(result)).toBe(true);
        for (const entry of result) expect(typeof entry.ready).toBe('boolean');
    });
});
