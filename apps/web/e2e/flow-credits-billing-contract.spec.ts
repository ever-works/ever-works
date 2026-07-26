import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * Credits & billing read surface (pricing Wave 9 M1 / Wave 13) — API
 * CONTRACT. `api-public-contract` already pins the three 401 postures;
 * this file pins the SHAPES and the filter semantics behind them.
 *
 * ── Routes (apps/api/src/subscriptions/credits.controller.ts) ───────
 *   GET /api/credits/balance
 *       → 200 { status:'success', balanceCredits:number }  (SUM over the
 *         ledger — there is deliberately no credit_accounts table)
 *   GET /api/credits/ledger?period=YYYY-MM&kinds=…&page=&pageSize=
 *       → 200 { status:'success', entries:[…], total, page, pageSize }
 *       → 400 on a malformed period or an unknown ledger kind
 *   GET /api/credits/usage-summary?groupBy=day|model|agent|work&period=
 *       → 200 totals (no groupBy) or grouped rows (with groupBy)
 *       → 400 on an unknown groupBy or a period outside YYYY-MM|7d|30d
 *
 * Writes never happen over public HTTP — purchases arrive via the
 * billing-provider webhook and consumption via the metering debit hook.
 * The "no write verb exists" assertion below is the guard on that rule.
 */

function errText(body: unknown): string {
    const m = (body as { message?: unknown })?.message;
    if (Array.isArray(m)) return m.join(' | ');
    return String(m ?? '');
}

function get(request: APIRequestContext, token: string, path: string) {
    return request.get(`${API_BASE}${path}`, { headers: authedHeaders(token) });
}

const LEDGER_KINDS = ['purchase', 'grant', 'daily-free', 'consumption', 'adjustment', 'expiry'];

test.describe('GET /api/credits/balance', () => {
    test('a fresh account has a numeric balance and the success envelope', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const res = await get(request, u.access_token, '/api/credits/balance');
        expect(res.status(), `balance body=${await res.text().catch(() => '')}`).toBe(200);
        const body = await res.json();
        expect(body.status).toBe('success');
        expect(typeof body.balanceCredits).toBe('number');
    });

    test('two accounts never see each other’s balance movements', async ({ request }) => {
        // Owner scoping is a SUM over the caller's ledger rows; a fresh
        // second account must not inherit anything from the first.
        const a = await registerUserViaAPI(request);
        const b = await registerUserViaAPI(request);

        const resA = await get(request, a.access_token, '/api/credits/ledger');
        const resB = await get(request, b.access_token, '/api/credits/ledger');
        expect(resA.status()).toBe(200);
        expect(resB.status()).toBe(200);

        const idsA = new Set(
            ((await resA.json()).entries as Array<{ id: string }>).map((e) => e.id),
        );
        const entriesB = (await resB.json()).entries as Array<{ id: string }>;
        for (const entry of entriesB) {
            expect(idsA.has(entry.id), 'ledger rows must never cross accounts').toBe(false);
        }
    });
});

test.describe('GET /api/credits/ledger', () => {
    test('returns the paginated envelope with a projected row shape (no scope columns)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const res = await get(request, u.access_token, '/api/credits/ledger?pageSize=5');
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(body.status).toBe('success');
        expect(Array.isArray(body.entries)).toBe(true);
        expect(typeof body.total).toBe('number');
        expect(body.pageSize).toBe(5);

        for (const entry of body.entries as Array<Record<string, unknown>>) {
            // Explicit projection — these are the only fields that leave.
            expect(Object.keys(entry).sort()).toEqual(
                [
                    'amountCredits',
                    'balanceAfter',
                    'costCentsRef',
                    'createdAt',
                    'description',
                    'id',
                    'kind',
                    'refId',
                    'refType',
                ].sort(),
            );
            expect(entry).not.toHaveProperty('userId');
            expect(entry).not.toHaveProperty('organizationId');
            expect(entry).not.toHaveProperty('tenantId');
        }
    });

    test('every documented kind is accepted; an unknown kind is a truthful 400', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);

        const all = await get(
            request,
            u.access_token,
            `/api/credits/ledger?kinds=${LEDGER_KINDS.join(',')}`,
        );
        expect(all.status(), 'all six kinds are valid filters').toBe(200);

        const bogus = await get(request, u.access_token, '/api/credits/ledger?kinds=free-money');
        expect(bogus.status()).toBe(400);
        expect(errText(await bogus.json())).toContain('Unknown ledger kind: free-money');

        // One bad kind in an otherwise-valid list still rejects the call —
        // silently dropping it would under-report spend.
        const mixed = await get(
            request,
            u.access_token,
            '/api/credits/ledger?kinds=purchase,free-money',
        );
        expect(mixed.status()).toBe(400);
    });

    test('period must be YYYY-MM; page/pageSize are bounded', async ({ request }) => {
        const u = await registerUserViaAPI(request);

        const okPeriod = await get(request, u.access_token, '/api/credits/ledger?period=2026-07');
        expect(okPeriod.status()).toBe(200);

        for (const period of ['2026-13', '2026-7', 'july', '7d']) {
            const res = await get(request, u.access_token, `/api/credits/ledger?period=${period}`);
            expect(res.status(), `period=${period}`).toBe(400);
            expect(errText(await res.json())).toContain('period must be YYYY-MM');
        }

        const zeroPage = await get(request, u.access_token, '/api/credits/ledger?page=0');
        expect(zeroPage.status()).toBe(400);

        const hugePage = await get(request, u.access_token, '/api/credits/ledger?pageSize=101');
        expect(hugePage.status()).toBe(400);

        const maxPage = await get(request, u.access_token, '/api/credits/ledger?pageSize=100');
        expect(maxPage.status(), 'pageSize=100 is the documented ceiling').toBe(200);
    });
});

