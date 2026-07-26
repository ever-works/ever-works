import { test, expect, type APIRequestContext, type APIResponse } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * Outbound webhook subscriptions — `/api/webhooks` — a VALIDATION + AUTHZ
 * MATRIX. This file deliberately owns the exhaustive per-field DTO
 * validation grid, the path-param UUID grid, the missing-route (405-as-404)
 * grid, and the abuse-control (throttle) surface — the angles the existing
 * webhook specs leave uncovered (they own the happy-path lifecycle, the
 * delivery-record contract, the workId-ownership gate, and HMAC signing).
 *
 * Every status / body / message below was probed against the LIVE local
 * e2e stack (API :3100, sqlite in-memory, NODE_ENV local so the DTO allows
 * BOTH http+https and the service SKIPS the SSRF/https gate — those checks
 * only fire in non-local envs, hence the env-adaptive tolerances noted
 * inline) with throwaway users before being asserted.
 *
 * PROBED CONTRACT (live-verified 2026-07-21):
 *   CreateWebhookSubscriptionDto { url: @IsUrl({require_protocol,protocols}),
 *     workId?: @IsUUID() } — global ValidationPipe is whitelist +
 *     forbidNonWhitelisted.
 *   POST /api/webhooks
 *     - bad url (non-http(s) scheme / non-string / empty / whitespace /
 *       space-embedded / no-protocol / garbage) → 400
 *       { message:['url must be a URL address'] }  (ONE canonical message).
 *     - url with embedded credentials (https://user:pass@host) → 201 ACCEPTED
 *       (IsUrl permits userinfo — a pinned boundary, not a reject).
 *     - http:// scheme → 201 locally / 400 in non-local (env-adaptive).
 *     - workId non-uuid / '' / wrong-variant uuid → 400
 *       { message:['workId must be a UUID'] }.
 *     - workId well-formed-but-absent → 404 { status:'error',
 *       message:"Work with id '<id>' not found" }  (Work-module error shape,
 *       NOT the {message,error,statusCode} envelope).
 *     - workId: null → 201, subscription.workId === null (account-wide).
 *     - unknown extra field → 400 { message:['property <x> should not exist'] }.
 *     - happy → 201 { subscription:{ id, accountId, workId, url,
 *       status:'active', consecutiveFailures:0, lastDeliveryAt:null,
 *       createdAt, updatedAt }, signingSecret } — secret returned ONCE.
 *   PATCH /api/webhooks/:id  UpdateWebhookSubscriptionDto { status?:
 *     @IsIn(['paused','active']) }
 *     - present-but-invalid status (number / '' / 'PAUSED' / 'deleted' /
 *       array) → 400 { message:['status must be one of the following values:
 *       paused, active'] }  (DTO array message).
 *     - status:null OR empty body {} → 400 { message:'status must be one of:
 *       paused' }  (SINGLE-string; @IsOptional skips null so the controller
 *       fall-through fires — DISTINCT message from present-but-invalid).
 *     - status:'active' → 400 'Resuming a paused subscription is not
 *       supported yet; recreate the subscription'.
 *     - unknown extra field → 400 ['property <x> should not exist'] even when
 *       status is valid (whitelist beats the controller branch).
 *     - status:'paused' → 200 view.status==='paused'.
 *   PATH-PARAM UUID grid (PATCH / DELETE / rotate-secret / test / redeliver):
 *     - malformed (non-uuid) → 400 'Validation failed (uuid is expected)'
 *       (ParseUUIDPipe).
 *     - well-formed absent → 404 'Webhook subscription not found' (sub routes)
 *       / 'Webhook delivery not found' (redeliver).
 *   MISSING ROUTES: GET /api/webhooks/:id and PUT /api/webhooks/:id have NO
 *     handler → 404 'Cannot <METHOD> <path>' (route-not-matched, fired BEFORE
 *     guards — DISTINCT from the resource 404). `/api/webhooks/deliveries` is
 *     a literal route registered before `/:id`, so it is NOT swallowed by the
 *     UUID pipe.
 *   AUTHZ: every verb 401 without a bearer / with a garbage bearer.
 *     Cross-account access to another user's subscription OR delivery id is
 *     masked as 404 (never 403/500) and is byte-identical to the absent-id
 *     404 (enumeration defense). A second account's deliveries listing never
 *     contains the first account's rows.
 *   ABUSE: POST /:id/rotate-secret is @Throttle long 5/60s per ACCOUNT — a
 *     burst past 5 yields 429 ThrottlerException.
 *
 * NON-DUPLICATION — read FIRST, intentionally NOT re-pinned here:
 *   - sec-pin-webhook-ownership.spec.ts owns the workId create-binding gate
 *     (own/foreign/absent) and the cross-account 404 mask on the WRITE verbs
 *     (patch/delete/rotate/test). This file adds the DELIVERIES-surface
 *     cross-account matrix (redeliver + listing isolation) and the 404-message
 *     BYTE-IDENTITY assertion, plus the empty-string / null / wrong-variant
 *     workId cells and the forbidNonWhitelisted create cell.
 *   - flow-webhooks-subscriptions-multistep.spec.ts owns the full
 *     create→fire→redeliver→rotate→pause→delete journey, the SSRF env-gating,
 *     and secret-returned-once. This file adds the exhaustive url TYPE grid
 *     (number/boolean/array/object/null/whitespace) and the creds-embedded
 *     ACCEPTED boundary.
 *   - flow-webhooks-delivery-deep.spec.ts owns the delivery-VIEW record
 *     contract and the pause/active/empty PATCH branches. This file adds the
 *     status TYPE grid and — critically — the null-vs-empty-string MESSAGE
 *     DIVERGENCE and the patch-forbidNonWhitelisted cell.
 *   - flow-work-webhook-signatures.spec.ts owns the HMAC signing contract.
 *     This file's rotation test asserts only key-DISTINCTNESS + view hygiene,
 *     not the signature semantics.
 *   This file therefore OWNS: per-field DTO validation grids, the path-param
 *   UUID grid across ALL five id routes at once, the missing-route 404 grid,
 *   the deliveries-surface cross-account isolation, and the rotate throttle.
 *
 * ISOLATION: every test registers FRESH user(s) via registerUserViaAPI — the
 * shared seeded user is never touched. Non-2xx create attempts still count
 * against the per-user 10/60s create bucket (throttler runs BEFORE the
 * ValidationPipe), so each test keeps its create-POST count well under 10.
 * URLs carry a per-test unique suffix. All assertions are API-contract level;
 * receivers are unreachable hosts so NO real outbound delivery is needed.
 */

const WEBHOOKS = `${API_BASE}/api/webhooks`;
const DELIVERIES = `${WEBHOOKS}/deliveries`;

/** Canonical v4 UUID (version 4, variant 8) that no live row will carry. */
const ABSENT_UUID = '00000000-0000-4000-8000-000000000000';

/** Per-test monotonic counter — unique URL suffixes without a module-scope clock. */
let seq = 0;
function uniqUrl(tag: string): string {
    seq += 1;
    return `https://webhook.invalid.ever.works/${tag}-${seq}-${Math.random().toString(36).slice(2, 8)}`;
}

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

async function createSub(
    request: APIRequestContext,
    token: string,
    tag: string,
): Promise<{ view: SubscriptionView; signingSecret: string }> {
    const res = await request.post(WEBHOOKS, {
        headers: authedHeaders(token),
        data: { url: uniqUrl(tag) },
    });
    expect(res.status()).toBe(201);
    const body = (await res.json()) as { subscription: SubscriptionView; signingSecret: string };
    expect(body.subscription.status).toBe('active');
    return { view: body.subscription, signingSecret: body.signingSecret };
}

// ---------------------------------------------------------------------------
// CREATE — `url` field validation grid
// ---------------------------------------------------------------------------
test.describe('Webhooks create — url field validation grid', () => {
    test('non-http(s) URL schemes are rejected 400 at the DTO (javascript/file/data/ftp)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const schemes = [
            'javascript:alert(1)',
            'file:///etc/passwd',
            'data:text/html,<script>1</script>',
            'ftp://ftp.example.com/x',
        ];
        for (const url of schemes) {
            const res = await request.post(WEBHOOKS, {
                headers: authedHeaders(u.access_token),
                data: { url },
            });
            expect(res.status(), `scheme ${url}`).toBe(400);
            const body = (await res.json()) as { message: string[] };
            expect(Array.isArray(body.message)).toBe(true);
            expect(body.message).toContain('url must be a URL address');
        }
    });

    test('non-string url JSON types are rejected 400 with the SAME canonical message', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const values: unknown[] = [
            12345,
            true,
            ['https://a.example.com/h'],
            { href: 'https://a.example.com' },
            null,
        ];
        for (const url of values) {
            const res = await request.post(WEBHOOKS, {
                headers: authedHeaders(u.access_token),
                data: { url },
            });
            expect(res.status(), `url=${JSON.stringify(url)}`).toBe(400);
            const body = (await res.json()) as { message: string[] };
            expect(body.message).toContain('url must be a URL address');
        }
    });

    test('empty, whitespace, missing, and malformed url are rejected 400', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        // Distinct malformed shapes, all collapsing to the single DTO message.
        const bodies: Record<string, unknown>[] = [
            { url: '' },
            { url: '   ' },
            {}, // missing entirely
            { url: 'example.com/no-protocol' },
            { url: 'https://ex ample.com/space' },
            { url: 'not a url at all' },
        ];
        for (const data of bodies) {
            const res = await request.post(WEBHOOKS, {
                headers: authedHeaders(u.access_token),
                data,
            });
            expect(res.status(), JSON.stringify(data)).toBe(400);
            const body = (await res.json()) as { message: string[] };
            expect(body.message).toContain('url must be a URL address');
        }
    });

    test('a well-formed https url is accepted 201 with the full view + one-time secret', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.post(WEBHOOKS, {
            headers: authedHeaders(u.access_token),
            data: { url: uniqUrl('happy') },
        });
        expect(res.status()).toBe(201);
        const body = (await res.json()) as {
            subscription: SubscriptionView;
            signingSecret: string;
        };
        const v = body.subscription;
        // Full zero-state view field set + correct types.
        expect(typeof v.id).toBe('string');
        expect(v.accountId).toBe(u.user.id);
        expect(v.workId).toBeNull();
        expect(v.status).toBe('active');
        expect(v.consecutiveFailures).toBe(0);
        expect(v.lastDeliveryAt).toBeNull();
        expect(typeof v.createdAt).toBe('string');
        // Secret returned exactly once here, high-entropy, and NOT a view key.
        expect(typeof body.signingSecret).toBe('string');
        expect(body.signingSecret.length).toBeGreaterThanOrEqual(20);
        expect(Object.keys(v).some((k) => /secret/i.test(k))).toBe(false);
    });

    test('http scheme is env-gated (201 local / 400 non-local) and creds-embedded https is an accepted boundary', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        // http:// — allowed only in local dev/test envs; https required elsewhere.
        const httpRes = await request.post(WEBHOOKS, {
            headers: authedHeaders(u.access_token),
            data: {
                url: `http://webhook.invalid.ever.works/http-${Math.random().toString(36).slice(2, 8)}`,
            },
        });
        expect([201, 400], `http status ${httpRes.status()}`).toContain(httpRes.status());
        // userinfo in the authority is permitted by IsUrl — a pinned 201 boundary.
        const credRes = await request.post(WEBHOOKS, {
            headers: authedHeaders(u.access_token),
            data: {
                url: `https://user:pass@webhook.invalid.ever.works/c-${Math.random().toString(36).slice(2, 8)}`,
            },
        });
        expect(credRes.status()).toBe(201);
    });
});

