import { describe, expect, it } from 'vitest';
import {
    EMPTY_MEMORY_FACT_LIST,
    buildMemoryFactsQuery,
    refusalMessage,
    settleInitialMemoryFacts,
    viewFilter,
    viewOfFact,
    type MemoryFactListDto,
} from './memory-facts-types';

describe('settleInitialMemoryFacts', () => {
    it('passes a loaded page through, marked as loaded — even an empty one', async () => {
        const empty: MemoryFactListDto = {
            facts: [],
            total: 0,
            counts: { active: 0, proposed: 0, forgotten: 0, pinned: 0 },
            semantic: true,
        };
        await expect(settleInitialMemoryFacts(Promise.resolve(empty))).resolves.toEqual({
            facts: empty,
            loadFailed: false,
        });
    });

    it('never rejects, and tells a failed load apart from an empty workspace', async () => {
        await expect(
            settleInitialMemoryFacts(Promise.reject(new Error('API unavailable'))),
        ).resolves.toEqual({ facts: EMPTY_MEMORY_FACT_LIST, loadFailed: true });
    });
});

describe('memory facts query helpers', () => {
    it('maps each view onto the API status / pinned filter', () => {
        expect(viewFilter('all')).toEqual({ status: 'active', pinnedOnly: false });
        expect(viewFilter('pinned')).toEqual({ status: 'active', pinnedOnly: true });
        expect(viewFilter('proposed')).toEqual({ status: 'proposed', pinnedOnly: false });
        expect(viewFilter('forgotten')).toEqual({ status: 'forgotten', pinnedOnly: false });
        expect(viewFilter()).toEqual({ status: 'active', pinnedOnly: false });
    });

    it('builds a query string, trimming the search and omitting empty values', () => {
        expect(buildMemoryFactsQuery()).toBe('?status=active');
        expect(
            buildMemoryFactsQuery({ q: '  delivery promises ', view: 'pinned', limit: 50 }),
        ).toBe('?q=delivery+promises&status=active&pinnedOnly=true&limit=50');
        expect(buildMemoryFactsQuery({ q: '   ', view: 'forgotten', cursor: 'abc' })).toBe(
            '?status=forgotten&cursor=abc',
        );
    });

    it('places a fact in its view', () => {
        expect(viewOfFact({ status: 'active', pinned: true })).toBe('all');
        expect(viewOfFact({ status: 'proposed', pinned: false })).toBe('proposed');
        expect(viewOfFact({ status: 'forgotten', pinned: false })).toBe('forgotten');
    });

    it('extracts a presentable refusal message from every API error shape', () => {
        expect(refusalMessage({ message: 'Memory is full' })).toBe('Memory is full');
        expect(refusalMessage({ message: ['body must be a string'] })).toBe(
            'body must be a string',
        );
        expect(refusalMessage({ message: { message: 'nested' } })).toBe('nested');
        expect(refusalMessage({ message: '  ' })).toBeNull();
        expect(refusalMessage(null)).toBeNull();
        expect(refusalMessage('text')).toBeNull();
    });
});
