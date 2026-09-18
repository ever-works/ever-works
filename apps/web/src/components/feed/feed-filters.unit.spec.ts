import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
    EMPTY_FEED_FILTERS,
    FEED_FILTER_STORAGE_KEY,
    feedFiltersToQuery,
    hasFeedFilterParams,
    isFeedFiltered,
    normalizeFeedFilters,
    parseFeedFilters,
    readStoredFeedFilters,
    toggleFeedAgent,
    toggleFeedKind,
    writeStoredFeedFilters,
} from './feed-filters';
import { feedTargetHref } from './feed-href';
import { describeFeedTime } from './feed-time';

const IVY = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const WREN = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const agent = (i: number) => `cccccccc-cccc-4ccc-8ccc-${String(i).padStart(12, '0')}`;

describe('feed filters', () => {
    it('round-trips through the URL', () => {
        const state = {
            agentIds: [IVY, WREN],
            kinds: ['problem', 'work'] as const,
            failedOnly: true,
        };
        const query = feedFiltersToQuery({ ...state, kinds: [...state.kinds] });
        const params = new URLSearchParams(query);
        expect(hasFeedFilterParams(params)).toBe(true);
        expect(parseFeedFilters(params)).toEqual({
            agentIds: [IVY, WREN],
            kinds: ['work', 'problem'],
            failedOnly: true,
        });
    });

    it('produces no query for the unfiltered view', () => {
        expect(feedFiltersToQuery(EMPTY_FEED_FILTERS)).toBe('');
        expect(isFeedFiltered(EMPTY_FEED_FILTERS)).toBe(false);
        expect(hasFeedFilterParams(new URLSearchParams('view=feed'))).toBe(false);
    });

    it('drops malformed agent ids and unknown kinds from a hand-edited URL', () => {
        expect(
            parseFeedFilters(
                new URLSearchParams(`agents=${IVY},nope,${IVY}&kinds=work,everything&failed=yes`),
            ),
        ).toEqual({
            agentIds: [IVY],
            kinds: ['work'],
            failedOnly: false,
        });
    });

    it('never keeps more than 20 agents from a URL', () => {
        const ids = Array.from({ length: 25 }, (_, i) => agent(i));
        expect(normalizeFeedFilters({ agentIds: ids }).agentIds).toHaveLength(20);
    });

    it('counts two spellings of one agent id once toward the limit', () => {
        const ids = Array.from({ length: 20 }, (_, i) => agent(i));
        // The upper-case copy of the first id must not cost the last agent its slot.
        const withDuplicate = [ids[0], ids[0].toUpperCase(), ...ids.slice(1)];
        expect(normalizeFeedFilters({ agentIds: withDuplicate }).agentIds).toEqual(ids);
        expect(normalizeFeedFilters({ agentIds: [IVY.toUpperCase(), IVY] }).agentIds).toEqual([
            IVY,
        ]);
    });

    it('refuses a 21st agent instead of truncating', () => {
        const full = {
            ...EMPTY_FEED_FILTERS,
            agentIds: Array.from({ length: 20 }, (_, i) => agent(i)),
        };
        const refused = toggleFeedAgent(full, IVY);
        expect(refused.refused).toBe(true);
        expect(refused.state).toBe(full);

        const removed = toggleFeedAgent(full, agent(3));
        expect(removed.refused).toBe(false);
        expect(removed.state.agentIds).toHaveLength(19);
    });

    it('toggles kinds keeping the canonical order', () => {
        const once = toggleFeedKind(EMPTY_FEED_FILTERS, 'system');
        const twice = toggleFeedKind(once, 'work');
        expect(twice.kinds).toEqual(['work', 'system']);
        expect(toggleFeedKind(twice, 'work').kinds).toEqual(['system']);
    });

    describe('saved filters', () => {
        it('stores filtered state and clears the key when unfiltered', () => {
            const storage = { setItem: vi.fn(), removeItem: vi.fn(), getItem: vi.fn() };
            writeStoredFeedFilters(storage, { ...EMPTY_FEED_FILTERS, kinds: ['problem'] });
            expect(storage.setItem).toHaveBeenCalledWith(
                FEED_FILTER_STORAGE_KEY,
                expect.stringContaining('problem'),
            );
            writeStoredFeedFilters(storage, EMPTY_FEED_FILTERS);
            expect(storage.removeItem).toHaveBeenCalledWith(FEED_FILTER_STORAGE_KEY);
        });

        it('survives corrupt JSON and a throwing storage', () => {
            expect(readStoredFeedFilters({ getItem: () => '{not json' })).toBeNull();
            expect(
                readStoredFeedFilters({
                    getItem: () => {
                        throw new Error('denied');
                    },
                }),
            ).toBeNull();
            expect(() =>
                writeStoredFeedFilters(
                    {
                        setItem: () => {
                            throw new Error('quota');
                        },
                        removeItem: () => undefined,
                    },
                    { ...EMPTY_FEED_FILTERS, failedOnly: true },
                ),
            ).not.toThrow();
            expect(readStoredFeedFilters(undefined)).toBeNull();
        });

        it('normalizes what it reads back', () => {
            expect(
                readStoredFeedFilters({
                    getItem: () =>
                        JSON.stringify({
                            agentIds: [IVY, 'x'],
                            kinds: ['bogus'],
                            failedOnly: 'true',
                        }),
                }),
            ).toEqual({ agentIds: [IVY], kinds: [], failedOnly: false });
        });
    });
});

