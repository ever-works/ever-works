/**
 * Subscriptions plan endpoint — VALIDATION + AUTHZ + SELF-SERVE-GATE MATRIX.
 *
 * Distinct angle vs the existing subscription specs (which cover happy-path
 * CRUD, tier↔schedule entitlement integration, budgets and billing-grace):
 * this file is an EXHAUSTIVE, ASSERTIVE contract matrix for the two routes
 * on `SubscriptionsController` — `GET /api/subscriptions/plan` and
 * `POST /api/subscriptions/plan` — pinning the exact status codes and error
 * shapes observed against the live stack.
 *
 * ── Probed live (http://127.0.0.1:3100, sqlite in-memory, flags ON) ──────────
 *
 *   GET  /api/subscriptions/plan
 *     • authed fresh user → 200
 *       { status:'success', enabled:true,
 *         plan:{ code:'free', name:'Free', allowedCadences:[7×{cadence,allowed,payPerUse,reason?}] } }
 *       (FREE allows every cadence: allowed:true / payPerUse:false / no reason)
 *     • no auth / bad token / non-Bearer header → 401 { message:'Unauthorized', statusCode:401 }
 *
 *   POST /api/subscriptions/plan   body { planCode }  (DTO: @IsEnum(SubscriptionPlanCode))
 *     • enum is lowercase-only { free, standard, premium }; the DTO rejects
 *       BEFORE the service's lowercase-normalization, so 'FREE' → 400.
 *     • every invalid planCode (missing / '' / 'FREE' / 'enterprise' / number /
 *       null / boolean / array / ' free ' whitespace) → 400 with message
 *       ["planCode must be one of the following values: free, standard, premium"]
 *     • extra field (global ValidationPipe forbidNonWhitelisted) → 400
 *       ["property extra should not exist"]
 *     • planCode:'free' → 200, plan.code='free' (self-service downgrade/default)
 *     • planCode:'standard' | 'premium' → env-adaptive: 200 when the
 *       `allowSelfServePaidPlans` escape hatch is ON (this deploy), else 403
 *       "Paid plans must be activated through billing and cannot be self-assigned."
 *       (EW-711 #23 free→paid self-escalation gate). Asserted tolerant [200,403].
 *     • self-service change PERSISTS: a subsequent GET echoes the new plan.
 *     • no auth / bad token → 401.
 *
 *   Method / route / isolation
 *     • PUT|DELETE /api/subscriptions/plan → 404 "Cannot <M> ..."
 *     • GET /api/subscriptions (no /plan) → 404
 *     • plan changes are strictly per-user — another user stays on FREE.
 *
 * Fully API-orchestrated; a FRESH registerUserViaAPI() user per test (never the
 * shared seeded user), so plan mutations never bleed across cases.
 */
import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

const SUB_BASE = `${API_BASE}/api/subscriptions`;
const PLAN_URL = `${SUB_BASE}/plan`;

/** Canonical cadence keys the plan surface reports, longest→shortest interval. */
const CADENCES = [
    'monthly',
    'weekly',
    'daily',
    'every_12_hours',
    'every_8_hours',
    'every_3_hours',
    'hourly',
];

/** The class-validator enum-rejection message the DTO emits for a bad planCode. */
const ENUM_MSG = 'planCode must be one of the following values: free, standard, premium';

function getPlan(request: import('@playwright/test').APIRequestContext, token: string) {
    return request.get(PLAN_URL, { headers: authedHeaders(token) });
}

function postPlan(
    request: import('@playwright/test').APIRequestContext,
    token: string,
    body: unknown,
) {
    return request.post(PLAN_URL, { headers: authedHeaders(token), data: body as object });
}

/** Assert a class-validator 400 whose `message[]` contains `needle`. */
function expectValidation400(body: { message?: unknown; statusCode?: unknown }, needle: string) {
    expect(Array.isArray(body.message)).toBe(true);
    expect((body.message as string[]).join(' | ')).toContain(needle);
    expect(body.statusCode).toBe(400);
}