test.describe('GET /api/credits/usage-summary', () => {
    test('without groupBy: the stat-tile totals the Usage page renders', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const res = await get(request, u.access_token, '/api/credits/usage-summary');
        expect(res.status(), `totals body=${await res.text().catch(() => '')}`).toBe(200);
        const body = await res.json();
        expect(body.status).toBe('success');
        for (const key of [
            'balanceCredits',
            'creditsConsumed',
            'creditsAdded',
            'spendCents',
            'tasksCompleted',
            'worksActive',
            'agentRuns',
        ]) {
            expect(typeof body[key], `${key} must be a number`).toBe('number');
        }
        expect(typeof body.period).toBe('string');
    });

    test('every documented groupBy returns rows; an unknown one is 400', async ({ request }) => {
        const u = await registerUserViaAPI(request);

        for (const groupBy of ['day', 'model', 'agent', 'work']) {
            const res = await get(
                request,
                u.access_token,
                `/api/credits/usage-summary?groupBy=${groupBy}`,
            );
            expect(res.status(), `groupBy=${groupBy}`).toBe(200);
            const body = await res.json();
            expect(Array.isArray(body.rows), `groupBy=${groupBy} rows`).toBe(true);
        }

        const bad = await get(request, u.access_token, '/api/credits/usage-summary?groupBy=galaxy');
        expect(bad.status()).toBe(400);
        expect(errText(await bad.json())).toContain('groupBy');
    });

    test('period accepts YYYY-MM / 7d / 30d and nothing else (never an unmapped 500)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);

        for (const period of ['2026-07', '7d', '30d']) {
            const res = await get(
                request,
                u.access_token,
                `/api/credits/usage-summary?period=${period}`,
            );
            expect(res.status(), `period=${period}`).toBe(200);
        }

        for (const period of ['2026-13', '90d', 'last-month', '2026-7']) {
            const res = await get(
                request,
                u.access_token,
                `/api/credits/usage-summary?period=${period}`,
            );
            expect(res.status(), `period=${period}`).toBe(400);
            expect(errText(await res.json())).toContain('period must be YYYY-MM, 7d, or 30d');
        }
    });
});

test.describe('credits surface is read-only over HTTP', () => {
    test('POST / PATCH / DELETE on the credits routes are never 2xx', async ({ request }) => {
        // Purchases arrive via the billing-provider webhook and consumption
        // via the metering debit hook — a write verb appearing here would be
        // a way to mint credits over the public API.
        const u = await registerUserViaAPI(request);
        const headers = authedHeaders(u.access_token);

        const writes = [
            request.post(`${API_BASE}/api/credits/balance`, { headers, data: { balance: 1000 } }),
            request.post(`${API_BASE}/api/credits/ledger`, {
                headers,
                data: { kind: 'grant', amountCredits: 1000 },
            }),
            request.patch(`${API_BASE}/api/credits/balance`, { headers, data: { balance: 1000 } }),
            request.delete(`${API_BASE}/api/credits/ledger`, { headers }),
        ];

        for (const promise of writes) {
            const res = await promise;
            expect(res.status(), `write verb returned ${res.status()}`).toBeGreaterThanOrEqual(400);
            expect(res.status()).toBeLessThan(500);
        }
    });
});
