import { test, expect, request as pwRequest, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * SEC PIN: TWENTY-CRM GATE — pins the security-audit Wave L #61 contract:
 * `CrmSyncGuard` is actually APPLIED to `CompaniesController`
 * (`@UseGuards(AuthSessionGuard, CrmSyncGuard)` on
 * apps/api/src/integrations/twenty-crm/controllers/companies.service.ts).
 * The guard fails closed: with the TWENTY_CRM_* env unset (CI/local), the
 * config service reports `isEnabled === false`, the guard returns `false`,
 * and Nest surfaces a 403 Forbidden on EVERY companies route for
 * authenticated callers — while anonymous callers are stopped one guard
 * earlier by `AuthSessionGuard` with a 401. Because guards run before
 * pipes, the closed gate also masks `ParseUUIDPipe` and the global
 * ValidationPipe (403, never 400) — nothing reaches the CRM client.
 *
 * Controller surface (enumerated from the controller file — the ONLY
 * mounted twenty-crm controller; `PeopleController` is deliberately NOT in
 * `TwentyCrmModule.controllers`, see its OQ-1/OQ-2 note):
 *   GET    /api/twenty-crm/companies
 *   GET    /api/twenty-crm/companies/:id   (ParseUUIDPipe)
 *   POST   /api/twenty-crm/companies       (CompanyBodyDto)
 *   PATCH  /api/twenty-crm/companies/:id   (ParseUUIDPipe + UpdateCompanyBodyDto)
 *   DELETE /api/twenty-crm/companies/:id   (ParseUUIDPipe)
 *
 * PROBED CONTRACTS (live API :3100 sqlite in-memory, TWENTY_CRM_* unset,
 * probed with curl + a throwaway registered user, 2026-06-11):
 *   anon  GET|POST list, GET|PATCH|DELETE /:id → 401
 *         {message:'Unauthorized', statusCode:401}            (AuthSessionGuard)
 *   anon  garbage bearer token              → 401 (same body — never 403:
 *         token validation precedes the CRM gate)
 *   authed GET list / GET /:id (valid v4 uuid) → 403
 *         {message:'Forbidden resource', error:'Forbidden', statusCode:403}
 *   authed POST valid CompanyBodyDto        → 403 (same body)
 *   authed PATCH /:id + DELETE /:id         → 403 (same body)
 *   authed GET|PATCH|DELETE /not-a-uuid     → 403 NOT 400 (guards run
 *         before pipes — ParseUUIDPipe never executes behind a closed gate)
 *   authed POST {name:123, evil:'x'}        → 403 NOT 400 (guards run
 *         before the global ValidationPipe — malformed body never inspected)
 *   PUT   /api/twenty-crm/companies/:id     → 404 {message:'Cannot PUT …',
 *         error:'Not Found', statusCode:404} (only GET/POST/PATCH/DELETE map)
 *   GET   /api/twenty-crm/people (anon + authed) → 404 'Cannot GET
 *         /api/twenty-crm/people' (PeopleController unmounted by design)
 *
 * NON-DUPLICATION: no existing spec touches /api/twenty-crm/* at all
 * (repo-wide grep for 'twenty-crm|CrmSync' over apps/web/e2e returns
 * nothing). The generic 401-envelope specs (api-error-response-shape,
 * api-malformed-authorization-header) pin other routes' envelopes, not
 * this controller, its 403 fail-closed gate, or its guard-vs-pipe ordering.
 *
 * ADAPTIVITY: no LLM key, no mail, no Redis, no Twenty workspace needed —
 * the whole point is the DISABLED-integration posture (CI is key-less, so
 * this gate is exactly what CI exercises). Anonymous calls go through a
 * fresh empty-storageState request context (the project request fixture
 * inherits the seeded auth cookie).
 */

const COMPANIES = `${API_BASE}/api/twenty-crm/companies`;

// Any syntactically valid v4 UUID — the gate is closed, so it never reaches
// a lookup; it only has to satisfy nothing (guards run before pipes) while
// proving the 403 is not an artifact of a malformed path param.
const VALID_UUID = '11111111-2222-4333-8444-555555555555';

const ANON_401 = { message: 'Unauthorized', statusCode: 401 };
const GATE_403 = { message: 'Forbidden resource', error: 'Forbidden', statusCode: 403 };

function stamp(): string {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/** Fresh request context with NO cookies — genuinely anonymous. */
async function anonContext(): Promise<APIRequestContext> {
    return pwRequest.newContext({
        storageState: { cookies: [], origins: [] },
    });
}

test.describe('SEC PIN — twenty-crm companies gate (Wave L #61): anonymous tier', () => {
    test('anon hits on ALL five companies routes → 401 {message:"Unauthorized"} (AuthSessionGuard fires before the CRM gate)', async () => {
        const anon = await anonContext();
        try {
            const hits: Array<{
                label: string;
                res: Promise<import('@playwright/test').APIResponse>;
            }> = [
                { label: 'GET list', res: anon.get(COMPANIES) },
                { label: 'POST create', res: anon.post(COMPANIES, { data: { name: 'x' } }) },
                { label: 'GET by-id', res: anon.get(`${COMPANIES}/${VALID_UUID}`) },
                {
                    label: 'PATCH by-id',
                    res: anon.patch(`${COMPANIES}/${VALID_UUID}`, { data: { name: 'x' } }),
                },
                { label: 'DELETE by-id', res: anon.delete(`${COMPANIES}/${VALID_UUID}`) },
            ];
            for (const hit of hits) {
                const res = await hit.res;
                expect(res.status(), `anon ${hit.label} → 401`).toBe(401);
                const body = (await res.json()) as Record<string, unknown>;
                expect(body, `anon ${hit.label} body`).toEqual(ANON_401);
            }
        } finally {
            await anon.dispose();
        }
    });

    test('garbage bearer token → 401, never 403 (token validation precedes the CRM gate, so auth state cannot be probed via the gate)', async () => {
        const anon = await anonContext();
        try {
            const res = await anon.get(COMPANIES, {
                headers: authedHeaders(`garbage-token-${stamp()}`),
            });
            expect(res.status(), 'invalid bearer is a 401, not the gate 403').toBe(401);
            expect((await res.json()) as Record<string, unknown>).toEqual(ANON_401);
        } finally {
            await anon.dispose();
        }
    });
});

test.describe('SEC PIN — twenty-crm companies gate (Wave L #61): authed fail-closed 403', () => {
    test('authed GET /api/twenty-crm/companies → 403 {message:"Forbidden resource"} (CrmSyncGuard fails closed with TWENTY_CRM_* unset)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const res = await request.get(COMPANIES, {
            headers: authedHeaders(user.access_token),
        });
        expect(res.status(), 'list read is gated').toBe(403);
        expect((await res.json()) as Record<string, unknown>).toEqual(GATE_403);
    });

    test('authed GET /:id with a VALID v4 uuid → 403 (no by-id read path either — the 403 is the gate, not id validation)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const res = await request.get(`${COMPANIES}/${VALID_UUID}`, {
            headers: authedHeaders(user.access_token),
        });
        expect(res.status(), 'by-id read is gated').toBe(403);
        expect((await res.json()) as Record<string, unknown>).toEqual(GATE_403);
    });

    test('authed POST with a fully VALID CompanyBodyDto → 403 (nothing is created or forwarded to the CRM client)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const res = await request.post(COMPANIES, {
            headers: authedHeaders(user.access_token),
            data: {
                name: `sec-pin-co-${stamp()}`,
                domainName: 'sec-pin.example.com',
                employees: 7,
                idealCustomerProfile: true,
            },
        });
        expect(res.status(), 'create is gated even for a perfect payload').toBe(403);
        expect((await res.json()) as Record<string, unknown>).toEqual(GATE_403);
    });

    test('authed PATCH /:id and DELETE /:id → 403 (both mutation routes sit behind the same closed gate)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const headers = authedHeaders(user.access_token);

        const patch = await request.patch(`${COMPANIES}/${VALID_UUID}`, {
            headers,
            data: { name: `sec-pin-renamed-${stamp()}` },
        });
        expect(patch.status(), 'PATCH is gated').toBe(403);
        expect((await patch.json()) as Record<string, unknown>).toEqual(GATE_403);

        const del = await request.delete(`${COMPANIES}/${VALID_UUID}`, { headers });
        expect(del.status(), 'DELETE is gated').toBe(403);
        expect((await del.json()) as Record<string, unknown>).toEqual(GATE_403);
    });
});