test.describe('Subscriptions plan — GET current-subscription shape + authz', () => {
    test('GET fresh user → 200 with the FREE current-subscription envelope', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const res = await getPlan(request, user.access_token);
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(body.status).toBe('success');
        expect(typeof body.enabled).toBe('boolean');
        // A brand-new user always resolves the FREE default (whether the module
        // is enabled or short-circuited), so both branches pin code+name.
        expect(body.plan).toBeTruthy();
        expect(body.plan.code).toBe('free');
        expect(body.plan.name).toBe('Free');
    });

    test('GET FREE plan reports every cadence as allowed / not pay-per-use', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const body = await (await getPlan(request, user.access_token)).json();
        // allowedCadences is only attached when the subscriptions module is live.
        if (body.enabled === true) {
            expect(Array.isArray(body.plan.allowedCadences)).toBe(true);
            const codes = body.plan.allowedCadences.map((c: { cadence: string }) => c.cadence);
            for (const cadence of CADENCES) expect(codes).toContain(cadence);
            for (const c of body.plan.allowedCadences) {
                expect(c.allowed).toBe(true);
                expect(c.payPerUse).toBe(false);
                expect(c.reason).toBeUndefined();
            }
        } else {
            // Disabled deploy: envelope carries only { code, name }.
            expect(body.plan.allowedCadences).toBeUndefined();
        }
    });

    test('GET without Authorization → 401 constant shape', async ({ request }) => {
        const res = await request.get(PLAN_URL);
        expect(res.status()).toBe(401);
        const body = await res.json();
        expect(body.message).toBe('Unauthorized');
        expect(body.statusCode).toBe(401);
    });

    test('GET with a garbage bearer token → 401', async ({ request }) => {
        const res = await getPlan(request, 'not-a-real-token-xyz');
        expect(res.status()).toBe(401);
        expect((await res.json()).statusCode).toBe(401);
    });

    test('GET with a non-Bearer Authorization header → 401', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        // Raw token with no "Bearer " scheme prefix must not authenticate.
        const res = await request.get(PLAN_URL, {
            headers: { Authorization: user.access_token },
        });
        expect(res.status()).toBe(401);
    });

    test('GET /api/subscriptions (no /plan) is not a route → 404', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const res = await request.get(SUB_BASE, { headers: authedHeaders(user.access_token) });
        expect(res.status()).toBe(404);
        expect((await res.json()).error).toBe('Not Found');
    });
});

