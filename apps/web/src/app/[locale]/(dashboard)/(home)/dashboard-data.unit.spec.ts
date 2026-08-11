import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScheduleEntry } from '@/lib/api/schedules';

/**
 * Contract test for the dashboard Soon block's use of `GET /api/schedules`.
 *
 * The block was permanently empty in every environment because of two stacked
 * mismatches with the API, both swallowed by a bare `catch`:
 *
 *   1. it sent `?status=active&sort=nextRunAt:asc&limit=3`; `ScheduleQueryDto`
 *      whitelists only `sourceType`/`entityKind`/`enabledOnly` and the global
 *      pipe runs with `forbidNonWhitelisted`, so the API answered 400;
 *   2. it destructured `{ items, total }`; the handler returns a bare array,
 *      so even with the parameters fixed `items` would be `undefined`.
 *
 * Only the *transport* (`serverFetch`) is mocked here, and it is mocked with a
 * simulator that enforces the real server's rules rather than returning the
 * shape the caller wishes for. A fixture shaped like `{ items, total }` would
 * have passed for the entire life of this bug and proved nothing.
 *
 * The server half of this contract is pinned in
 * `apps/api/src/schedules/dto/schedules-query.dto.spec.ts`, which asserts that
 * {@link API_WHITELISTED_QUERY_PARAMS} below is *exactly* the DTO's filter
 * surface and that anything else is a 400.
 */

const { serverFetch } = vi.hoisted(() => ({ serverFetch: vi.fn() }));
vi.mock('@/lib/api/server-api', () => ({ serverFetch }));

import { getSoonRuns } from './dashboard-data';

/** Mirrors `ScheduleQueryDto` — see the api-side spec that pins this set. */
const API_WHITELISTED_QUERY_PARAMS = ['sourceType', 'entityKind', 'enabledOnly'];

/** Nest's 400 body for a non-whitelisted query parameter. */
class ForbiddenParamError extends Error {
    constructor(unknownParams: string[]) {
        super(unknownParams.map((p) => `property ${p} should not exist`).join(', '));
        this.name = 'ApiResponseError';
    }
}

/**
 * Stands in for the real endpoint: rejects non-whitelisted query parameters
 * exactly as `forbidNonWhitelisted` does, and answers with a bare
 * `ScheduleView[]` — the handler's actual return type — never an envelope.
 */
function apiSimulator(rows: ScheduleEntry[]) {
    return vi.fn(async (endpoint: string) => {
        const url = new URL(endpoint, 'https://api.test');
        expect(url.pathname).toBe('/schedules');
        const unknownParams = [...url.searchParams.keys()].filter(
            (key) => !API_WHITELISTED_QUERY_PARAMS.includes(key),
        );
        if (unknownParams.length > 0) {
            throw new ForbiddenParamError(unknownParams);
        }
        return rows;
    });
}

const entry = (over: Partial<ScheduleEntry> = {}): ScheduleEntry => ({
    id: 'work_schedule:w1',
    sourceType: 'work_schedule',
    ownerType: 'work',
    ownerId: 'w1',
    ownerName: 'Directory refresh',
    ownerLink: '/works/w1',
    cadenceRaw: '0 9 * * *',
    cadenceHuman: 'Every day at 09:00',
    nextRunAt: '2026-08-12T09:00:00.000Z',
    lastRunAt: null,
    lastRunStatus: null,
    status: 'active',
    enabled: true,
    ...over,
});

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
    serverFetch.mockReset();
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
    errorSpy.mockRestore();
});

describe('getSoonRuns — query contract with GET /api/schedules', () => {
    it('sends only query parameters the API whitelists', async () => {
        serverFetch.mockImplementation(apiSimulator([]));

        await getSoonRuns();

        expect(serverFetch).toHaveBeenCalled();
        const endpoint = serverFetch.mock.calls[0][0] as string;
        const sent = [...new URL(endpoint, 'https://api.test').searchParams.keys()];
        // Fails on the unfixed caller with ['status', 'sort', 'limit'].
        expect(sent.filter((k) => !API_WHITELISTED_QUERY_PARAMS.includes(k))).toEqual([]);
    });

    it('asks the server for enabled schedules only', async () => {
        serverFetch.mockImplementation(apiSimulator([]));

        await getSoonRuns();

        const endpoint = serverFetch.mock.calls[0][0] as string;
        expect(new URL(endpoint, 'https://api.test').searchParams.get('enabledOnly')).toBe('true');
    });

    it('does not 400 against a server that enforces the real whitelist', async () => {
        const simulator = apiSimulator([entry()]);
        serverFetch.mockImplementation(simulator);

        const { items } = await getSoonRuns();

        await expect(simulator.mock.results[0].value).resolves.toBeDefined();
        expect(items).toHaveLength(1);
    });
});