// ---------------------------------------------------------------------------
// CREATE — `workId` field validation grid
// ---------------------------------------------------------------------------
test.describe('Webhooks create — workId field validation grid', () => {
    test('non-uuid / empty-string / wrong-variant workId are rejected 400 at the DTO', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        // '2222…' is well-shaped but its variant nibble (2) is invalid, so the
        // strict class-validator @IsUUID rejects it at the DTO (400) — distinct
        // from the ParseUUIDPipe on path params which is looser.
        const workIds = ['not-a-uuid', '', '22222222-2222-2222-2222-222222222222'];
        for (const workId of workIds) {
            const res = await request.post(WEBHOOKS, {
                headers: authedHeaders(u.access_token),
                data: { url: uniqUrl('wid-bad'), workId },
            });
            expect(res.status(), `workId=${JSON.stringify(workId)}`).toBe(400);
            const body = (await res.json()) as { message: string[] };
            expect(body.message).toContain('workId must be a UUID');
        }
    });

    test('a well-formed but nonexistent workId is masked as 404 (no enumeration)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.post(WEBHOOKS, {
            headers: authedHeaders(u.access_token),
            data: { url: uniqUrl('wid-absent'), workId: ABSENT_UUID },
        });
        expect(res.status()).toBe(404);
        const body = (await res.json()) as { message?: string };
        expect(body.message ?? '').toContain('not found');
        // The absent-workId 404 must not carry the bound subscription.
        expect(JSON.stringify(body)).not.toContain('signingSecret');
    });

    test('an explicit null workId is treated as account-wide → 201 with workId null', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.post(WEBHOOKS, {
            headers: authedHeaders(u.access_token),
            data: { url: uniqUrl('wid-null'), workId: null },
        });
        expect(res.status()).toBe(201);
        const body = (await res.json()) as { subscription: SubscriptionView };
        expect(body.subscription.workId).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// CREATE — strict body + secret hygiene
// ---------------------------------------------------------------------------
test.describe('Webhooks create — strict body + secret hygiene', () => {
    test('an unknown extra field is rejected 400 by forbidNonWhitelisted', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.post(WEBHOOKS, {
            headers: authedHeaders(u.access_token),
            data: { url: uniqUrl('extra'), extraneous: 'nope' },
        });
        expect(res.status()).toBe(400);
        const body = (await res.json()) as { message: string[] };
        expect(body.message).toContain('property extraneous should not exist');
    });

    test('the list view never leaks secret material and is scoped to the caller', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const { view } = await createSub(request, u.access_token, 'list-hygiene');
        const res = await request.get(WEBHOOKS, { headers: authedHeaders(u.access_token) });
        expect(res.status()).toBe(200);
        const body = (await res.json()) as { subscriptions: SubscriptionView[] };
        expect(Array.isArray(body.subscriptions)).toBe(true);
        const ids = body.subscriptions.map((s) => s.id);
        expect(ids).toContain(view.id);
        for (const row of body.subscriptions) {
            expect(row.accountId).toBe(u.user.id);
            expect(Object.keys(row).some((k) => /secret/i.test(k))).toBe(false);
        }
        // The raw JSON must carry no secret-shaped key anywhere.
        expect(JSON.stringify(body)).not.toMatch(/signingSecret|secretEncrypted/i);
    });
});