test.describe('Subscriptions plan — POST planCode validation matrix (@IsEnum)', () => {
    test('missing planCode (empty body) → 400 enum message', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const res = await postPlan(request, user.access_token, {});
        expect(res.status()).toBe(400);
        expectValidation400(await res.json(), ENUM_MSG);
    });

    test('empty-string planCode → 400 enum message', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const res = await postPlan(request, user.access_token, { planCode: '' });
        expect(res.status()).toBe(400);
        expectValidation400(await res.json(), ENUM_MSG);
    });

    test('uppercase "FREE" is rejected — enum is case-sensitive, DTO runs before normalization', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const res = await postPlan(request, user.access_token, { planCode: 'FREE' });
        expect(res.status()).toBe(400);
        expectValidation400(await res.json(), ENUM_MSG);
    });

    test('unknown code "enterprise" → 400 (no such tier)', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const res = await postPlan(request, user.access_token, { planCode: 'enterprise' });
        expect(res.status()).toBe(400);
        expectValidation400(await res.json(), ENUM_MSG);
    });

    test('numeric planCode → 400', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const res = await postPlan(request, user.access_token, { planCode: 123 });
        expect(res.status()).toBe(400);
        expectValidation400(await res.json(), ENUM_MSG);
    });

    test('null planCode → 400', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const res = await postPlan(request, user.access_token, { planCode: null });
        expect(res.status()).toBe(400);
        expectValidation400(await res.json(), ENUM_MSG);
    });

    test('boolean planCode → 400', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const res = await postPlan(request, user.access_token, { planCode: true });
        expect(res.status()).toBe(400);
        expectValidation400(await res.json(), ENUM_MSG);
    });

    test('array planCode ["free"] → 400 (must be a scalar enum member)', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const res = await postPlan(request, user.access_token, { planCode: ['free'] });
        expect(res.status()).toBe(400);
        expectValidation400(await res.json(), ENUM_MSG);
    });

    test('whitespace-padded " free " is NOT trimmed → 400', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const res = await postPlan(request, user.access_token, { planCode: ' free ' });
        expect(res.status()).toBe(400);
        expectValidation400(await res.json(), ENUM_MSG);
    });

    test('extra unknown field → 400 forbidNonWhitelisted ("property extra should not exist")', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const res = await postPlan(request, user.access_token, {
            planCode: 'free',
            extra: 'nope',
        });
        expect(res.status()).toBe(400);
        expectValidation400(await res.json(), 'property extra should not exist');
    });

    test('two violations at once (bad code + extra field) → 400', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const res = await postPlan(request, user.access_token, {
            planCode: 'enterprise',
            surprise: 1,
        });
        expect(res.status()).toBe(400);
        const body = await res.json();
        expect(Array.isArray(body.message)).toBe(true);
        const joined = (body.message as string[]).join(' | ');
        // At least one of the two whitelisting/enum messages must surface.
        expect(/should not exist|one of the following values/.test(joined)).toBe(true);
    });
});

test.describe('Subscriptions plan — POST happy path, self-serve gate, transitions', () => {
    test('POST free → 200 and echoes the FREE plan', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const res = await postPlan(request, user.access_token, { planCode: 'free' });
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(body.status).toBe('success');
        expect(body.plan.code).toBe('free');
        expect(body.plan.name).toBe('Free');
        // Free is always self-serviceable, so the enabled envelope is true here.
        expect(body.enabled).toBe(true);
    });

    test('POST free echoes the full 7-cadence allowance set', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const body = await (
            await postPlan(request, user.access_token, { planCode: 'free' })
        ).json();
        expect(Array.isArray(body.plan.allowedCadences)).toBe(true);
        const codes = body.plan.allowedCadences.map((c: { cadence: string }) => c.cadence);
        for (const cadence of CADENCES) expect(codes).toContain(cadence);
    });

    test('POST standard is env-adaptive: 200 (escape hatch) or 403 (billing gate)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const res = await postPlan(request, user.access_token, { planCode: 'standard' });
        expect([200, 403]).toContain(res.status());
        const body = await res.json();
        if (res.status() === 200) {
            expect(body.plan.code).toBe('standard');
            expect(body.plan.name).toBe('Standard');
            // STANDARD gates the sub-12h cadences to pay-per-use.
            const gated = body.plan.allowedCadences.filter((c: { allowed: boolean }) => !c.allowed);
            for (const c of gated) {
                expect(c.payPerUse).toBe(true);
                expect(String(c.reason)).toContain('Upgrade to Premium');
            }
        } else {
            expect(/billing|self-assigned/i.test(JSON.stringify(body.message))).toBe(true);
            expect(body.statusCode).toBe(403);
        }
    });

    test('POST premium is env-adaptive: 200 (all cadences allowed) or 403 (billing gate)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const res = await postPlan(request, user.access_token, { planCode: 'premium' });
        expect([200, 403]).toContain(res.status());
        const body = await res.json();
        if (res.status() === 200) {
            expect(body.plan.code).toBe('premium');
            expect(body.plan.name).toBe('Premium');
            for (const c of body.plan.allowedCadences) {
                expect(c.allowed).toBe(true);
                expect(c.payPerUse).toBe(false);
            }
        } else {
            expect(body.statusCode).toBe(403);
        }
    });

    test('a self-service plan change PERSISTS — a later GET echoes it', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        // Attempt an upgrade; only assert persistence for whichever tier stuck.
        const up = await postPlan(request, user.access_token, { planCode: 'premium' });
        expect([200, 403]).toContain(up.status());
        const expectedCode = up.status() === 200 ? 'premium' : 'free';

        const got = await (await getPlan(request, user.access_token)).json();
        expect(got.plan.code).toBe(expectedCode);

        // Explicit downgrade back to free is always accepted and reflected.
        const down = await postPlan(request, user.access_token, { planCode: 'free' });
        expect(down.status()).toBe(200);
        const after = await (await getPlan(request, user.access_token)).json();
        expect(after.plan.code).toBe('free');
    });

    test('POST free is idempotent — repeating it keeps the user on FREE', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const first = await postPlan(request, user.access_token, { planCode: 'free' });
        const second = await postPlan(request, user.access_token, { planCode: 'free' });
        expect(first.status()).toBe(200);
        expect(second.status()).toBe(200);
        expect((await second.json()).plan.code).toBe('free');
    });
});

