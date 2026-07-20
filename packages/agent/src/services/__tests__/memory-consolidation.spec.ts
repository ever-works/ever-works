/**
 * Unit tests for the Memory Consolidation pure helpers
 * (`services/memory-consolidation.ts`): promotion scoring, near-duplicate
 * grouping, and promotion selection. No IO — everything is deterministic
 * (the score clock is pinned via the `now` parameter).
 */
import {
    DEFAULT_PROMOTION_LIMIT,
    DUPLICATE_JACCARD_THRESHOLD,
    findDuplicateGroups,
    SCORE_ALWAYS_INJECT_BONUS,
    SCORE_RECENCY_WEIGHT,
    SCORE_SUBSTANCE_WEIGHT,
    scoreMemoryDocument,
    selectPromotions,
} from '../memory-consolidation';

const NOW = new Date('2026-07-01T00:00:00.000Z');

function daysAgo(days: number): Date {
    return new Date(NOW.getTime() - days * 86_400_000);
}

describe('scoreMemoryDocument', () => {
    const base = { updatedAt: NOW, bodyLength: 0, tagCount: 0 };

    it('parts always sum to the total score', () => {
        const inputs = [
            { updatedAt: NOW, bodyLength: 5000, tagCount: 3, alwaysInject: true, citationCount: 2 },
            { updatedAt: daysAgo(90), bodyLength: 10, tagCount: 0 },
            { updatedAt: daysAgo(400), bodyLength: 100_000, tagCount: 99, citationCount: 99 },
            { updatedAt: 'not-a-date', bodyLength: 0, tagCount: 0 },
        ];
        for (const input of inputs) {
            const { score, parts } = scoreMemoryDocument(input, NOW);
            const sum = Object.values(parts).reduce((acc, v) => acc + v, 0);
            expect(score).toBeCloseTo(sum, 10);
            expect(Object.keys(parts).sort()).toEqual([
                'organization',
                'recency',
                'substance',
                'usage',
            ]);
        }
    });

    it('recency: fresh docs score the full weight, decaying by half-life', () => {
        const fresh = scoreMemoryDocument(base, NOW);
        expect(fresh.parts.recency).toBeCloseTo(SCORE_RECENCY_WEIGHT, 5);

        const halfLife = scoreMemoryDocument({ ...base, updatedAt: daysAgo(30) }, NOW);
        expect(halfLife.parts.recency).toBeCloseTo(SCORE_RECENCY_WEIGHT / 2, 5);

        const twoHalfLives = scoreMemoryDocument({ ...base, updatedAt: daysAgo(60) }, NOW);
        expect(twoHalfLives.parts.recency).toBeCloseTo(SCORE_RECENCY_WEIGHT / 4, 5);
    });

    it('recency: monotonically decreases with age', () => {
        let previous = Infinity;
        for (const age of [0, 1, 7, 30, 90, 365]) {
            const { parts } = scoreMemoryDocument({ ...base, updatedAt: daysAgo(age) }, NOW);
            expect(parts.recency).toBeLessThanOrEqual(previous);
            previous = parts.recency;
        }
    });

    it('recency: future timestamps clamp to the cap; invalid dates score zero', () => {
        const future = scoreMemoryDocument({ ...base, updatedAt: daysAgo(-10) }, NOW);
        expect(future.parts.recency).toBe(SCORE_RECENCY_WEIGHT);

        const invalid = scoreMemoryDocument({ ...base, updatedAt: 'garbage' }, NOW);
        expect(invalid.parts.recency).toBe(0);
    });

    it('substance: zero body scores zero, grows log-scaled, caps at the weight', () => {
        const empty = scoreMemoryDocument({ ...base, bodyLength: 0 }, NOW);
        expect(empty.parts.substance).toBe(0);

        const small = scoreMemoryDocument({ ...base, bodyLength: 100 }, NOW);
        const medium = scoreMemoryDocument({ ...base, bodyLength: 2000 }, NOW);
        expect(small.parts.substance).toBeGreaterThan(0);
        expect(medium.parts.substance).toBeGreaterThan(small.parts.substance);
        // Log scaling: 20× the length is nowhere near 20× the score.
        expect(medium.parts.substance).toBeLessThan(small.parts.substance * 3);

        const huge = scoreMemoryDocument({ ...base, bodyLength: 1_000_000 }, NOW);
        expect(huge.parts.substance).toBe(SCORE_SUBSTANCE_WEIGHT);

        const negative = scoreMemoryDocument({ ...base, bodyLength: -50 }, NOW);
        expect(negative.parts.substance).toBe(0);
    });

    it('organization: 3 points per tag, capped at 5 tags', () => {
        expect(scoreMemoryDocument({ ...base, tagCount: 0 }, NOW).parts.organization).toBe(0);
        expect(scoreMemoryDocument({ ...base, tagCount: 2 }, NOW).parts.organization).toBe(6);
        expect(scoreMemoryDocument({ ...base, tagCount: 5 }, NOW).parts.organization).toBe(15);
        expect(scoreMemoryDocument({ ...base, tagCount: 50 }, NOW).parts.organization).toBe(15);
        expect(scoreMemoryDocument({ ...base, tagCount: -3 }, NOW).parts.organization).toBe(0);
    });

    it('usage: 2 points per citation capped at 5, plus a flat always-inject bonus', () => {
        expect(scoreMemoryDocument(base, NOW).parts.usage).toBe(0);
        expect(scoreMemoryDocument({ ...base, citationCount: 3 }, NOW).parts.usage).toBe(6);
        expect(scoreMemoryDocument({ ...base, citationCount: 100 }, NOW).parts.usage).toBe(10);
        expect(scoreMemoryDocument({ ...base, alwaysInject: true }, NOW).parts.usage).toBe(
            SCORE_ALWAYS_INJECT_BONUS,
        );
        expect(
            scoreMemoryDocument({ ...base, alwaysInject: true, citationCount: 5 }, NOW).parts.usage,
        ).toBe(10 + SCORE_ALWAYS_INJECT_BONUS);
    });

    it('is deterministic for a pinned clock and bounded by 100', () => {
        const input = {
            updatedAt: NOW,
            bodyLength: 1_000_000,
            tagCount: 99,
            alwaysInject: true,
            citationCount: 99,
        };
        const a = scoreMemoryDocument(input, NOW);
        const b = scoreMemoryDocument(input, NOW);
        expect(a).toEqual(b);
        expect(a.score).toBe(100);
    });
});

