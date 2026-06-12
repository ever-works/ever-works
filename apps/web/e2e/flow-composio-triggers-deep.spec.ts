import { test, expect, type APIRequestContext, type PlaywrightWorkerArgs } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * flow-composio-triggers-deep.spec.ts
 *
 * REAL-flow contracts for the Composio plugin-integration surface under
 * `api/plugins/composio` — the toolkit/connected-account reads
 * (`ComposioController`) and the trigger-subscription CRUD + `@Public`
 * webhook receiver (`ComposioTriggersController`).
 *
 * ───────────────────────────────────────────────────────────────────────────
 * REGRESSION ANCHOR — this file was born from a live bug it now pins.
 *
 * `ComposioTriggerSubscription` was `TypeOrmModule.forFeature`-registered (so
 * its repository injected) but was MISSING from the root DataSource `entities`
 * array in `packages/agent/src/database/database.config.ts`. With
 * `autoLoadEntities` unset, the explicit array is authoritative, so EVERY query
 * threw `EntityMetadataNotFoundError` → unmapped 500. Probed before the fix:
 *
 *   GET    /api/plugins/composio/triggers      -> 500  (now {"items":[]} 200)
 *   DELETE /api/plugins/composio/triggers/:id   -> 500  (now 404 not-found)
 *
 * The create path masked it (it 400s on "not configured" before the insert),
 * so a bare authenticated LIST is the cleanest regression probe — it must
 * never 500 again. (Fix: register the entity; no schema change — the
 * AddComposioTriggerSubscriptions migration already existed.)
 *
 * ───────────────────────────────────────────────────────────────────────────
 * NON-DUPLICATION: there is no other composio spec in the suite; this is the
 * first. It deliberately stays API-contract-only (no UI) because the surface
 * is config-gated and keyless CI cannot mint a real Composio connection.
 *
 * ENV-ADAPTIVE: CI is keyless (no Composio API key configured), so the
 * key-dependent endpoints (`toolkits`, `connected-accounts`, `connect`,
 * trigger `create`) deterministically 400 with the "not configured" message
 * AFTER auth + DTO validation. Triggers `list`/`delete` and the webhook are
 * key-INDEPENDENT (DB + signature only), so they assert exact shapes.
 *
 * PROBED CONTRACTS (live, http://127.0.0.1:3100, before writing):
 *   GET  /api/plugins/composio/triggers
 *        - authed                 -> 200 { items: [] }   (REGRESSION: was 500)
 *        - no auth                -> 401 { message:'Unauthorized', statusCode:401 }
 *   DELETE /api/plugins/composio/triggers/:id
 *        - authed, ghost uuid     -> 404 { message:'Trigger subscription not found', error:'Not Found', statusCode:404 }  (REGRESSION: was 500)
 *        - authed, non-uuid       -> 400 (ParseUUIDPipe)
 *        - no auth                -> 401
 *   POST /api/plugins/composio/triggers  (CreateComposioTriggerDto, authed)
 *        - {} empty               -> 400 message[]: toolkitSlug/triggerSlug/composioConnectedAccountId "should not be empty"/"must be a string"
 *        - valid body, keyless    -> 400 "The Composio plugin is not configured. ..."
 *   GET  /api/plugins/composio/toolkits | /connected-accounts  (authed)
 *        - keyless                -> 400 "The Composio plugin is not configured. ..."
 *        - no auth                -> 401
 *   POST /api/plugins/composio/connect  (InitiateConnectionRequestDto, authed)
 *        - {} empty               -> 400 message[]: toolkitSlug + authConfigId required
 *        - { toolkitSlug }        -> 400 message[]: authConfigId required
 *   POST /api/plugins/composio/webhook  (@Public, no auth)
 *        - missing trigger id     -> 400 { message:'Missing trigger id in webhook payload', error:'Bad Request' }
 *        - unknown tg id (top)    -> 404 { message:'Not Found', statusCode:404 }   (existence hidden)
 *        - unknown tg id (nested) -> 404                                            (metadata.trigger_id path)
 */

const COMPOSIO = `${API_BASE}/api/plugins/composio`;
const GHOST_UUID = '00000000-0000-0000-0000-000000000000';
const NOT_CONFIGURED = 'The Composio plugin is not configured';

async function anon(playwright: PlaywrightWorkerArgs['playwright']): Promise<APIRequestContext> {
    // Cookieless context → genuine unauthenticated requests against the API.
    return playwright.request.newContext();
}

test.describe('Composio triggers + webhook (integration)', () => {
    test('REGRESSION: authenticated trigger list returns 200 with an empty array (no EntityMetadataNotFound 500)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const res = await request.get(`${COMPOSIO}/triggers`, {
            headers: authedHeaders(user.access_token),
        });
        // The headline regression: this used to 500 because the entity was not
        // registered in the DataSource. It must be a clean empty list now.
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(body).toHaveProperty('items');
        expect(Array.isArray(body.items)).toBe(true);
        expect(body.items).toHaveLength(0);
    });

    test('REGRESSION: deleting a non-existent trigger is a clean 404, and a malformed id is a 400 (never 500)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);

        // Ghost (well-formed) uuid → NotFoundException surfaced as 404 (used to
        // 500 because the repo query threw before reaching the not-found guard).
        const ghost = await request.delete(`${COMPOSIO}/triggers/${GHOST_UUID}`, {
            headers: authedHeaders(user.access_token),
        });
        expect(ghost.status()).toBe(404);
        const ghostBody = await ghost.json();
        expect(ghostBody.message).toContain('Trigger subscription not found');

        // Malformed id → ParseUUIDPipe rejects with 400 BEFORE the handler runs.
        const bad = await request.delete(`${COMPOSIO}/triggers/not-a-uuid`, {
            headers: authedHeaders(user.access_token),
        });
        expect(bad.status()).toBe(400);
    });

    test('list + delete are auth-gated: unauthenticated requests are 401', async ({
        playwright,
    }) => {
        const ctx = await anon(playwright);
        try {
            const list = await ctx.get(`${COMPOSIO}/triggers`);
            expect(list.status()).toBe(401);

            const del = await ctx.delete(`${COMPOSIO}/triggers/${GHOST_UUID}`);
            expect(del.status()).toBe(401);
        } finally {
            await ctx.dispose();
        }
    });

    test('create-trigger DTO is validated before the (keyless) service: empty body 400s per-field; a valid body 400s "not configured"', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);

        // ValidationPipe runs before the controller body → aggregated per-field
        // errors for the three required string fields.
        const empty = await request.post(`${COMPOSIO}/triggers`, {
            headers: authedHeaders(user.access_token),
            data: {},
        });
        expect(empty.status()).toBe(400);
        const emptyBody = await empty.json();
        const joined = JSON.stringify(emptyBody.message);
        expect(joined).toContain('toolkitSlug');
        expect(joined).toContain('triggerSlug');
        expect(joined).toContain('composioConnectedAccountId');

        // Well-formed body passes validation, then the service refuses because
        // no Composio API key is configured (keyless CI). The insert is never
        // reached — which is exactly why the missing-entity bug hid here.
        const valid = await request.post(`${COMPOSIO}/triggers`, {
            headers: authedHeaders(user.access_token),
            data: {
                triggerSlug: 'GMAIL_NEW_EMAIL',
                toolkitSlug: 'GMAIL',
                composioConnectedAccountId: 'ca_e2e_probe',
            },
        });
        expect(valid.status()).toBe(400);
        const validBody = await valid.json();
        expect(JSON.stringify(validBody.message)).toContain(NOT_CONFIGURED);
    });

    test('toolkit + connected-account reads are auth-gated and config-gated (401 anon, 400 not-configured authed)', async ({
        request,
        playwright,
    }) => {
        const user = await registerUserViaAPI(request);

        for (const path of ['toolkits', 'connected-accounts']) {
            const authed = await request.get(`${COMPOSIO}/${path}`, {
                headers: authedHeaders(user.access_token),
            });
            expect(authed.status()).toBe(400);
            expect(JSON.stringify(await authed.json())).toContain(NOT_CONFIGURED);
        }

        const ctx = await anon(playwright);
        try {
            for (const path of ['toolkits', 'connected-accounts']) {
                const res = await ctx.get(`${COMPOSIO}/${path}`);
                expect(res.status()).toBe(401);
            }
        } finally {
            await ctx.dispose();
        }
    });

    test('connect requires the OAuth auth-config id: a partial body is rejected by validation', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);

        const empty = await request.post(`${COMPOSIO}/connect`, {
            headers: authedHeaders(user.access_token),
            data: {},
        });
        expect(empty.status()).toBe(400);
        expect(JSON.stringify((await empty.json()).message)).toContain('authConfigId');

        const partial = await request.post(`${COMPOSIO}/connect`, {
            headers: authedHeaders(user.access_token),
            data: { toolkitSlug: 'github' },
        });
        expect(partial.status()).toBe(400);
        expect(JSON.stringify((await partial.json()).message)).toContain('authConfigId');
    });

    test('public webhook resolves the subscription by trigger id: missing id 400s, unknown id 404s (existence hidden)', async ({
        playwright,
    }) => {
        // The webhook is @Public — no auth header. Use a cookieless context so
        // we exercise the genuine unauthenticated delivery path.
        const ctx = await anon(playwright);
        try {
            const webhook = `${COMPOSIO}/webhook`;

            const noId = await ctx.post(webhook, { data: { foo: 'bar' } });
            expect(noId.status()).toBe(400);
            expect((await noId.json()).message).toContain('Missing trigger id');

            // Unknown trigger id → 404 with NO body detail (the handler hides
            // whether a subscription exists). Both the legacy top-level and the
            // V3 nested `metadata.trigger_id` shapes resolve the same way.
            const unknownTop = await ctx.post(webhook, {
                data: { trigger_id: 'tg_e2e_unknown_top' },
            });
            expect(unknownTop.status()).toBe(404);

            const unknownNested = await ctx.post(webhook, {
                data: { metadata: { trigger_id: 'tg_e2e_unknown_nested' } },
            });
            expect(unknownNested.status()).toBe(404);
        } finally {
            await ctx.dispose();
        }
    });

    test('trigger lists are per-user scoped: two independent users each see their own empty list', async ({
        request,
    }) => {
        const a = await registerUserViaAPI(request);
        const b = await registerUserViaAPI(request);

        for (const u of [a, b]) {
            const res = await request.get(`${COMPOSIO}/triggers`, {
                headers: authedHeaders(u.access_token),
            });
            expect(res.status()).toBe(200);
            expect((await res.json()).items).toEqual([]);
        }
    });
});