describe('getSoonRuns — response shape', () => {
    it("reads the handler's bare array, not an { items, total } envelope", async () => {
        serverFetch.mockImplementation(apiSimulator([entry(), entry({ id: 'work_schedule:w2' })]));

        const { items, total } = await getSoonRuns();

        // Fails on the unfixed caller: it destructures `.items` off an array.
        expect(items).toHaveLength(2);
        expect(total).toBe(2);
    });

    it('maps a ScheduleView row onto the SoonRunItem the SoonSection renders', async () => {
        serverFetch.mockImplementation(
            apiSimulator([
                entry({
                    id: 'work_schedule:w9',
                    ownerName: 'Nightly crawl',
                    ownerLink: '/works/w9',
                    nextRunAt: '2026-08-12T09:00:00.000Z',
                }),
            ]),
        );

        const { items } = await getSoonRuns();

        expect(items[0]).toEqual({
            id: 'work_schedule:w9',
            sourceKind: 'work-schedule',
            title: 'Nightly crawl',
            nextRunAt: '2026-08-12T09:00:00.000Z',
            href: '/works/w9',
        });
    });

    it('maps mission_tick rows to the mission badge kind', async () => {
        serverFetch.mockImplementation(
            apiSimulator([
                entry({ id: 'mission_tick:m1', sourceType: 'mission_tick', ownerType: 'mission' }),
            ]),
        );

        const { items } = await getSoonRuns();

        expect(items[0].sourceKind).toBe('mission');
    });
});

describe('getSoonRuns — selection', () => {
    it('previews the three soonest runs but reports the full total', async () => {
        const rows = ['05', '01', '04', '02', '03'].map((day) =>
            entry({
                id: `work_schedule:w${day}`,
                ownerId: `w${day}`,
                nextRunAt: `2026-08-${day}T09:00:00.000Z`,
            }),
        );
        serverFetch.mockImplementation(apiSimulator(rows));

        const { items, total } = await getSoonRuns();

        expect(items.map((i) => i.nextRunAt)).toEqual([
            '2026-08-01T09:00:00.000Z',
            '2026-08-02T09:00:00.000Z',
            '2026-08-03T09:00:00.000Z',
        ]);
        // SoonSection renders "+{total - 3} more" from this.
        expect(total).toBe(5);
    });

    it('skips rows with no computable next run', async () => {
        serverFetch.mockImplementation(
            apiSimulator([
                entry({ id: 'work_schedule:w1', nextRunAt: null }),
                entry({ id: 'work_schedule:w2' }),
            ]),
        );

        const { items, total } = await getSoonRuns();

        expect(items.map((i) => i.id)).toEqual(['work_schedule:w2']);
        expect(total).toBe(1);
    });

    it('skips source types SoonRunItem cannot label', async () => {
        // The aggregation projects seven sources; SoonRunItem models two.
        serverFetch.mockImplementation(
            apiSimulator([
                entry({
                    id: 'agent_heartbeat:a1',
                    sourceType: 'agent_heartbeat',
                    ownerType: 'agent',
                }),
                entry({ id: 'recurring_task:t1', sourceType: 'recurring_task', ownerType: 'task' }),
                entry({ id: 'data_sync:w1', sourceType: 'data_sync' }),
                entry({ id: 'work_schedule:w2' }),
            ]),
        );

        const { items, total } = await getSoonRuns();

        expect(items.map((i) => i.id)).toEqual(['work_schedule:w2']);
        expect(total).toBe(1);
    });
});

describe('getSoonRuns — failure is absorbed but not silent', () => {
    it('logs the failing endpoint instead of swallowing the error', async () => {
        serverFetch.mockImplementation(apiSimulator([]));
        // A caller that sends a non-whitelisted parameter — i.e. the defect.
        serverFetch.mockRejectedValueOnce(new ForbiddenParamError(['status', 'sort', 'limit']));

        const result = await getSoonRuns();

        // The page must still render.
        expect(result).toEqual({ items: [], total: 0 });
        // ...but the failure has to be attributable in the logs. Before the fix
        // this catch was empty, and `serverFetch`'s own log prints the response
        // body without the endpoint, so nothing identified this call.
        expect(errorSpy).toHaveBeenCalledTimes(1);
        const logged = errorSpy.mock.calls[0].join(' ');
        expect(logged).toContain('/api/schedules');
        expect(logged).toContain('Soon');
    });

    it('degrades to an empty block on any transport failure', async () => {
        serverFetch.mockRejectedValue(new Error('ECONNREFUSED'));

        await expect(getSoonRuns()).resolves.toEqual({ items: [], total: 0 });
        expect(errorSpy).toHaveBeenCalled();
    });
});