describe('findDuplicateGroups', () => {
    /** ~100 words, so a one-word change keeps Jaccard well above 0.85. */
    const LONG_BODY = Array.from({ length: 100 }, (_, i) => `word${i}`).join(' ');

    it('returns no groups for zero or one document', () => {
        expect(findDuplicateGroups([])).toEqual([]);
        expect(
            findDuplicateGroups([{ id: 'a', title: 'Solo', body: 'text', updatedAt: NOW }]),
        ).toEqual([]);
    });

    it('groups documents whose normalized titles match (case / punctuation / whitespace)', () => {
        const groups = findDuplicateGroups([
            {
                id: 'a',
                title: 'Brand  Voice!',
                body: 'alpha beta gamma delta',
                updatedAt: daysAgo(2),
            },
            {
                id: 'b',
                title: 'brand voice',
                body: 'totally different body content here',
                updatedAt: daysAgo(1),
            },
            { id: 'c', title: 'Unrelated', body: 'something else entirely now', updatedAt: NOW },
        ]);
        expect(groups).toEqual([['b', 'a']]);
    });

    it('groups near-identical bodies at/above the Jaccard threshold', () => {
        const modified = `${LONG_BODY.slice(0, LONG_BODY.lastIndexOf(' '))} changed`;
        const groups = findDuplicateGroups([
            { id: 'old', title: 'First take', body: LONG_BODY, updatedAt: daysAgo(5) },
            { id: 'new', title: 'Second take', body: modified, updatedAt: daysAgo(1) },
        ]);
        expect(groups).toEqual([['new', 'old']]);
    });

    it('does not group dissimilar bodies with distinct titles', () => {
        const otherBody = Array.from({ length: 100 }, (_, i) => `other${i}`).join(' ');
        const groups = findDuplicateGroups([
            { id: 'a', title: 'One', body: LONG_BODY, updatedAt: NOW },
            { id: 'b', title: 'Two', body: otherBody, updatedAt: NOW },
        ]);
        expect(groups).toEqual([]);
    });

    it('honours the documented threshold constant', () => {
        expect(DUPLICATE_JACCARD_THRESHOLD).toBe(0.85);
        // ~50% overlap must NOT group.
        const half =
            LONG_BODY.split(' ').slice(0, 50).join(' ') +
            ' ' +
            Array.from({ length: 50 }, (_, i) => `tail${i}`).join(' ');
        const groups = findDuplicateGroups([
            { id: 'a', title: 'One', body: LONG_BODY, updatedAt: NOW },
            { id: 'b', title: 'Two', body: half, updatedAt: NOW },
        ]);
        expect(groups).toEqual([]);
    });

    it('closes the duplicate relation transitively (A~B by title, B~C by body)', () => {
        const groups = findDuplicateGroups([
            {
                id: 'a',
                title: 'Style Guide',
                body: 'completely unrelated body text',
                updatedAt: daysAgo(3),
            },
            { id: 'b', title: 'style guide!!', body: LONG_BODY, updatedAt: daysAgo(2) },
            { id: 'c', title: 'Editorial rules', body: LONG_BODY, updatedAt: daysAgo(1) },
        ]);
        expect(groups).toEqual([['c', 'b', 'a']]);
    });

    it('orders each group newest-first (the survivor) with id-asc tiebreak', () => {
        const sameTime = daysAgo(1);
        const groups = findDuplicateGroups([
            { id: 'z', title: 'Same', body: '', updatedAt: sameTime },
            { id: 'a', title: 'Same', body: '', updatedAt: sameTime },
            { id: 'm', title: 'Same', body: '', updatedAt: daysAgo(9) },
        ]);
        expect(groups).toEqual([['a', 'z', 'm']]);
    });

    it('never treats two empty bodies as body-duplicates', () => {
        const groups = findDuplicateGroups([
            { id: 'a', title: 'Alpha', body: '', updatedAt: NOW },
            { id: 'b', title: 'Beta', body: '   ', updatedAt: NOW },
        ]);
        expect(groups).toEqual([]);
    });

    it('matches short bodies (fewer words than one shingle) when identical', () => {
        const groups = findDuplicateGroups([
            { id: 'a', title: 'One', body: 'Ship it', updatedAt: daysAgo(2) },
            { id: 'b', title: 'Two', body: 'ship IT!', updatedAt: daysAgo(1) },
        ]);
        expect(groups).toEqual([['b', 'a']]);
    });

    it('returns groups in deterministic order (survivor id asc)', () => {
        const docs = [
            { id: 'd', title: 'Pair Two', body: '', updatedAt: daysAgo(1) },
            { id: 'c', title: 'Pair Two', body: '', updatedAt: daysAgo(2) },
            { id: 'b', title: 'Pair One', body: '', updatedAt: daysAgo(1) },
            { id: 'a', title: 'Pair One', body: '', updatedAt: daysAgo(2) },
        ];
        expect(findDuplicateGroups(docs)).toEqual([
            ['b', 'a'],
            ['d', 'c'],
        ]);
        expect(findDuplicateGroups([...docs].reverse())).toEqual([
            ['b', 'a'],
            ['d', 'c'],
        ]);
    });
});

