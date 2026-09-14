import {
    compareHits,
    FRESH_WINDOW_MS,
    isSubsequence,
    KIND_PRIORITY,
    orderAndCutGroups,
    scoreCandidate,
    type RankableHit,
} from '../ranking';
import { WORKSPACE_SEARCH_KINDS } from '@ever-works/contracts/api';

const NOW = new Date('2026-09-10T12:00:00.000Z');
const OLD = new Date('2026-01-01T00:00:00.000Z');

function score(input: Parameters<typeof scoreCandidate>[0]) {
    return scoreCandidate({ updatedAt: OLD, now: NOW, ...input });
}

describe('workspace-search ranking — score bands (FR-14)', () => {
    it.each([
        ['exact title', { query: 'Invoice', title: 'invoice' }, 100, 'exact'],
        [
            'exact identifier',
            { query: 't-418', title: 'Draft follow-up', identifier: 'T-418' },
            100,
            'exact',
        ],
        ['prefix', { query: 'inv', title: 'Invoice reconciliation' }, 90, 'prefix'],
        ['word prefix', { query: 'recon', title: 'Invoice reconciliation' }, 80, 'wordPrefix'],
        ['contains', { query: 'voice', title: 'Invoice reconciliation' }, 65, 'contains'],
        [
            'identifier contains',
            { query: '418', title: 'Draft', identifier: 'T-418' },
            60,
            'identifier',
        ],
        [
            'secondary',
            { query: 'supplier', title: 'Intake', secondary: ['From the supplier'] },
            40,
            'secondary',
        ],
        ['fuzzy subsequence', { query: 'ivrc', title: 'Invoice reconciliation' }, 25, 'fuzzy'],
    ] as const)('%s', (_name, input, expectedScore, expectedReason) => {
        expect(score(input)).toEqual({ score: expectedScore, matchReason: expectedReason });
    });

    it('folds diacritics on both sides', () => {
        expect(score({ query: 'cafe', title: 'Café' })).toEqual({
            score: 100,
            matchReason: 'exact',
        });
        expect(score({ query: 'CAFÉ', title: 'cafe menu' })).toEqual({
            score: 90,
            matchReason: 'prefix',
        });
    });

    it('returns null when nothing matches', () => {
        expect(
            score({ query: 'zzzqqq', title: 'Invoice', identifier: 'inv', secondary: ['x'] }),
        ).toBeNull();
    });

    it('does not fuzzy-match below three characters', () => {
        expect(score({ query: 'ir', title: 'Invoice reconciliation' })).toBeNull();
    });

    it('returns null for an empty query', () => {
        expect(score({ query: '   ', title: 'anything' })).toBeNull();
    });

    it('ranks exact above prefix above substring above fuzzy for one fixture set', () => {
        const titles = ['plan', 'planner', 'the plan', 'explanation', 'p-l-a-n'];
        const results = titles.map((title) => ({ title, result: score({ query: 'plan', title }) }));
        expect(results.map((r) => r.result?.matchReason)).toEqual([
            'exact',
            'prefix',
            'wordPrefix',
            'contains',
            'fuzzy',
        ]);
        const scores = results.map((r) => r.result?.score ?? 0);
        expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    });
});

describe('workspace-search ranking — boosts (FR-14)', () => {
    it('adds +10 for a recently opened record', () => {
        expect(score({ query: 'voice', title: 'Invoice', recentlyOpened: true })?.score).toBe(75);
    });

    it('adds +5 for a record changed in the last 24 hours', () => {
        const fresh = new Date(NOW.getTime() - FRESH_WINDOW_MS + 1000);
        expect(score({ query: 'voice', title: 'Invoice', updatedAt: fresh })?.score).toBe(70);
    });

    it('does not boost a record changed more than 24 hours ago', () => {
        const stale = new Date(NOW.getTime() - FRESH_WINDOW_MS - 1000);
        expect(score({ query: 'voice', title: 'Invoice', updatedAt: stale })?.score).toBe(65);
    });

    it('stacks both boosts', () => {
        expect(
            score({ query: 'voice', title: 'Invoice', recentlyOpened: true, updatedAt: NOW })
                ?.score,
        ).toBe(80);
    });

    it('caps the score at 100', () => {
        expect(
            score({ query: 'inv', title: 'Invoice', recentlyOpened: true, updatedAt: NOW })?.score,
        ).toBe(100);
        expect(
            score({ query: 'invoice', title: 'Invoice', recentlyOpened: true, updatedAt: NOW })
                ?.score,
        ).toBe(100);
    });
});

