import { describe, expect, it } from 'vitest';
import {
    toArray,
    labelize,
    money,
    groupCountChart,
    boardArtifact,
    countStat,
} from './reports-aggregate';

describe('toArray', () => {
    it('returns an array as-is', () => {
        expect(toArray([{ a: 1 }])).toEqual([{ a: 1 }]);
    });
    it('unwraps a { data: [] } envelope', () => {
        expect(toArray({ data: [{ a: 1 }] })).toEqual([{ a: 1 }]);
    });
    it('unwraps a { history: [] } envelope', () => {
        expect(toArray({ history: [{ a: 1 }], total: 1 })).toEqual([{ a: 1 }]);
    });
    it('falls back to the first array-valued property', () => {
        expect(toArray({ meta: {}, foo: [{ x: 1 }] })).toEqual([{ x: 1 }]);
    });
    it('returns [] for non-collections', () => {
        expect(toArray(null)).toEqual([]);
        expect(toArray(42)).toEqual([]);
        expect(toArray({ a: 1 })).toEqual([]);
    });
});

describe('labelize', () => {
    it('title-cases snake/kebab case', () => {
        expect(labelize('in_progress')).toBe('In Progress');
        expect(labelize('work-agent')).toBe('Work Agent');
    });
    it('maps empty / null / undefined to Unknown', () => {
        expect(labelize(undefined)).toBe('Unknown');
        expect(labelize(null)).toBe('Unknown');
        expect(labelize('')).toBe('Unknown');
    });
});

describe('money', () => {
    it('converts cents to dollars', () => {
        expect(money(1234)).toBe(12.34);
    });
    it('coerces numeric strings', () => {
        expect(money('500')).toBe(5);
    });
    it('returns 0 for non-numeric input', () => {
        expect(money('nope')).toBe(0);
        expect(money(undefined)).toBe(0);
    });
});

describe('groupCountChart', () => {
    it('counts rows by field', () => {
        const a = groupCountChart('T', [{ s: 'a' }, { s: 'a' }, { s: 'b' }], 's', 'bar');
        expect(a.kind).toBe('chart');
        if (a.kind === 'chart') {
            expect(a.chartType).toBe('bar');
            expect(Object.fromEntries(a.data.map((d) => [d.label, d.count]))).toEqual({
                A: 2,
                B: 1,
            });
        }
    });
});

describe('boardArtifact', () => {
    it('orders known statuses and lists cards', () => {
        const a = boardArtifact(
            'Board',
            [
                { status: 'completed', title: 'X' },
                { status: 'draft', name: 'Y' },
            ],
            'status',
        );
        expect(a.kind).toBe('kanban');
        if (a.kind === 'kanban') {
            expect(a.columns.map((c) => c.key)).toEqual(['draft', 'completed']);
            expect(a.columns.find((c) => c.key === 'draft')?.cards[0].title).toBe('Y');
        }
    });
    it('appends unknown statuses after the known ones', () => {
        const a = boardArtifact('B', [{ status: 'weird' }, { status: 'draft' }], 'status');
        if (a.kind === 'kanban') {
            expect(a.columns.map((c) => c.key)).toEqual(['draft', 'weird']);
        }
    });
});

describe('countStat', () => {
    it('counts the rows', () => {
        const a = countStat('S', [{}, {}, {}], 'Things');
        expect(a.kind).toBe('stat');
        if (a.kind === 'stat') {
            expect(a.stats[0].value).toBe(3);
            expect(a.stats[0].label).toBe('Things');
        }
    });
});