describe('feed destinations', () => {
    it('maps each target type onto the product route', () => {
        expect(feedTargetHref({ type: 'run', id: 'r1' })).toBe('/agents/activity/r1');
        expect(feedTargetHref({ type: 'task', id: 't1' })).toBe('/tasks/t1');
        expect(feedTargetHref({ type: 'mission', id: 'm1' })).toBe('/missions/m1');
        expect(feedTargetHref({ type: 'idea', id: 'i1' })).toBe('/ideas/i1');
        expect(feedTargetHref({ type: 'agent', id: 'a1' })).toBe('/agents/a1');
        expect(feedTargetHref({ type: 'work', id: 'w1' })).toBe('/works/w1');
        expect(feedTargetHref({ type: 'skill', id: 's1' })).toBe('/skills/s1');
        expect(feedTargetHref({ type: 'inbox', id: 'n1' })).toBe('/inbox?id=n1');
    });

    it('has nothing to open without a target, and encodes ids', () => {
        expect(feedTargetHref(null)).toBeNull();
        expect(feedTargetHref({ type: 'task', id: '' })).toBeNull();
        expect(feedTargetHref({ type: 'task', id: 'a/../b' })).toBe('/tasks/a%2F..%2Fb');
    });
});

describe('feed relative time', () => {
    const now = new Date(2026, 8, 13, 12, 0, 0);
    const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();

    it('walks through just now, minutes, hours, yesterday, this week and a date', () => {
        expect(describeFeedTime(ago(20_000), now, 'en').kind).toBe('justNow');
        expect(describeFeedTime(ago(4 * 60_000), now, 'en')).toEqual({
            kind: 'minutesAgo',
            count: 4,
        });
        expect(describeFeedTime(ago(2 * 3_600_000), now, 'en')).toEqual({
            kind: 'hoursAgo',
            count: 2,
        });
        expect(describeFeedTime(new Date(2026, 8, 12, 18, 4).toISOString(), now, 'en').kind).toBe(
            'yesterdayAt',
        );
        expect(describeFeedTime(new Date(2026, 8, 9, 9, 0).toISOString(), now, 'en').kind).toBe(
            'withinWeek',
        );
        expect(describeFeedTime(new Date(2026, 7, 1, 9, 0).toISOString(), now, 'en').kind).toBe(
            'absolute',
        );
    });

    it('keeps "this week" to the six calendar days before yesterday', () => {
        // Same weekday a week ago, a little later in the day: under seven
        // 24-hour days, but naming the weekday would read as today's.
        expect(describeFeedTime(new Date(2026, 8, 6, 14, 0).toISOString(), now, 'en').kind).toBe(
            'absolute',
        );
        expect(describeFeedTime(new Date(2026, 8, 7, 0, 5).toISOString(), now, 'en').kind).toBe(
            'withinWeek',
        );
    });

    describe('across a daylight-saving change', () => {
        let previousTz: string | undefined;
        beforeAll(() => {
            previousTz = process.env.TZ;
            process.env.TZ = 'America/New_York';
        });
        afterAll(() => {
            if (previousTz === undefined) delete process.env.TZ;
            else process.env.TZ = previousTz;
        });

        it('runs in a zone that really changes its clocks', () => {
            // Guards the two cases below: without a real 25-hour and 23-hour
            // day they would pass for the wrong reason.
            expect(new Date(2026, 10, 2).getTime() - new Date(2026, 10, 1).getTime()).toBe(
                25 * 3_600_000,
            );
            expect(new Date(2026, 2, 9).getTime() - new Date(2026, 2, 8).getTime()).toBe(
                23 * 3_600_000,
            );
        });

        it('calls the whole of a 25-hour day "yesterday"', () => {
            const afterFallBack = new Date(2026, 10, 2, 12, 0);
            const earlyYesterday = new Date(2026, 10, 1, 0, 30).toISOString();
            expect(describeFeedTime(earlyYesterday, afterFallBack, 'en').kind).toBe('yesterdayAt');
        });

        it('does not call the day before a 23-hour day "yesterday"', () => {
            const afterSpringForward = new Date(2026, 2, 9, 12, 0);
            const twoDaysAgo = new Date(2026, 2, 7, 23, 30).toISOString();
            expect(describeFeedTime(twoDaysAgo, afterSpringForward, 'en').kind).toBe('withinWeek');
        });
    });

    it('treats a future or unreadable timestamp as just now', () => {
        expect(
            describeFeedTime(new Date(now.getTime() + 60_000).toISOString(), now, 'en').kind,
        ).toBe('justNow');
        expect(describeFeedTime('not a date', now, 'en').kind).toBe('justNow');
    });
});