describe('workspace-search ranking — tie-breaks (FR-15)', () => {
    const hit = (overrides: Partial<RankableHit>): RankableHit => ({
        kind: 'task',
        title: 'Alpha',
        score: 50,
        updatedAt: '2026-09-01T00:00:00.000Z',
        ...overrides,
    });

    it('orders by score first', () => {
        const sorted = [hit({ title: 'low', score: 40 }), hit({ title: 'high', score: 90 })].sort(
            compareHits,
        );
        expect(sorted.map((h) => h.title)).toEqual(['high', 'low']);
    });

    it('then by most recently changed', () => {
        const sorted = [
            hit({ title: 'older', updatedAt: '2026-01-01T00:00:00.000Z' }),
            hit({ title: 'newer', updatedAt: '2026-09-09T00:00:00.000Z' }),
            hit({ title: 'unknown', updatedAt: null }),
        ].sort(compareHits);
        expect(sorted.map((h) => h.title)).toEqual(['newer', 'older', 'unknown']);
    });

    it('then by kind priority', () => {
        const sorted = [
            hit({ kind: 'knowledge' }),
            hit({ kind: 'mission' }),
            hit({ kind: 'task' }),
        ].sort(compareHits);
        expect(sorted.map((h) => h.kind)).toEqual(['mission', 'task', 'knowledge']);
    });

    it('then by display name ascending, case-insensitively', () => {
        const sorted = [
            hit({ title: 'beta' }),
            hit({ title: 'Alpha' }),
            hit({ title: 'alpha 2' }),
        ].sort(compareHits);
        expect(sorted.map((h) => h.title)).toEqual(['Alpha', 'alpha 2', 'beta']);
    });

    it('lists every contract kind in KIND_PRIORITY exactly once', () => {
        expect([...KIND_PRIORITY].sort()).toEqual([...WORKSPACE_SEARCH_KINDS].sort());
    });
});

describe('workspace-search ranking — grouping and caps (FR-16 / FR-17)', () => {
    const make = (kind: RankableHit['kind'], count: number, topScore = 50) =>
        Array.from({ length: count }, (_, index) => ({
            kind,
            title: `${kind} ${index}`,
            score: index === 0 ? topScore : 40,
            updatedAt: null,
        }));

    it('orders groups by kind priority', () => {
        const groups = orderAndCutGroups(
            [
                { kind: 'knowledge', total: 1, hits: make('knowledge', 1) },
                { kind: 'task', total: 1, hits: make('task', 1) },
                { kind: 'mission', total: 1, hits: make('mission', 1) },
            ],
            { perKindLimit: 5, limit: 60 },
        );
        expect(groups.map((g) => g.kind)).toEqual(['mission', 'task', 'knowledge']);
    });

    it('promotes a group holding a score-100 hit to the top', () => {
        const groups = orderAndCutGroups(
            [
                { kind: 'mission', total: 1, hits: make('mission', 1) },
                { kind: 'skill', total: 1, hits: make('skill', 1, 100) },
            ],
            { perKindLimit: 5, limit: 60 },
        );
        expect(groups.map((g) => g.kind)).toEqual(['skill', 'mission']);
    });

    it('keeps Missions and Tasks as two separate groups', () => {
        const groups = orderAndCutGroups(
            [
                { kind: 'task', total: 2, hits: make('task', 2) },
                { kind: 'mission', total: 1, hits: make('mission', 1) },
            ],
            { perKindLimit: 5, limit: 60 },
        );
        expect(groups).toHaveLength(2);
        expect(groups[0].hits.every((h) => h.kind === 'mission')).toBe(true);
        expect(groups[1].hits.every((h) => h.kind === 'task')).toBe(true);
    });

    it('cuts each group to perKindLimit while keeping the pre-cap total', () => {
        const [group] = orderAndCutGroups([{ kind: 'task', total: 137, hits: make('task', 30) }], {
            perKindLimit: 5,
            limit: 60,
        });
        expect(group.hits).toHaveLength(5);
        expect(group.total).toBe(137);
        expect(group.hits[0].score).toBe(50);
    });

    it('never returns more than `limit` rows in total', () => {
        const groups = orderAndCutGroups(
            (['mission', 'task', 'agent', 'work'] as const).map((kind) => ({
                kind,
                total: 25,
                hits: make(kind, 25),
            })),
            { perKindLimit: 25, limit: 60 },
        );
        expect(groups.reduce((sum, g) => sum + g.hits.length, 0)).toBe(60);
        expect(groups.map((g) => g.hits.length)).toEqual([25, 25, 10]);
    });

    it('drops empty groups', () => {
        expect(
            orderAndCutGroups([{ kind: 'task', total: 0, hits: [] }], {
                perKindLimit: 5,
                limit: 60,
            }),
        ).toEqual([]);
    });
});

describe('isSubsequence', () => {
    it.each([
        ['abc', 'a-b-c', true],
        ['abc', 'acb', false],
        ['', 'abc', false],
        ['abc', 'ab', false],
    ])('%j in %j → %j', (needle, haystack, expected) => {
        expect(isSubsequence(needle, haystack)).toBe(expected);
    });
});
