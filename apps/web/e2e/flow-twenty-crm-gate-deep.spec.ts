import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * FLOW: TWENTY-CRM CONFIG-GATE — deep coverage of a thinly-tested controller
 * (greenfield: ZERO prior e2e mentions of twenty-crm). This pins the
 * integration's HTTP SURFACE and its FAIL-CLOSED posture when the Twenty CRM
 * integration is UNCONFIGURED — which is exactly the CI/local reality (the
 * TWENTY_CRM_* env vars are all UNSET).
 *
 * GROUNDING — every status/shape below was probed against the LIVE sqlite e2e
 * API (port 3100) with throwaway users on 2026-06-11, and cross-checked against
 * the real source:
 *   - apps/api/src/integrations/twenty-crm/controllers/companies.service.ts
 *       (@Controller('api/twenty-crm/companies'),
 *        @UseGuards(AuthSessionGuard, CrmSyncGuard) — auth FIRST, then the CRM
 *        gate; GET / GET ':id' / POST / PATCH ':id' / DELETE ':id'; by-id routes
 *        use ParseUUIDPipe and the POST body uses CompanyBodyDto/ValidationPipe)
 *   - apps/api/src/integrations/twenty-crm/controllers/people.controler.ts
 *       (@Controller('api/twenty-crm/people') — guarded class, BUT intentionally
 *        NOT registered in TwentyCrmModule.controllers; a "secure-by-default but
 *        dead" route, per OQ-1/OQ-2 in the spec)
 *   - apps/api/src/integrations/twenty-crm/guards/crm-sync.guard.ts
 *       (CrmSyncGuard.canActivate -> false when !configService.isEnabled OR
 *        validateConfig() throws; Nest maps a guard returning false to 403)
 *   - apps/api/src/integrations/twenty-crm/config/crm-config.service.ts
 *       (isEnabled = !!(apiUrl && apiKey && workspaceId) from TWENTY_CRM_BASE_URL
 *        / TWENTY_CRM_API_KEY / TWENTY_CRM_WORKSPACE_ID — all UNSET in CI)
 *   - apps/api/src/integrations/twenty-crm/twenty-crm.module.ts
 *       (forRoot/forRootAsync both register ONLY [CompaniesController])
 *
 *   Probed contract facts (asserted below, NOT guessed):
 *     ANON   any /api/twenty-crm/companies verb  -> 401 {message:'Unauthorized', statusCode:401}
 *            (AuthSessionGuard is FIRST in the chain, so the CRM gate is never reached)
 *     AUTHED every /api/twenty-crm/companies verb -> 403
 *            {message:'Forbidden resource', error:'Forbidden', statusCode:403}
 *            (CrmSyncGuard short-circuits because the integration is unconfigured)
 *     AUTHED bad-UUID by-id (GET/PATCH/DELETE .../not-a-uuid) -> STILL 403, never
 *            400 — the GUARD runs before the ParseUUIDPipe (guards precede pipes)
 *     AUTHED bad/extra-field POST body -> STILL 403, never 400 — the guard runs
 *            before the ValidationPipe too
 *     PEOPLE every /api/twenty-crm/people verb -> 404
 *            {message:'Cannot <VERB> /api/twenty-crm/people...', error:'Not Found',
 *             statusCode:404} for BOTH authed and anon (route is not mounted, so
 *            even AuthSessionGuard never fires — no 401, no 403)
 *     ABSENT /api/twenty-crm/{notes,opportunities,sync} -> 404 (no such HTTP routes;
 *            sync is an internal TwentyCrmService concern, never an endpoint)
 *     NO route under /api/twenty-crm ever returns a 5xx while CRM is off.
 *
 * ADAPTIVITY: the gate's CLOSED state (403/404) is the ONLY truthful posture on
 * the keyless CI stack — there is no Twenty workspace to call, so we never assert
 * a 2xx CRM payload. Each assertion is written so a stack that HAS configured the
 * integration (isEnabled true) would still be caught by the auth/route invariants
 * (401 for anon, 404 for unmounted people, no-5xx everywhere); only the
 * specifically gate-dependent 403 assertions are scoped to the unconfigured stack
 * via a probed `gateClosed` precondition derived from the live companies-list.
 *
 * NON-DUPLICATION: twenty-crm has NO existing e2e spec (greenfield). This file
 * does not overlap api-public-contract.spec.ts (that pins a generic protected/
 * 404/POST-4xx tripwire across UNRELATED route prefixes and never touches
 * /api/twenty-crm), nor the per-controller *.spec.ts unit tests in apps/api
 * (those mock the guard/services; this drives the REAL wired HTTP chain end to
 * end). It is the sole integration-level pin of the twenty-crm gate ordering,
 * route enumeration, and unconfigured response shape.
 *
 * ISOLATION: every authed assertion runs on a FRESH registerUserViaAPI() user;
 * anonymous probes use the built-in `request` fixture with NO Authorization
 * header (and no storageState). No module-scope await / no clock at module scope
 * — unique values come from a per-test counter.
 */

const CRM_BASE = `${API_BASE}/api/twenty-crm`;
const COMPANIES = `${CRM_BASE}/companies`;
const PEOPLE = `${CRM_BASE}/people`;

// A syntactically valid UUID for by-id routes where we want the ParseUUIDPipe to
// PASS (so any 400 would have to come from validation, proving the gate ran first
// when we still see 403).
const VALID_UUID = '123e4567-e89b-12d3-a456-426614174000';

// Per-test unique suffix WITHOUT touching a clock at module scope.
let seq = 0;
function uniq(tag: string): string {
    seq += 1;
    return `${tag}-${seq}-${Math.random().toString(36).slice(2, 8)}`;
}

interface ErrorBody {
    message?: string | string[];
    error?: string;
    statusCode?: number;
}

async function jsonBody(res: { json: () => Promise<unknown> }): Promise<ErrorBody> {
    return (await res.json().catch(() => ({}))) as ErrorBody;
}

/** Is the CRM gate currently CLOSED (integration unconfigured)? Derived live. */
async function gateIsClosed(request: APIRequestContext, token: string): Promise<boolean> {
    const res = await request.get(COMPANIES, { headers: authedHeaders(token) });
    // 403 == CrmSyncGuard refused (unconfigured) — the CI reality.
    return res.status() === 403;
}

test.describe('twenty-crm config-gate (fail-closed surface, ordering, route enumeration)', () => {
    test('1. an authenticated GET /companies is refused by the CRM gate with the exact 403 "Forbidden resource" shape when the integration is unconfigured', async ({
        request,
    }) => {
        const { access_token } = await registerUserViaAPI(request);

        const res = await request.get(COMPANIES, { headers: authedHeaders(access_token) });
        // The keyless CI stack has no Twenty workspace, so isEnabled is false and
        // CrmSyncGuard returns false -> Nest 403. (A configured stack would 200;
        // we only deep-assert the shape when the gate is actually closed.)
        expect([200, 403], `companies-list status ${res.status()}`).toContain(res.status());
        expect(res.status(), 'no 5xx while CRM is off').toBeLessThan(500);
        if (res.status() === 403) {
            const body = await jsonBody(res);
            expect(body.message).toBe('Forbidden resource');
            expect(body.error).toBe('Forbidden');
            expect(body.statusCode).toBe(403);
        }
    });

    test('2. an ANONYMOUS GET /companies is rejected by AuthSessionGuard FIRST (401), never reaching the CRM gate — the auth layer precedes the integration gate', async ({
        browser,
    }) => {
        // browser.newContext() inherits no cookies here, but to be unambiguous we
        // use a context with an explicit empty storageState and send no auth header.
        const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
        try {
            const res = await ctx.request.get(COMPANIES);
            expect(res.status(), 'anon is 401, NOT 403 — auth runs before the CRM gate').toBe(401);
            const body = await jsonBody(res);
            expect(body.statusCode).toBe(401);
            expect(String(body.message)).toMatch(/Unauthorized/i);
        } finally {
            await ctx.close();
        }
    });

    test('3. EVERY companies verb (GET list, GET :id, POST, PATCH :id, DELETE :id) is uniformly gated to 403 for an authed caller — the gate covers the whole controller, not just reads', async ({
        request,
    }) => {
        const { access_token } = await registerUserViaAPI(request);
        const headers = authedHeaders(access_token);
        if (!(await gateIsClosed(request, access_token))) {
            test.skip(true, 'CRM integration is configured on this stack — gate is open');
            return;
        }

        const calls: Array<{ label: string; run: () => Promise<{ status: () => number }> }> = [
            { label: 'GET list', run: () => request.get(COMPANIES, { headers }) },
            { label: 'GET :id', run: () => request.get(`${COMPANIES}/${VALID_UUID}`, { headers }) },
            {
                label: 'POST',
                run: () => request.post(COMPANIES, { headers, data: { name: uniq('Acme') } }),
            },
            {
                label: 'PATCH :id',
                run: () =>
                    request.patch(`${COMPANIES}/${VALID_UUID}`, {
                        headers,
                        data: { name: uniq('Renamed') },
                    }),
            },
            {
                label: 'DELETE :id',
                run: () => request.delete(`${COMPANIES}/${VALID_UUID}`, { headers }),
            },
        ];

        for (const c of calls) {
            const res = await c.run();
            expect(res.status(), `${c.label} is gate-refused with 403`).toBe(403);
        }
    });

    test('4. ORDERING — the gate runs BEFORE the ParseUUIDPipe: a by-id route with a malformed (non-UUID) id still returns 403, not the 400 the pipe would produce', async ({
        request,
    }) => {
        const { access_token } = await registerUserViaAPI(request);
        const headers = authedHeaders(access_token);
        if (!(await gateIsClosed(request, access_token))) {
            test.skip(true, 'CRM integration is configured on this stack — gate is open');
            return;
        }

        // 'not-a-uuid' would trip the ParseUUIDPipe (400) IF execution ever reached
        // it. Because guards run before pipes, the CrmSyncGuard short-circuits to 403
        // first — proving the gate fences off the controller before any param parsing.
        for (const verb of ['get', 'patch', 'delete'] as const) {
            const url = `${COMPANIES}/not-a-uuid`;
            const res =
                verb === 'patch'
                    ? await request.patch(url, { headers, data: { name: uniq('X') } })
                    : verb === 'delete'
                      ? await request.delete(url, { headers })
                      : await request.get(url, { headers });
            expect(
                res.status(),
                `${verb} bad-uuid is gate-refused (403) BEFORE the ParseUUIDPipe could 400`,
            ).toBe(403);
        }
    });

    test('5. ORDERING — the gate runs BEFORE the ValidationPipe: a POST with an extra/unknown field still returns 403, not the 400 forbidNonWhitelisted would produce', async ({
        request,
    }) => {
        const { access_token } = await registerUserViaAPI(request);
        const headers = authedHeaders(access_token);
        if (!(await gateIsClosed(request, access_token))) {
            test.skip(true, 'CRM integration is configured on this stack — gate is open');
            return;
        }

        // CompanyBodyDto + the global whitelist/forbidNonWhitelisted ValidationPipe
        // would 400 on this `bogus` field — but ONLY if the request reached the
        // handler. The gate refuses first, so we see 403. (Same for a missing
        // required `name`.)
        const extraField = await request.post(COMPANIES, {
            headers,
            data: { name: uniq('Acme'), bogus: 'should-be-rejected', employees: 'not-a-number' },
        });
        expect(extraField.status(), 'extra/wrong-typed POST body is gate-refused (403)').toBe(403);

        const missingRequired = await request.post(COMPANIES, { headers, data: {} });
        expect(missingRequired.status(), 'empty POST body is gate-refused (403), not 400').toBe(403);
    });

    test('6. the PeopleController is REGISTERED-as-code but NOT mounted: every /people verb returns a 404 "Cannot <VERB> /api/twenty-crm/people" for an authed user — its AuthSessionGuard never even fires (no 401/403)', async ({
        request,
    }) => {
        const { access_token } = await registerUserViaAPI(request);
        const headers = authedHeaders(access_token);

        const probes: Array<{ verb: string; res: Promise<{ status: () => number; json: () => Promise<unknown> }> }> =
            [
                { verb: 'GET', res: request.get(PEOPLE, { headers }) },
                { verb: 'GET', res: request.get(`${PEOPLE}/${VALID_UUID}`, { headers }) },
                {
                    verb: 'POST',
                    res: request.post(PEOPLE, { headers, data: { firstName: uniq('A') } }),
                },
                {
                    verb: 'PATCH',
                    res: request.patch(`${PEOPLE}/${VALID_UUID}`, {
                        headers,
                        data: { firstName: uniq('B') },
                    }),
                },
                { verb: 'DELETE', res: request.delete(`${PEOPLE}/${VALID_UUID}`, { headers }) },
            ];

        for (const p of probes) {
            const res = await p.res;
            expect(
                res.status(),
                `${p.verb} /people is unmounted -> 404 (not 401/403/5xx)`,
            ).toBe(404);
            const body = await jsonBody(res);
            expect(body.statusCode).toBe(404);
            expect(body.error).toBe('Not Found');
            expect(String(body.message)).toMatch(/Cannot .* \/api\/twenty-crm\/people/);
        }
    });

    test('7. the unmounted /people surface is identical for ANONYMOUS callers — 404 (the route simply does not exist, so there is no auth boundary to hit)', async ({
        browser,
    }) => {
        const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
        try {
            // A real protected route would 401 anon; /people 404s because it was never
            // wired into the module's controllers array.
            const list = await ctx.request.get(PEOPLE);
            expect(list.status(), 'anon /people list -> 404, not 401').toBe(404);

            const create = await ctx.request.post(PEOPLE, { data: { firstName: uniq('Anon') } });
            expect(create.status(), 'anon POST /people -> 404, not 401').toBe(404);
            const body = await jsonBody(create);
            expect(body.statusCode).toBe(404);
            expect(String(body.message)).toMatch(/Cannot POST \/api\/twenty-crm\/people/);
        } finally {
            await ctx.close();
        }
    });

    test('8. ROUTE ENUMERATION — the ONLY mounted twenty-crm controller is companies: notes/opportunities/sync are NOT HTTP endpoints (sync is an internal service), so they 404 even for an authed user', async ({
        request,
    }) => {
        const { access_token } = await registerUserViaAPI(request);
        const headers = authedHeaders(access_token);

        // These plausible-sounding CRM nouns are deliberately NOT routes — they 404
        // rather than gate-403, which distinguishes "exists-but-gated" (companies)
        // from "never registered" (everything else).
        const notes = await request.get(`${CRM_BASE}/notes`, { headers });
        expect(notes.status(), '/notes is not a route -> 404').toBe(404);

        const opportunities = await request.get(`${CRM_BASE}/opportunities`, { headers });
        expect(opportunities.status(), '/opportunities is not a route -> 404').toBe(404);

        const sync = await request.post(`${CRM_BASE}/sync`, { headers, data: {} });
        expect(sync.status(), '/sync is internal, not an HTTP route -> 404').toBe(404);

        // And a clearly bogus sub-path under the mounted controller's prefix 404s too
        // (it matches no @Get/@Post route shape on CompaniesController).
        const bogusSub = await request.get(`${CRM_BASE}/companies/${VALID_UUID}/not-a-subroute`, {
            headers,
        });
        expect(bogusSub.status(), 'unknown companies sub-route -> 404').toBe(404);
    });

    test('9. NO-5XX INVARIANT — across the full mounted+unmounted twenty-crm matrix (anon + authed), every response is a clean 4xx, never a 5xx, when the integration is off', async ({
        request,
        browser,
    }) => {
        const { access_token } = await registerUserViaAPI(request);
        const headers = authedHeaders(access_token);
        const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });

        try {
            const statuses: Array<{ label: string; status: number }> = [];

            // Authed companies (gated).
            statuses.push({
                label: 'authed GET companies',
                status: (await request.get(COMPANIES, { headers })).status(),
            });
            statuses.push({
                label: 'authed POST companies',
                status: (
                    await request.post(COMPANIES, { headers, data: { name: uniq('C') } })
                ).status(),
            });
            // Authed people (unmounted).
            statuses.push({
                label: 'authed GET people',
                status: (await request.get(PEOPLE, { headers })).status(),
            });
            // Anon companies (auth boundary).
            statuses.push({
                label: 'anon GET companies',
                status: (await ctx.request.get(COMPANIES)).status(),
            });
            // Anon people (unmounted).
            statuses.push({
                label: 'anon GET people',
                status: (await ctx.request.get(PEOPLE)).status(),
            });

            for (const s of statuses) {
                expect(s.status, `${s.label} is a clean client status, never 5xx`).toBeLessThan(
                    500,
                );
                expect(s.status, `${s.label} is a 4xx`).toBeGreaterThanOrEqual(400);
            }
        } finally {
            await ctx.close();
        }
    });

    test('10. a malformed/garbage bearer token is treated as UNAUTHENTICATED (401) on the gated companies route — the auth guard rejects it before the CRM gate, same as anon', async ({
        request,
    }) => {
        const res = await request.get(COMPANIES, {
            headers: { Authorization: `Bearer ${uniq('garbage-token')}` },
        });
        // An invalid token never becomes a valid session, so AuthSessionGuard 401s —
        // it does NOT fall through to the CRM gate's 403.
        expect(res.status(), 'garbage bearer -> 401 (auth before gate)').toBe(401);
        const body = await jsonBody(res);
        expect(body.statusCode).toBe(401);
        expect(String(body.message)).toMatch(/Unauthorized/i);
    });

    test('11. the gate decision is independent of request CONTENT-TYPE and body: an authed POST /companies with a non-JSON body is still gate-refused 403 (the guard runs before any body parsing/validation)', async ({
        request,
    }) => {
        const { access_token } = await registerUserViaAPI(request);
        if (!(await gateIsClosed(request, access_token))) {
            test.skip(true, 'CRM integration is configured on this stack — gate is open');
            return;
        }

        // A text/plain body would normally not satisfy the JSON DTO, but the gate
        // short-circuits before the body is ever read — so the outcome is the gate's
        // 403, identical to the well-formed-body case, proving the gate is content-blind.
        const res = await request.post(COMPANIES, {
            headers: {
                ...authedHeaders(access_token),
                'Content-Type': 'text/plain',
            },
            data: 'this is not json',
        });
        expect(res.status(), 'non-JSON POST is still gate-refused (403)').toBe(403);
    });

    test('12. two DIFFERENT fresh users hit the same closed gate identically — the unconfigured CRM gate is a GLOBAL integration-level fence, not a per-user/per-tenant authorization decision', async ({
        request,
    }) => {
        const userA = await registerUserViaAPI(request);
        const userB = await registerUserViaAPI(request);

        const resA = await request.get(COMPANIES, { headers: authedHeaders(userA.access_token) });
        const resB = await request.get(COMPANIES, { headers: authedHeaders(userB.access_token) });

        // Both are valid sessions (they cleared AuthSessionGuard), yet both are refused
        // by the SAME integration gate with the SAME status — the gate keys off global
        // CRM config (isEnabled), not the caller's tenant/role.
        expect(resA.status(), 'user A and B see the same gate status').toBe(resB.status());
        expect([200, 403]).toContain(resA.status());
        if (resA.status() === 403) {
            const [bodyA, bodyB] = await Promise.all([jsonBody(resA), jsonBody(resB)]);
            expect(bodyA.message).toBe('Forbidden resource');
            expect(bodyB.message).toBe('Forbidden resource');
            expect(bodyA.statusCode).toBe(403);
            expect(bodyB.statusCode).toBe(403);
        }
    });
});
