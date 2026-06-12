import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, createWorkViaAPI } from './helpers/api';

/**
 * SECURITY PIN: webhook-subscription ownership — `/api/webhooks`.
 *
 * Pins the EW-711 Wave L #14 contract (apps/api/src/webhooks/webhooks.service.ts
 * `create()`): a subscription bound to a Work receives that Work's lifecycle
 * events (names, deployment URLs, error details), so binding to a workId the
 * caller cannot view MUST be refused — and refused as 404, never 403/500, so
 * the caller cannot enumerate which workIds exist. Also pins the `findOwn`
 * scoping on every per-subscription verb (PATCH / DELETE / rotate-secret /
 * test-fire): cross-account access is masked as the SAME 404 a nonexistent
 * id produces.
 *
 * PROBED CONTRACTS — every status/message below was verified against the LIVE
 * sqlite e2e API (port 3100) with throwaway users before being asserted:
 *
 *   POST /api/webhooks { url, workId:<own> }      → 201 { subscription:{ id, accountId,
 *        workId, url, status:'active', consecutiveFailures:0, lastDeliveryAt:null,
 *        createdAt, updatedAt }, signingSecret:'<raw, returned ONCE>' }
 *   POST /api/webhooks { url }                    → 201, subscription.workId === null
 *   POST /api/webhooks { url, workId:<FOREIGN> }  → 404 (NOT 403/500)
 *        { message:"Work with id '<id>' not found", error:'Not Found', statusCode:404 }
 *        and NO subscription row is created.
 *   POST /api/webhooks { url, workId:<absent> }   → 404 with the SAME message
 *        template: { status:'error', message:"Work with id '<id>' not found" }.
 *        (Foreign vs absent differ only in the error ENVELOPE — Nest default vs
 *        the works exception-filter shape — the status and message are
 *        identical, which is what the enumeration defense pins here.)
 *   POST /api/webhooks { url, workId:'not-a-uuid' } → 400 ['workId must be a UUID']
 *        (DTO gate fires BEFORE any ownership lookup)
 *   POST /api/webhooks { url:'javascript:alert(1)' } → 400 ['url must be a URL address']
 *   POST /api/webhooks (anonymous)                → 401 { message:'Unauthorized' }
 *   DELETE/PATCH/POST(:id/rotate-secret|:id/test) on a FOREIGN subscription
 *        → 404 { message:'Webhook subscription not found' } — byte-identical to
 *        the nonexistent-id and the already-deleted-id responses.
 *   PATCH own { status:'paused' }                 → 200 view with status:'paused'
 *   DELETE own                                    → 204 (empty body); repeat → 404
 *   DELETE /api/webhooks/not-a-uuid               → 400 'Validation failed (uuid is expected)'
 *   GET /api/webhooks                             → 200 { subscriptions:[...] } scoped to the
 *        caller's account; view objects carry NO secret material (no signingSecret /
 *        secretEncrypted / secret keys — the raw secret appears ONLY in the
 *        create/rotate response).
 *
 * NON-DUPLICATION: the sibling webhook-subscriptions.spec.ts pins only the
 * endpoint-existence probe (GET auth gate across candidate paths) and the
 * authed list-returns-array shape. This file does not re-pin those; it owns
 * the WRITE-side ownership matrix (workId binding gate, findOwn masking,
 * delete lifecycle, secret hygiene). No other spec touches POST/PATCH/DELETE
 * /api/webhooks.
 *
 * ISOLATION: every test registers FRESH users via registerUserViaAPI and uses
 * unique timestamp-suffixed URLs. All assertions are API-contract level (no UI
 * navigation). The route-level throttles (create 10/min, rotate/test 5/min)
 * are per-USER buckets (UserAwareThrottlerGuard), so fresh-user-per-test keeps
 * every test far under the limits.
 */

const WEBHOOKS = `${API_BASE}/api/webhooks`;
/** Valid v4-shaped UUID that no live row will ever have. */
const ABSENT_UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