test.describe('SEC PIN — twenty-crm companies gate (Wave L #61): guard-before-pipe ordering', () => {
    test('authed GET/PATCH/DELETE with a NON-uuid id → 403 not 400 (guards run before ParseUUIDPipe — the closed gate masks id validation)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const headers = authedHeaders(user.access_token);
        const badIdUrl = `${COMPANIES}/not-a-uuid`;

        const hits = [
            { label: 'GET', res: await request.get(badIdUrl, { headers }) },
            {
                label: 'PATCH',
                res: await request.patch(badIdUrl, { headers, data: { name: 'x' } }),
            },
            { label: 'DELETE', res: await request.delete(badIdUrl, { headers }) },
        ];
        for (const hit of hits) {
            expect(hit.res.status(), `${hit.label} /not-a-uuid → gate 403, pipe never runs`).toBe(
                403,
            );
            expect((await hit.res.json()) as Record<string, unknown>).toEqual(GATE_403);
        }
    });

    test('authed POST with a malformed body (wrong-typed name + non-whitelisted key) → 403 not 400 (gate fires before the global ValidationPipe)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        // With the gate OPEN this body would be a 400 twice over
        // (name must be a string; `evil` is forbidNonWhitelisted). Closed
        // gate → the body is never inspected, so nothing about the DTO
        // schema leaks to callers while the integration is disabled.
        const res = await request.post(COMPANIES, {
            headers: authedHeaders(user.access_token),
            data: { name: 123, evil: 'x' },
        });
        expect(res.status(), 'gate masks validation').toBe(403);
        expect((await res.json()) as Record<string, unknown>).toEqual(GATE_403);
    });
});

