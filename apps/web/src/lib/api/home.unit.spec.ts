// Home (AW-19) — the server client for `GET /api/home/summary`. Guards the
// endpoint URL shape against the `/api/api/...` double-prefix (`serverFetch`
// prepends `API_URL`, which already ends in `/api`) and pins that a failed
// request rejects instead of resolving a partial summary.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { serverFetchMock } = vi.hoisted(() => ({
    serverFetchMock: vi.fn(),
}));

vi.mock('./server-api', () => ({
    serverFetch: serverFetchMock,
}));

async function importApi() {
    return import('./home');
}

beforeEach(() => {
    serverFetchMock.mockReset();
    serverFetchMock.mockResolvedValue({ computedAt: '2026-09-14T07:04:00.000Z' });
});
afterEach(() => vi.resetModules());

describe('homeAPI', () => {
    it('GETs /home/summary with no query when nothing is narrowed', async () => {
        const { homeAPI } = await importApi();
        await homeAPI.summary();
        expect(serverFetchMock).toHaveBeenCalledWith('/home/summary', { method: 'GET' });
    });

    it('builds the timezone and block query', async () => {
        const { homeAPI } = await importApi();
        await homeAPI.summary({ tz: 'Europe/Kyiv', blocks: ['today', 'needsYou'] });
        expect(serverFetchMock).toHaveBeenCalledWith(
            '/home/summary?tz=Europe%2FKyiv&blocks=today%2CneedsYou',
            { method: 'GET' },
        );
    });

    it('never double-prefixes the endpoint with /api', async () => {
        const { homeAPI } = await importApi();
        await homeAPI.summary({ tz: 'UTC' });
        const [endpoint] = serverFetchMock.mock.calls[0] as [string];
        expect(endpoint.startsWith('/api')).toBe(false);
    });

    it('rejects on a failed request rather than returning a partial object', async () => {
        serverFetchMock.mockRejectedValue(new Error('500 Internal Server Error'));
        const { homeAPI } = await importApi();
        await expect(homeAPI.summary()).rejects.toThrow('500');
    });

    it('omits empty parameters', async () => {
        const { buildHomeSummaryQuery } = await importApi();
        expect(buildHomeSummaryQuery({ tz: '', blocks: [] })).toBe('');
        expect(buildHomeSummaryQuery({ blocks: ['glance'] })).toBe('?blocks=glance');
    });
});
