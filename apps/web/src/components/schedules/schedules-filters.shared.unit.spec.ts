import { describe, expect, it } from 'vitest';
import {
    EMPTY_SCHEDULE_FILTERS,
    filtersFromSearchParams,
    hasActiveFilters,
    pageParamsFor,
    scheduleFilterParams,
} from './schedules-filters.shared';

/**
 * The Schedules list's filter vocabulary — the contract the Activity page, the
 * `/schedules` redirect and the API client all share.
 *
 * Pinned here because it is now written by three places: the server page parses
 * it, the client mirrors it into the address bar, and the retired `/schedules`
 * path forwards it. One of them disagreeing about a name silently drops a
 * filter instead of failing loudly.
 */
describe('schedules-filters.shared', () => {
    it('round-trips every filter through the query string', () => {
        const filters = {
            source: 'data_sync' as const,
            status: 'paused' as const,
            health: 'never-runs' as const,
            agent: '0b7e7c1e-6f6a-4c55-9a4c-1f2b3c4d5e6f',
            activeOnly: true,
            q: 'nightly refresh',
        };
        const params = new URLSearchParams(scheduleFilterParams(filters));
        expect(filtersFromSearchParams(params)).toEqual(filters);
    });

    it('writes nothing for the default state, so an unfiltered list has a clean URL', () => {
        expect(scheduleFilterParams(EMPTY_SCHEDULE_FILTERS)).toEqual([]);
        expect(filtersFromSearchParams(new URLSearchParams())).toEqual(EMPTY_SCHEDULE_FILTERS);
    });

    it('carries "Active only" as active=1 and maps it to the API’s enabledOnly', () => {
        const active = { ...EMPTY_SCHEDULE_FILTERS, activeOnly: true };
        expect(scheduleFilterParams(active)).toEqual([['active', '1']]);
        expect(pageParamsFor(active)).toEqual({ enabledOnly: true });
        // Anything but the one spelling reads as off, never as a bad request.
        expect(filtersFromSearchParams(new URLSearchParams('active=true')).activeOnly).toBe(false);
        expect(filtersFromSearchParams(new URLSearchParams('active=1')).activeOnly).toBe(true);
    });

    it('drops unknown or malformed values instead of forwarding them', () => {
        const filters = filtersFromSearchParams(
            new URLSearchParams(
                'source=galaxy&status=exploded&health=maybe&agent=not-a-uuid&q=' + 'x'.repeat(200),
            ),
        );
        expect(filters.source).toBe('');
        expect(filters.status).toBe('');
        expect(filters.health).toBe('');
        expect(filters.agent).toBe('');
        // The search term is clipped, not rejected.
        expect(filters.q).toHaveLength(120);
    });

    it('counts "Active only" as an active filter, so the list offers a way to clear it', () => {
        expect(hasActiveFilters(EMPTY_SCHEDULE_FILTERS)).toBe(false);
        expect(hasActiveFilters({ ...EMPTY_SCHEDULE_FILTERS, activeOnly: true })).toBe(true);
    });

    it('maps each filter onto its own API parameter', () => {
        expect(
            pageParamsFor({
                source: 'inbound_trigger',
                status: 'active',
                health: 'ok',
                agent: '0b7e7c1e-6f6a-4c55-9a4c-1f2b3c4d5e6f',
                activeOnly: false,
                q: 'hook',
            }),
        ).toEqual({
            sourceType: 'inbound_trigger',
            status: 'active',
            health: 'ok',
            agentId: '0b7e7c1e-6f6a-4c55-9a4c-1f2b3c4d5e6f',
            q: 'hook',
        });
    });
});