test.describe('SEC PIN — twenty-crm route surface', () => {
    test('PUT /api/twenty-crm/companies/:id → 404 "Cannot PUT …" (only GET/POST/PATCH/DELETE are mapped — no accidental verb surface)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const res = await request.put(`${COMPANIES}/${VALID_UUID}`, {
            headers: authedHeaders(user.access_token),
            data: { name: 'x' },
        });
        expect(res.status(), 'PUT is not a route').toBe(404);
        expect((await res.json()) as Record<string, unknown>).toEqual({
            message: `Cannot PUT /api/twenty-crm/companies/${VALID_UUID}`,
            error: 'Not Found',
            statusCode: 404,
        });
    });

    test('GET /api/twenty-crm/people → 404 for anon AND authed (PeopleController is deliberately unmounted — no shadow CRM surface)', async ({
        request,
    }) => {
        const peopleUrl = `${API_BASE}/api/twenty-crm/people`;
        const expected404 = {
            message: 'Cannot GET /api/twenty-crm/people',
            error: 'Not Found',
            statusCode: 404,
        };

        const anon = await anonContext();
        try {
            const anonRes = await anon.get(peopleUrl);
            expect(anonRes.status(), 'anon people → route absent').toBe(404);
            expect((await anonRes.json()) as Record<string, unknown>).toEqual(expected404);
        } finally {
            await anon.dispose();
        }

        const user = await registerUserViaAPI(request);
        const authedRes = await request.get(peopleUrl, {
            headers: authedHeaders(user.access_token),
        });
        expect(authedRes.status(), 'authed people → route absent').toBe(404);
        expect((await authedRes.json()) as Record<string, unknown>).toEqual(expected404);
    });
});