// ---------------------------------------------------------------------------
// PATCH — `status` field validation grid
// ---------------------------------------------------------------------------
test.describe('Webhooks patch — status field validation grid', () => {
    test('present-but-invalid status values yield the DTO array message (400)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const { view } = await createSub(request, u.access_token, 'patch-invalid');
        const invalid: unknown[] = [123, '', 'PAUSED', 'deleted', ['paused']];
        for (const status of invalid) {
            const res = await request.patch(`${WEBHOOKS}/${view.id}`, {
                headers: authedHeaders(u.access_token),
                data: { status },
            });
            expect(res.status(), `status=${JSON.stringify(status)}`).toBe(400);
            const body = (await res.json()) as { message: string[] };
            expect(Array.isArray(body.message)).toBe(true);
            expect(body.message).toContain(
                'status must be one of the following values: paused, active',
            );
        }
    });

    test('null status and an empty body yield the SINGLE-string controller message (400)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const { view } = await createSub(request, u.access_token, 'patch-null');
        // @IsOptional skips null → DTO passes → controller fall-through fires.
        for (const data of [{ status: null }, {}]) {
            const res = await request.patch(`${WEBHOOKS}/${view.id}`, {
                headers: authedHeaders(u.access_token),
                data,
            });
            expect(res.status(), JSON.stringify(data)).toBe(400);
            const body = (await res.json()) as { message: string };
            // Distinct from the present-but-invalid grid: a single string, not an array.
            expect(typeof body.message).toBe('string');
            expect(body.message).toBe('status must be one of: paused');
        }
    });

    test('status:active is a hard 400 (resume is intentionally unsupported)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const { view } = await createSub(request, u.access_token, 'patch-active');
        const res = await request.patch(`${WEBHOOKS}/${view.id}`, {
            headers: authedHeaders(u.access_token),
            data: { status: 'active' },
        });
        expect(res.status()).toBe(400);
        const body = (await res.json()) as { message: string };
        expect(body.message).toContain('Resuming a paused subscription is not supported');
    });

    test('an unknown extra field is rejected before the status branch (forbidNonWhitelisted)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const { view } = await createSub(request, u.access_token, 'patch-extra');
        const res = await request.patch(`${WEBHOOKS}/${view.id}`, {
            headers: authedHeaders(u.access_token),
            data: { status: 'paused', sneaky: 1 },
        });
        expect(res.status()).toBe(400);
        const body = (await res.json()) as { message: string[] };
        expect(body.message).toContain('property sneaky should not exist');
    });

    test('a valid status:paused transition returns 200 with the paused view', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const { view } = await createSub(request, u.access_token, 'patch-ok');
        const res = await request.patch(`${WEBHOOKS}/${view.id}`, {
            headers: authedHeaders(u.access_token),
            data: { status: 'paused' },
        });
        expect(res.status()).toBe(200);
        const body = (await res.json()) as SubscriptionView;
        expect(body.id).toBe(view.id);
        expect(body.status).toBe('paused');
    });
});