describe('selectPromotions', () => {
    it('selects the top-N by score, descending', () => {
        const scored = [
            { id: 'low', score: 1 },
            { id: 'high', score: 90 },
            { id: 'mid', score: 40 },
        ];
        expect(selectPromotions(scored, 2)).toEqual([
            { id: 'high', score: 90 },
            { id: 'mid', score: 40 },
        ]);
    });

    it('defaults the limit to DEFAULT_PROMOTION_LIMIT', () => {
        const scored = Array.from({ length: DEFAULT_PROMOTION_LIMIT + 5 }, (_, i) => ({
            id: `doc-${String(i).padStart(2, '0')}`,
            score: i,
        }));
        const selected = selectPromotions(scored);
        expect(selected).toHaveLength(DEFAULT_PROMOTION_LIMIT);
        expect(selected[0].score).toBe(DEFAULT_PROMOTION_LIMIT + 4);
    });

    it('breaks score ties by id ascending (stable across input order)', () => {
        const scored = [
            { id: 'b', score: 10 },
            { id: 'a', score: 10 },
            { id: 'c', score: 10 },
        ];
        expect(selectPromotions(scored, 2)).toEqual([
            { id: 'a', score: 10 },
            { id: 'b', score: 10 },
        ]);
        expect(selectPromotions([...scored].reverse(), 2)).toEqual([
            { id: 'a', score: 10 },
            { id: 'b', score: 10 },
        ]);
    });

    it('does not mutate the input and handles empty / non-positive limits', () => {
        const scored = [
            { id: 'b', score: 1 },
            { id: 'a', score: 2 },
        ];
        const snapshot = [...scored];
        selectPromotions(scored, 1);
        expect(scored).toEqual(snapshot);
        expect(selectPromotions([], 5)).toEqual([]);
        expect(selectPromotions(scored, 0)).toEqual([]);
        expect(selectPromotions(scored, -1)).toEqual([]);
    });
});