interface SubscriptionView {
    id: string;
    accountId: string;
    workId: string | null;
    url: string;
    status: string;
    consecutiveFailures: number;
    lastDeliveryAt: string | null;
    createdAt: string;
    updatedAt: string;
}

function uniq(): string {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

async function createSubscription(
    request: APIRequestContext,
    token: string,
    payload: { url: string; workId?: string },
): Promise<{
    status: number;
    body: { subscription?: SubscriptionView; signingSecret?: string; message?: string | string[] };
}> {
    const res = await request.post(WEBHOOKS, {
        headers: authedHeaders(token),
        data: payload,
    });
    return { status: res.status(), body: await res.json() };
}

async function listSubscriptions(
    request: APIRequestContext,
    token: string,
): Promise<SubscriptionView[]> {
    const res = await request.get(WEBHOOKS, { headers: authedHeaders(token) });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { subscriptions: SubscriptionView[] };
    expect(Array.isArray(body.subscriptions)).toBe(true);
    return body.subscriptions;
}

test.describe('SEC PIN: webhook create — workId binding gate (Wave L #14)', () => {
    test('create with caller-owned workId → 201 work-scoped subscription + one-time signingSecret', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, owner.access_token, {
            name: `sec-wh-own-${uniq()}`,
        });
        expect(work.id).toBeTruthy();

        const { status, body } = await createSubscription(request, owner.access_token, {
            url: `https://example.com/sec-own-${uniq()}`,
            workId: work.id,
        });
        expect(status).toBe(201);
        expect(body.subscription?.workId).toBe(work.id);
        expect(body.subscription?.accountId).toBe(owner.user.id);
        expect(body.subscription?.status).toBe('active');
        expect(body.subscription?.consecutiveFailures).toBe(0);
        // The RAW signing secret appears in THIS response only.
        expect(typeof body.signingSecret).toBe('string');
        expect((body.signingSecret as string).length).toBeGreaterThan(20);
    });

    test('create without workId → 201 null-scoped (account-wide) subscription', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const { status, body } = await createSubscription(request, user.access_token, {
            url: `https://example.com/sec-null-scope-${uniq()}`,
        });
        expect(status).toBe(201);
        expect(body.subscription?.workId).toBeNull();
        expect(body.subscription?.accountId).toBe(user.user.id);
        expect(typeof body.signingSecret).toBe('string');
    });

    test('create with FOREIGN workId → 404 (never 403/500) and NO subscription row created', async ({
        request,
    }) => {
        const victim = await registerUserViaAPI(request);
        const attacker = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, victim.access_token, {
            name: `sec-wh-foreign-${uniq()}`,
        });

        const { status, body } = await createSubscription(request, attacker.access_token, {
            url: `https://example.com/sec-exfil-${uniq()}`,
            workId: work.id,
        });
        // The ownership gate masks Forbidden as NotFound — a 403 (or a 500
        // from an unguarded lookup) would confirm the workId exists.
        expect(status, 'foreign workId must surface as 404, not 403/500').toBe(404);
        expect(body.message).toBe(`Work with id '${work.id}' not found`);

        // And the refusal must not have persisted anything.
        const attackerSubs = await listSubscriptions(request, attacker.access_token);
        expect(attackerSubs).toHaveLength(0);
    });

    test('create with NONEXISTENT workId → 404 with the same message template (no enumeration)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const { status, body } = await createSubscription(request, user.access_token, {
            url: `https://example.com/sec-absent-${uniq()}`,
            workId: ABSENT_UUID,
        });
        expect(status).toBe(404);
        // Same template as the foreign-workId refusal — message level reveals
        // nothing about whether the work exists.
        expect(body.message).toBe(`Work with id '${ABSENT_UUID}' not found`);
    });

    test('create with malformed (non-UUID) workId → 400 at the DTO, before any ownership lookup', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const { status, body } = await createSubscription(request, user.access_token, {
            url: `https://example.com/sec-malformed-${uniq()}`,
            workId: 'not-a-uuid',
        });
        expect(status).toBe(400);
        expect(body.message).toContain('workId must be a UUID');
    });

    test('create with non-http(s) url scheme → 400 at the DTO', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const { status, body } = await createSubscription(request, user.access_token, {
            url: 'javascript:alert(1)',
        });
        expect(status).toBe(400);
        expect(body.message).toContain('url must be a URL address');
    });

    test('anonymous create → 401 before any workId processing', async ({ playwright }) => {
        // Fresh request context — no storageState, no inherited cookies.
        const anon = await playwright.request.newContext();
        try {
            const res = await anon.post(WEBHOOKS, {
                data: { url: 'https://example.com/sec-anon', workId: ABSENT_UUID },
            });
            expect(res.status()).toBe(401);
            const body = (await res.json()) as { message?: string };
            expect(body.message).toBe('Unauthorized');
        } finally {
            await anon.dispose();
        }
    });
});