test.describe('Subscriptions plan — POST authz, method/route, per-user isolation', () => {
    test('POST without Authorization → 401 (auth guard runs before body validation)', async ({
        request,
    }) => {
        const res = await request.post(PLAN_URL, { data: { planCode: 'free' } });
        expect(res.status()).toBe(401);
        expect((await res.json()).message).toBe('Unauthorized');
    });

    test('POST with a garbage token → 401 (even with an otherwise-valid body)', async ({
        request,
    }) => {
        const res = await postPlan(request, 'garbage-token', { planCode: 'free' });
        expect(res.status()).toBe(401);
    });

    test('unauth POST is rejected BEFORE the invalid-body 400 (401 wins)', async ({ request }) => {
        // A bad body + no auth must surface 401, proving guard-before-pipe order.
        const res = await request.post(PLAN_URL, { data: { planCode: 'enterprise' } });
        expect(res.status()).toBe(401);
    });

    test('PUT /api/subscriptions/plan → 404 (route is POST/GET only)', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const res = await request.put(PLAN_URL, {
            headers: authedHeaders(user.access_token),
            data: { planCode: 'free' },
        });
        expect(res.status()).toBe(404);
        expect(String((await res.json()).message)).toContain('Cannot PUT');
    });

    test('DELETE /api/subscriptions/plan → 404', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const res = await request.delete(PLAN_URL, { headers: authedHeaders(user.access_token) });
        expect(res.status()).toBe(404);
        expect(String((await res.json()).message)).toContain('Cannot DELETE');
    });

    test('plan changes are strictly per-user — another user stays on FREE', async ({ request }) => {
        const mover = await registerUserViaAPI(request);
        const bystander = await registerUserViaAPI(request);

        // `mover` attempts a paid upgrade (may 200 or 403 by deploy config).
        const changed = await postPlan(request, mover.access_token, { planCode: 'premium' });
        expect([200, 403]).toContain(changed.status());

        // Regardless of the mover's outcome, the bystander is untouched.
        const bystanderPlan = await (await getPlan(request, bystander.access_token)).json();
        expect(bystanderPlan.plan.code).toBe('free');
        expect(bystanderPlan.plan.name).toBe('Free');
    });

    test('two users hold independent plans — the mover never reads FREE-only defaults back onto the bystander', async ({
        request,
    }) => {
        const a = await registerUserViaAPI(request);
        const b = await registerUserViaAPI(request);
        // b explicitly self-selects free; a attempts standard.
        await postPlan(request, b.access_token, { planCode: 'free' });
        const aRes = await postPlan(request, a.access_token, { planCode: 'standard' });
        expect([200, 403]).toContain(aRes.status());

        const aPlan = await (await getPlan(request, a.access_token)).json();
        const bPlan = await (await getPlan(request, b.access_token)).json();
        // b is deterministically free; a is free-or-standard but never leaks to b.
        expect(bPlan.plan.code).toBe('free');
        expect(['free', 'standard']).toContain(aPlan.plan.code);
    });
});
