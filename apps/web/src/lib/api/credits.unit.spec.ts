// Wave 13 — regression spec for the credits/subscriptions API wrappers.
// Guards the endpoint URL shape against the `/api/api/...` double-prefix
// bug: `serverFetch` prepends `API_URL` (normalised to end in `/api`),
// so endpoints must NOT start with `/api`. Mirrors
// email-addresses.unit.spec.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { serverFetchMock } = vi.hoisted(() => ({
    serverFetchMock: vi.fn(),
}));

vi.mock('./server-api', () => ({
    serverFetch: serverFetchMock,
}));

async function importApi() {
    return import('./credits');
}

beforeEach(() => {
    serverFetchMock.mockReset();
    serverFetchMock.mockResolvedValue({ status: 'success' });
});
afterEach(() => vi.resetModules());

describe('creditsAPI — endpoint URL shape (no /api double-prefix)', () => {
    it('balance GETs /credits/balance', async () => {
        const { creditsAPI } = await importApi();
        await creditsAPI.balance();
        expect(serverFetchMock).toHaveBeenCalledWith('/credits/balance', { method: 'GET' });
    });

    it('ledger GETs /credits/ledger with only the provided filters', async () => {
        const { creditsAPI } = await importApi();
        await creditsAPI.ledger();
        expect(serverFetchMock).toHaveBeenCalledWith('/credits/ledger', { method: 'GET' });

        await creditsAPI.ledger({
            period: '2026-07',
            kinds: ['purchase', 'consumption'],
            page: 2,
            pageSize: 10,
        });
        expect(serverFetchMock).toHaveBeenCalledWith(
            '/credits/ledger?period=2026-07&kinds=purchase%2Cconsumption&page=2&pageSize=10',
            { method: 'GET' },
        );
    });

    it('usageSummary GETs /credits/usage-summary (totals — no groupBy)', async () => {
        const { creditsAPI } = await importApi();
        await creditsAPI.usageSummary();
        expect(serverFetchMock).toHaveBeenCalledWith('/credits/usage-summary', { method: 'GET' });

        await creditsAPI.usageSummary({ period: '2026-07' });
        expect(serverFetchMock).toHaveBeenCalledWith('/credits/usage-summary?period=2026-07', {
            method: 'GET',
        });
    });

    it('usageGrouped GETs /credits/usage-summary with groupBy + period', async () => {
        const { creditsAPI } = await importApi();
        await creditsAPI.usageGrouped({ groupBy: 'day', period: '7d' });
        expect(serverFetchMock).toHaveBeenCalledWith(
            '/credits/usage-summary?groupBy=day&period=7d',
            { method: 'GET' },
        );

        await creditsAPI.usageGrouped({ groupBy: 'work' });
        expect(serverFetchMock).toHaveBeenCalledWith('/credits/usage-summary?groupBy=work', {
            method: 'GET',
        });
    });
});

describe('subscriptionsAPI — endpoint URL shape', () => {
    it('currentPlan GETs /subscriptions/plan and listPlans GETs /subscriptions/plans', async () => {
        const { subscriptionsAPI } = await importApi();
        await subscriptionsAPI.currentPlan();
        expect(serverFetchMock).toHaveBeenCalledWith('/subscriptions/plan', { method: 'GET' });

        await subscriptionsAPI.listPlans();
        expect(serverFetchMock).toHaveBeenCalledWith('/subscriptions/plans', { method: 'GET' });
    });

    it('changePlan POSTs /subscriptions/plan with the planCode body', async () => {
        const { subscriptionsAPI } = await importApi();
        await subscriptionsAPI.changePlan('free');
        expect(serverFetchMock).toHaveBeenCalledWith('/subscriptions/plan', {
            method: 'POST',
            body: JSON.stringify({ planCode: 'free' }),
        });
    });
});