test.describe('SEC PIN: webhook findOwn — cross-account access masked as 404', () => {
    test('user B cannot DELETE user A subscription → 404 mask, row survives for A', async ({
        request,
    }) => {
        const a = await registerUserViaAPI(request);
        const b = await registerUserViaAPI(request);
        const { status, body } = await createSubscription(request, a.access_token, {
            url: `https://example.com/sec-del-${uniq()}`,
        });
        expect(status).toBe(201);
        const subId = (body.subscription as SubscriptionView).id;

        const del = await request.delete(`${WEBHOOKS}/${subId}`, {
            headers: authedHeaders(b.access_token),
        });
        expect(del.status(), 'cross-account DELETE must be 404, not 403').toBe(404);
        const delBody = (await del.json()) as { message?: string };
        expect(delBody.message).toBe('Webhook subscription not found');

        // The row must be untouched — A still sees it active.
        const aSubs = await listSubscriptions(request, a.access_token);
        expect(aSubs.map((s) => s.id)).toContain(subId);
        expect(aSubs.find((s) => s.id === subId)?.status).toBe('active');
    });

    test('user B cannot PATCH(pause) user A subscription → 404; owner pause still works → 200', async ({
        request,
    }) => {
        const a = await registerUserViaAPI(request);
        const b = await registerUserViaAPI(request);
        const { body } = await createSubscription(request, a.access_token, {
            url: `https://example.com/sec-pause-${uniq()}`,
        });
        const subId = (body.subscription as SubscriptionView).id;

        const foreign = await request.patch(`${WEBHOOKS}/${subId}`, {
            headers: authedHeaders(b.access_token),
            data: { status: 'paused' },
        });
        expect(foreign.status()).toBe(404);
        expect(((await foreign.json()) as { message?: string }).message).toBe(
            'Webhook subscription not found',
        );

        // The mask did not break the legitimate path.
        const own = await request.patch(`${WEBHOOKS}/${subId}`, {
            headers: authedHeaders(a.access_token),
            data: { status: 'paused' },
        });
        expect(own.status()).toBe(200);
        const paused = (await own.json()) as SubscriptionView;
        expect(paused.id).toBe(subId);
        expect(paused.status).toBe('paused');
    });

    test('user B cannot rotate-secret on user A subscription → 404, identical to nonexistent-id 404', async ({
        request,
    }) => {
        const a = await registerUserViaAPI(request);
        const b = await registerUserViaAPI(request);
        const { body } = await createSubscription(request, a.access_token, {
            url: `https://example.com/sec-rotate-${uniq()}`,
        });
        const subId = (body.subscription as SubscriptionView).id;

        const foreign = await request.post(`${WEBHOOKS}/${subId}/rotate-secret`, {
            headers: authedHeaders(b.access_token),
        });
        const absent = await request.post(`${WEBHOOKS}/${ABSENT_UUID}/rotate-secret`, {
            headers: authedHeaders(b.access_token),
        });
        expect(foreign.status()).toBe(404);
        expect(absent.status()).toBe(404);
        // Byte-identical refusals: an attacker probing ids learns nothing.
        const foreignBody = (await foreign.json()) as { message?: string };
        const absentBody = (await absent.json()) as { message?: string };
        expect(foreignBody.message).toBe('Webhook subscription not found');
        expect(foreignBody).toEqual(absentBody);
    });

    test('user B cannot test-fire user A subscription → 404 (no outbound delivery on foreign rows)', async ({
        request,
    }) => {
        const a = await registerUserViaAPI(request);
        const b = await registerUserViaAPI(request);
        const { body } = await createSubscription(request, a.access_token, {
            url: `https://example.com/sec-testfire-${uniq()}`,
        });
        const subId = (body.subscription as SubscriptionView).id;

        const res = await request.post(`${WEBHOOKS}/${subId}/test`, {
            headers: authedHeaders(b.access_token),
        });
        expect(res.status()).toBe(404);
        expect(((await res.json()) as { message?: string }).message).toBe(
            'Webhook subscription not found',
        );
    });

    test('list is account-scoped and view objects never leak secret material', async ({
        request,
    }) => {
        const a = await registerUserViaAPI(request);
        const b = await registerUserViaAPI(request);
        const { body } = await createSubscription(request, a.access_token, {
            url: `https://example.com/sec-list-${uniq()}`,
        });
        const subId = (body.subscription as SubscriptionView).id;

        // B's list must not contain A's subscription (fresh B → empty).
        const bSubs = await listSubscriptions(request, b.access_token);
        expect(bSubs).toHaveLength(0);

        // A's list contains it, but with NO secret material — the raw
        // signing secret existed only in the create response.
        const aSubs = await listSubscriptions(request, a.access_token);
        const view = aSubs.find((s) => s.id === subId);
        expect(view).toBeTruthy();
        const keys = Object.keys(view as object);
        expect(keys).not.toContain('signingSecret');
        expect(keys).not.toContain('secretEncrypted');
        expect(keys).not.toContain('secret');
        expect(keys.sort()).toEqual(
            [
                'accountId',
                'consecutiveFailures',
                'createdAt',
                'id',
                'lastDeliveryAt',
                'status',
                'updatedAt',
                'url',
                'workId',
            ].sort(),
        );
    });

    test('owner DELETE → 204; deleted id then masks as the same 404; malformed id → 400 pipe', async ({
        request,
    }) => {
        const a = await registerUserViaAPI(request);
        const { body } = await createSubscription(request, a.access_token, {
            url: `https://example.com/sec-lifecycle-${uniq()}`,
        });
        const subId = (body.subscription as SubscriptionView).id;

        const del = await request.delete(`${WEBHOOKS}/${subId}`, {
            headers: authedHeaders(a.access_token),
        });
        expect(del.status()).toBe(204);

        // Deleted rows become indistinguishable from foreign/nonexistent ones.
        const again = await request.delete(`${WEBHOOKS}/${subId}`, {
            headers: authedHeaders(a.access_token),
        });
        expect(again.status()).toBe(404);
        expect(((await again.json()) as { message?: string }).message).toBe(
            'Webhook subscription not found',
        );

        // Non-UUID ids are rejected by ParseUUIDPipe before the service runs.
        const malformed = await request.delete(`${WEBHOOKS}/not-a-uuid`, {
            headers: authedHeaders(a.access_token),
        });
        expect(malformed.status()).toBe(400);
        expect(((await malformed.json()) as { message?: string }).message).toBe(
            'Validation failed (uuid is expected)',
        );

        const after = await listSubscriptions(request, a.access_token);
        expect(after.map((s) => s.id)).not.toContain(subId);
    });
});