// ---------------------------------------------------------------------------
// PATH-PARAM uuid grid — across every :id route at once
// ---------------------------------------------------------------------------
test.describe('Webhooks path-param uuid grid', () => {
    test('a malformed (non-uuid) path param is rejected 400 at ParseUUIDPipe on every id route', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const bad = 'not-a-uuid';
        const calls: { label: string; run: () => Promise<APIResponse> }[] = [
            {
                label: 'PATCH',
                run: () =>
                    request.patch(`${WEBHOOKS}/${bad}`, {
                        headers: authedHeaders(u.access_token),
                        data: { status: 'paused' },
                    }),
            },
            {
                label: 'DELETE',
                run: () =>
                    request.delete(`${WEBHOOKS}/${bad}`, {
                        headers: authedHeaders(u.access_token),
                    }),
            },
            {
                label: 'rotate-secret',
                run: () =>
                    request.post(`${WEBHOOKS}/${bad}/rotate-secret`, {
                        headers: authedHeaders(u.access_token),
                    }),
            },
            {
                label: 'test',
                run: () =>
                    request.post(`${WEBHOOKS}/${bad}/test`, {
                        headers: authedHeaders(u.access_token),
                    }),
            },
            {
                label: 'redeliver',
                run: () =>
                    request.post(`${DELIVERIES}/${bad}/redeliver`, {
                        headers: authedHeaders(u.access_token),
                    }),
            },
        ];
        for (const c of calls) {
            const res = await c.run();
            expect(res.status(), c.label).toBe(400);
            const body = (await res.json()) as { message: string };
            expect(body.message).toBe('Validation failed (uuid is expected)');
        }
    });

    test('a well-formed but absent subscription id is masked 404 on PATCH/DELETE/rotate/test', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const calls: { label: string; run: () => Promise<APIResponse> }[] = [
            {
                label: 'PATCH',
                run: () =>
                    request.patch(`${WEBHOOKS}/${ABSENT_UUID}`, {
                        headers: authedHeaders(u.access_token),
                        data: { status: 'paused' },
                    }),
            },
            {
                label: 'DELETE',
                run: () =>
                    request.delete(`${WEBHOOKS}/${ABSENT_UUID}`, {
                        headers: authedHeaders(u.access_token),
                    }),
            },
            {
                label: 'rotate-secret',
                run: () =>
                    request.post(`${WEBHOOKS}/${ABSENT_UUID}/rotate-secret`, {
                        headers: authedHeaders(u.access_token),
                    }),
            },
            {
                label: 'test',
                run: () =>
                    request.post(`${WEBHOOKS}/${ABSENT_UUID}/test`, {
                        headers: authedHeaders(u.access_token),
                    }),
            },
        ];
        for (const c of calls) {
            const res = await c.run();
            expect(res.status(), c.label).toBe(404);
            const body = (await res.json()) as { message: string };
            expect(body.message).toBe('Webhook subscription not found');
        }
    });

    test('a well-formed but absent delivery id → 404 (distinct not-found message)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.post(`${DELIVERIES}/${ABSENT_UUID}/redeliver`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status()).toBe(404);
        const body = (await res.json()) as { message: string };
        expect(body.message).toBe('Webhook delivery not found');
    });

    test('there is NO GET/PUT :id handler — missing routes are 404 "Cannot <METHOD>" (route-not-matched)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const getRes = await request.get(`${WEBHOOKS}/${ABSENT_UUID}`, {
            headers: authedHeaders(u.access_token),
        });
        expect(getRes.status()).toBe(404);
        const getBody = (await getRes.json()) as { message: string };
        // Route-not-matched message — distinct from the resource "not found".
        expect(getBody.message).toContain('Cannot GET');
        expect(getBody.message).not.toBe('Webhook subscription not found');

        const putRes = await request.fetch(`${WEBHOOKS}/${ABSENT_UUID}`, {
            method: 'PUT',
            headers: authedHeaders(u.access_token),
            data: { status: 'paused' },
        });
        expect(putRes.status()).toBe(404);
        const putBody = (await putRes.json()) as { message: string };
        expect(putBody.message).toContain('Cannot PUT');
    });

    test('the literal /deliveries route is not shadowed by the :id UUID pipe', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        // If `deliveries` were caught by PATCH/GET `/:id` ParseUUIDPipe this
        // would 400; instead it resolves the dedicated listing route → 200.
        const res = await request.get(DELIVERIES, { headers: authedHeaders(u.access_token) });
        expect(res.status()).toBe(200);
        const body = (await res.json()) as { deliveries: unknown[] };
        expect(Array.isArray(body.deliveries)).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// AUTHZ — auth gate + cross-account masking
// ---------------------------------------------------------------------------
test.describe('Webhooks authz — auth gate + cross-account masking', () => {
    test('every verb on the surface is auth-gated → 401 (missing + garbage bearer)', async ({
        request,
    }) => {
        const calls: {
            label: string;
            run: (headers?: Record<string, string>) => Promise<APIResponse>;
        }[] = [
            { label: 'GET list', run: (h) => request.get(WEBHOOKS, { headers: h }) },
            { label: 'GET deliveries', run: (h) => request.get(DELIVERIES, { headers: h }) },
            {
                label: 'POST create',
                run: (h) =>
                    request.post(WEBHOOKS, { headers: h, data: { url: uniqUrl('unauth') } }),
            },
            {
                label: 'PATCH',
                run: (h) =>
                    request.patch(`${WEBHOOKS}/${ABSENT_UUID}`, {
                        headers: h,
                        data: { status: 'paused' },
                    }),
            },
            {
                label: 'DELETE',
                run: (h) => request.delete(`${WEBHOOKS}/${ABSENT_UUID}`, { headers: h }),
            },
            {
                label: 'rotate-secret',
                run: (h) =>
                    request.post(`${WEBHOOKS}/${ABSENT_UUID}/rotate-secret`, { headers: h }),
            },
            {
                label: 'test',
                run: (h) => request.post(`${WEBHOOKS}/${ABSENT_UUID}/test`, { headers: h }),
            },
            {
                label: 'redeliver',
                run: (h) => request.post(`${DELIVERIES}/${ABSENT_UUID}/redeliver`, { headers: h }),
            },
        ];
        for (const c of calls) {
            const noAuth = await c.run();
            expect(noAuth.status(), `${c.label} no-bearer`).toBe(401);
            const garbage = await c.run({ Authorization: 'Bearer totally-invalid-token' });
            expect(garbage.status(), `${c.label} garbage-bearer`).toBe(401);
        }
    });

    test('a second account cannot redeliver the first account delivery id — 404 identical to the absent-id 404', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const other = await registerUserViaAPI(request);
        const { view } = await createSub(request, owner.access_token, 'xacct-redeliver');
        // Produce a real delivery row for the owner.
        const fire = await request.post(`${WEBHOOKS}/${view.id}/test`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(fire.status()).toBe(200);
        const fireBody = (await fire.json()) as { deliveryId: string; ok: boolean };
        expect(typeof fireBody.deliveryId).toBe('string');
        expect(typeof fireBody.ok).toBe('boolean');
        const deliveryId = fireBody.deliveryId;

        // Cross-account redeliver of a delivery id that DOES exist → 404 mask.
        const cross = await request.post(`${DELIVERIES}/${deliveryId}/redeliver`, {
            headers: authedHeaders(other.access_token),
        });
        expect(cross.status()).toBe(404);
        const crossBody = await cross.text();

        // Absent-id redeliver → 404. The two bodies must be byte-identical so
        // the attacker cannot distinguish "exists-but-not-yours" from "absent".
        const absent = await request.post(`${DELIVERIES}/${ABSENT_UUID}/redeliver`, {
            headers: authedHeaders(other.access_token),
        });
        expect(absent.status()).toBe(404);
        expect(await absent.text()).toBe(crossBody);

        // The owner CAN redeliver their own delivery → 202 with a NEW id.
        const own = await request.post(`${DELIVERIES}/${deliveryId}/redeliver`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(own.status()).toBe(202);
        const ownBody = (await own.json()) as {
            deliveryId: string;
            enqueued: boolean;
            runId: string | null;
        };
        expect(ownBody.enqueued).toBe(true);
        expect(ownBody.deliveryId).not.toBe(deliveryId);
        expect(ownBody.runId === null || typeof ownBody.runId === 'string').toBe(true);
    });

    test('the deliveries listing is account-scoped — a second account never sees the first account rows', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const other = await registerUserViaAPI(request);
        const { view } = await createSub(request, owner.access_token, 'xacct-list');
        const fire = await request.post(`${WEBHOOKS}/${view.id}/test`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(fire.status()).toBe(200);
        const ownerDeliveryId = ((await fire.json()) as { deliveryId: string }).deliveryId;

        // Owner sees their own delivery row.
        const ownerList = await request.get(DELIVERIES, {
            headers: authedHeaders(owner.access_token),
        });
        expect(ownerList.status()).toBe(200);
        const ownerRows = (
            (await ownerList.json()) as { deliveries: { id: string; subscriptionId: string }[] }
        ).deliveries;
        expect(ownerRows.map((r) => r.id)).toContain(ownerDeliveryId);

        // The other account's listing must NOT contain the owner's row or sub.
        const otherList = await request.get(DELIVERIES, {
            headers: authedHeaders(other.access_token),
        });
        expect(otherList.status()).toBe(200);
        const otherRows = (
            (await otherList.json()) as { deliveries: { id: string; subscriptionId: string }[] }
        ).deliveries;
        expect(otherRows.map((r) => r.id)).not.toContain(ownerDeliveryId);
        expect(otherRows.map((r) => r.subscriptionId)).not.toContain(view.id);
    });

    test('a second account cannot rotate/test/delete another account subscription — 404 mask identical to absent', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const other = await registerUserViaAPI(request);
        const { view } = await createSub(request, owner.access_token, 'xacct-write');
        const absentMsg = 'Webhook subscription not found';
        const foreign: { label: string; run: () => Promise<APIResponse> }[] = [
            {
                label: 'rotate-secret',
                run: () =>
                    request.post(`${WEBHOOKS}/${view.id}/rotate-secret`, {
                        headers: authedHeaders(other.access_token),
                    }),
            },
            {
                label: 'test',
                run: () =>
                    request.post(`${WEBHOOKS}/${view.id}/test`, {
                        headers: authedHeaders(other.access_token),
                    }),
            },
            {
                label: 'PATCH',
                run: () =>
                    request.patch(`${WEBHOOKS}/${view.id}`, {
                        headers: authedHeaders(other.access_token),
                        data: { status: 'paused' },
                    }),
            },
            {
                label: 'DELETE',
                run: () =>
                    request.delete(`${WEBHOOKS}/${view.id}`, {
                        headers: authedHeaders(other.access_token),
                    }),
            },
        ];
        for (const c of foreign) {
            const res = await c.run();
            expect(res.status(), c.label).toBe(404);
            expect(((await res.json()) as { message: string }).message).toBe(absentMsg);
        }
        // The owner's subscription survived every foreign attempt.
        const stillThere = await request.get(WEBHOOKS, {
            headers: authedHeaders(owner.access_token),
        });
        const ids = (
            (await stillThere.json()) as { subscriptions: { id: string }[] }
        ).subscriptions.map((s) => s.id);
        expect(ids).toContain(view.id);
    });
});

// ---------------------------------------------------------------------------
// ABUSE controls + secret rotation
// ---------------------------------------------------------------------------
test.describe('Webhooks abuse controls + secret rotation', () => {
    test('rotate-secret is throttled at 5/min per account — a burst trips 429', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const { view } = await createSub(request, u.access_token, 'throttle');
        const statuses: number[] = [];
        for (let i = 0; i < 7; i += 1) {
            const res = await request.post(`${WEBHOOKS}/${view.id}/rotate-secret`, {
                headers: authedHeaders(u.access_token),
            });
            statuses.push(res.status());
        }
        // First 5 rotations succeed within the window; the excess is 429.
        expect(statuses.slice(0, 5).every((s) => s === 200)).toBe(true);
        expect(statuses).toContain(429);
    });

    test('rotation mints a distinct secret each call while keeping the id + active status stable', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const { view, signingSecret: created } = await createSub(
            request,
            u.access_token,
            'rotate-unique',
        );
        const secrets = new Set<string>([created]);
        for (let i = 0; i < 3; i += 1) {
            const res = await request.post(`${WEBHOOKS}/${view.id}/rotate-secret`, {
                headers: authedHeaders(u.access_token),
            });
            expect(res.status()).toBe(200);
            const body = (await res.json()) as {
                subscription: SubscriptionView;
                signingSecret: string;
            };
            expect(body.subscription.id).toBe(view.id);
            expect(body.subscription.status).toBe('active');
            expect(typeof body.signingSecret).toBe('string');
            expect(secrets.has(body.signingSecret)).toBe(false); // distinct every time
            secrets.add(body.signingSecret);
        }
        // create + 3 rotations = 4 distinct secrets.
        expect(secrets.size).toBe(4);
        // The subscription view never carries the secret material.
        const list = await request.get(WEBHOOKS, { headers: authedHeaders(u.access_token) });
        expect(JSON.stringify(await list.json())).not.toMatch(/signingSecret|secretEncrypted/i);
    });
});
