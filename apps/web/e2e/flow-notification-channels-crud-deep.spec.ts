import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * Notification CHANNELS — DEEP account/settings/integrations coverage targeting
 * the contract GAPS the prior channel specs leave open. Every assertion below
 * was probed via curl against http://127.0.0.1:3100 with throwaway registered
 * users BEFORE it was written, and cross-checked against the controller +
 * service + entity source.
 *
 * NON-DUPLICATION — sibling specs already own these surfaces (NOT repeated here):
 *   - notification-channels.spec.ts            (generic prefs GET shape + auth gate
 *                                                across candidate /api/notifications
 *                                                preference paths — NOT the channels
 *                                                CRUD controller).
 *   - flow-settings-notification-channels.spec.ts (the deep companion: multi-provider
 *                                                registry + targetConfig shapes,
 *                                                newest/oldest-first list ordering,
 *                                                the partial-PATCH semantics matrix
 *                                                [name-only/config-only/{}-noop/
 *                                                falsy-name/targetConfig:{}-clears],
 *                                                pluginId-immutability, the
 *                                                active-list-gate vs subscription-
 *                                                ownership-gate divergence, the
 *                                                per-channel test-send provider-error
 *                                                matrix, the events/:pluginId HAPPY
 *                                                202 path, and the settings UI table).
 *
 * THIS FILE pins the residual, security-flavored CONTRACTS those two never assert:
 *   1. SECRET-AT-REST contract — CORRECTING the common misconception. targetConfig
 *      carries live creds (Telegram botToken, Slack/Discord webhookUrl, Novu apiKey)
 *      and is envelope-encrypted at rest via @EncryptedJsonColumn (EW-716 #22). But
 *      that transformer is TRANSPARENT: the OWNER always reads back PLAINTEXT — the
 *      API does NOT mask the secret in responses (proven by probe: create + list
 *      echo the raw botToken verbatim). The real confidentiality boundary is the
 *      PER-USER SCOPE, not response masking. We pin both halves: owner round-trips
 *      the plaintext secret (create→list→PATCH-rotate→list), and a foreign user is
 *      fully walled off.
 *   2. CROSS-USER ISOLATION (IDOR) — a foreign channel id 404s on PATCH / DELETE /
 *      :id/test and is absent from the foreign user's list (findByIdForUser /
 *      findActiveByUser are both userId-scoped).
 *   3. CREATE DTO validation — the hardened CreateChannelDto: name>120 → 400,
 *      pluginId>64 → 400, missing/non-object targetConfig → 400,
 *      forbidNonWhitelisted strips+rejects smuggled fields (verified/userId) → 400.
 *   4. UPDATE DTO validation — forbidNonWhitelisted on PATCH rejects smuggled
 *      verified/userId/pluginId → 400 (a stronger immutability guarantee than a
 *      silent no-op).
 *   5. 16KB targetConfig SIZE CAP — assertTargetConfigSize() on create AND PATCH →
 *      400 "targetConfig exceeds the 16384-byte limit".
 *   6. ParseUUIDPipe — a NON-UUID :id on PATCH/DELETE/test → 400 (clean reject
 *      before TypeORM), distinct from a well-formed-but-unknown UUID → 404.
 *   7. events/:pluginId pluginId-SHAPE guard — the @Public webhook reflects the
 *      pluginId param, so a garbage/oversized pluginId is rejected 400
 *      "Invalid pluginId"; a well-formed id is 202 — ANONYMOUSLY (empty
 *      storageState, no bearer).
 *   8. AUTH GATES — list/create/patch/delete/test all 401 without a token.
 *   9. partial-key UNIQUENESS — the uq_notification_channel index is
 *      (userId,pluginId,name): same name + DIFFERENT pluginId is allowed (201).
 *
 * PROBED CONTRACTS (curl, 127.0.0.1:3100, fresh users):
 *   @Controller('api/notification-channels') (AuthSessionGuard except events):
 *     GET  /            -> 200 { channels: NotificationChannel[] } (own only, ASC).
 *     POST /            -> 201 { channel } — RESPONSE ECHOES targetConfig PLAINTEXT.
 *     PATCH /:id        -> 200 { channel } (own only; foreign → 404; non-UUID → 400).
 *     DELETE /:id       -> 204 (own only; foreign/unknown UUID → 404; non-UUID → 400).
 *     POST /:id/test    -> 201 { status, error? } DIRECT; foreign/unknown → 404
 *                          "Channel not found"; non-UUID → 400.
 *     POST events/:pluginId @Public -> 202 { received:true, pluginId } for a
 *                          well-formed id; 400 "Invalid pluginId" for a bad shape.
 *   Validation (global ValidationPipe whitelist+forbidNonWhitelisted):
 *     name>120 / pluginId>64 / non-object|missing targetConfig / smuggled field → 400.
 *     targetConfig serialized > 16384 bytes → 400 (controller assertTargetConfigSize).
 *
 * ENVIRONMENT NOTES (CI-faithful):
 *   - FULL ISOLATION: every test registers its OWN fresh users via the API; no
 *     module-scope state, no clock-suffix at module scope. Counts use
 *     toContain/not.toContain, never exact totals (shared in-memory DB).
 *   - KEYLESS CI: PLUGIN_SECRET_ENCRYPTION_KEY is unset, so @EncryptedJsonColumn
 *     passes through as plaintext at rest too — but the OWNER-reads-plaintext API
 *     contract holds identically whether or not a key is configured, so the secret
 *     round-trip assertions are env-agnostic.
 *   - No channel-delivery plugin is enabled, so :id/test on an owned channel is a
 *     truthful failure; a positive status is also tolerated.
 *   - PUBLIC webhook uses an EMPTY-storageState context so the shared auth cookie
 *     is NOT inherited (a bare newContext() would carry it).
 */

const TIMEOUT = 20_000;
const BOGUS_UUID = '00000000-0000-0000-0000-000000000000';
const CHANNELS = `${API_BASE}/api/notification-channels`;

interface NotificationChannel {
    id: string;
    userId: string;
    pluginId: string;
    name: string;
    targetConfig: Record<string, unknown>;
    verified: boolean;
    disabledAt: string | null;
    createdAt: string;
    updatedAt: string;
}

async function listChannels(
    request: APIRequestContext,
    token: string,
): Promise<NotificationChannel[]> {
    const res = await request.get(CHANNELS, {
        headers: authedHeaders(token),
        timeout: TIMEOUT,
    });
    expect(res.status(), `list body=${await res.text().catch(() => '')}`).toBe(200);
    return (await res.json()).channels as NotificationChannel[];
}

async function createChannel(
    request: APIRequestContext,
    token: string,
    data: { pluginId: string; name: string; targetConfig: Record<string, unknown> },
): Promise<NotificationChannel> {
    const res = await request.post(CHANNELS, {
        headers: authedHeaders(token),
        data,
        timeout: TIMEOUT,
    });
    expect(res.status(), `create body=${await res.text().catch(() => '')}`).toBe(201);
    return (await res.json()).channel as NotificationChannel;
}

// A per-test monotonic counter keeps channel names unique WITHOUT a module-scope
// clock read. Each call yields a fresh integer for the running test process.
let nameSeq = 0;
function uniqueName(prefix: string): string {
    nameSeq += 1;
    return `${prefix}-${nameSeq}-${Math.random().toString(36).slice(2, 8)}`;
}

test.describe('Notification channels — deep CRUD / isolation / validation contracts', () => {
    test('secret-at-rest: owner reads back PLAINTEXT creds (no API masking); round-trip survives create→list→PATCH-rotate', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request, {
            email: `nch-secret-${uniqueName('s')}@test.local`,
        });
        const token = u.access_token;

        const secretToken = 'BOT-123456:SUPER_SECRET_TELEGRAM_TOKEN';
        const ch = await createChannel(request, token, {
            pluginId: 'telegram-channel',
            name: uniqueName('Secret'),
            targetConfig: { botToken: secretToken, chatId: '@ops' },
        });

        // The CREATE response is the FIRST read path: it echoes the cred VERBATIM.
        // @EncryptedJsonColumn is a transparent transformer — the owner always sees
        // plaintext; there is NO response-level masking. This is the truthful
        // confidentiality contract: the boundary is the per-user scope, not masking.
        expect(ch.targetConfig.botToken, 'create echoes the raw botToken to the owner').toBe(
            secretToken,
        );

        // The LIST read path round-trips the SAME plaintext (decrypt-on-read is
        // lossless). Multi-key configs survive intact.
        const listed = (await listChannels(request, token)).find((c) => c.id === ch.id)!;
        expect(listed.targetConfig).toEqual({ botToken: secretToken, chatId: '@ops' });

        // Rotating the secret via PATCH and reading it back proves the encrypt→
        // decrypt round-trip on the WRITE path too (a new ciphertext at rest still
        // decrypts to the new plaintext for the owner).
        const rotated = 'BOT-999999:ROTATED_TELEGRAM_TOKEN';
        const patchRes = await request.patch(`${CHANNELS}/${ch.id}`, {
            headers: authedHeaders(token),
            data: { targetConfig: { botToken: rotated, chatId: '@ops2' } },
            timeout: TIMEOUT,
        });
        expect(patchRes.status()).toBe(200);
        expect((await patchRes.json()).channel.targetConfig).toEqual({
            botToken: rotated,
            chatId: '@ops2',
        });
        const afterRotate = (await listChannels(request, token)).find((c) => c.id === ch.id)!;
        expect(afterRotate.targetConfig.botToken, 'rotated secret round-trips on read').toBe(
            rotated,
        );
    });

    test('cross-user isolation: a foreign channel 404s on PATCH/DELETE/test and is absent from the foreign list', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request, {
            email: `nch-owner-${uniqueName('o')}@test.local`,
        });
        const attacker = await registerUserViaAPI(request, {
            email: `nch-attacker-${uniqueName('a')}@test.local`,
        });

        const ch = await createChannel(request, owner.access_token, {
            pluginId: 'slack-channel',
            name: uniqueName('Private'),
            targetConfig: { webhookUrl: 'https://hooks.slack.com/services/T/B/secret' },
        });

        // The attacker's list never surfaces another user's channel.
        expect(
            (await listChannels(request, attacker.access_token)).map((c) => c.id),
            'foreign channel must not leak into the attacker list',
        ).not.toContain(ch.id);

        // PATCH — findOwnedOrThrow (userId-scoped) → 404, NOT a silent success.
        const fPatch = await request.patch(`${CHANNELS}/${ch.id}`, {
            headers: authedHeaders(attacker.access_token),
            data: { name: 'pwned' },
            timeout: TIMEOUT,
        });
        expect(fPatch.status()).toBe(404);
        expect((await fPatch.json()).message).toBe('Channel not found');

        // :id/test — also gated by findOwnedOrThrow → 404 (no leak of send result).
        const fTest = await request.post(`${CHANNELS}/${ch.id}/test`, {
            headers: authedHeaders(attacker.access_token),
            timeout: TIMEOUT,
        });
        expect(fTest.status()).toBe(404);
        expect((await fTest.json()).message).toBe('Channel not found');

        // DELETE — 404 for the foreigner, and the OWNER still has the row after.
        const fDelete = await request.delete(`${CHANNELS}/${ch.id}`, {
            headers: authedHeaders(attacker.access_token),
            timeout: TIMEOUT,
        });
        expect(fDelete.status()).toBe(404);
        expect(
            (await listChannels(request, owner.access_token)).map((c) => c.id),
            'a failed foreign delete must not remove the owner row',
        ).toContain(ch.id);
    });

    test('CREATE DTO validation: name>120, pluginId>64, missing/non-object targetConfig, smuggled fields all 400', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request, {
            email: `nch-cval-${uniqueName('c')}@test.local`,
        });
        const token = u.access_token;
        const ok = { pluginId: 'slack-channel', targetConfig: {} };

        const bad: Array<{ label: string; data: Record<string, unknown> }> = [
            { label: 'name > 120 chars', data: { ...ok, name: 'n'.repeat(130) } },
            {
                label: 'pluginId > 64 chars',
                data: { pluginId: 'p'.repeat(70), name: 'ok', targetConfig: {} },
            },
            { label: 'missing targetConfig', data: { pluginId: 'slack-channel', name: 'ok' } },
            {
                label: 'targetConfig is a string (not object)',
                data: { pluginId: 'slack-channel', name: 'ok', targetConfig: 'nope' },
            },
            {
                label: 'empty pluginId (MinLength 1)',
                data: { pluginId: '', name: 'ok', targetConfig: {} },
            },
            {
                label: 'empty name (MinLength 1)',
                data: { pluginId: 'slack-channel', name: '', targetConfig: {} },
            },
            {
                label: 'forbidNonWhitelisted: smuggled verified',
                data: { pluginId: 'slack-channel', name: 'ok', targetConfig: {}, verified: true },
            },
            {
                label: 'forbidNonWhitelisted: smuggled userId',
                data: {
                    pluginId: 'slack-channel',
                    name: 'ok',
                    targetConfig: {},
                    userId: BOGUS_UUID,
                },
            },
        ];

        for (const c of bad) {
            const res = await request.post(CHANNELS, {
                headers: authedHeaders(token),
                data: c.data,
                timeout: TIMEOUT,
            });
            expect(res.status(), `create rejects: ${c.label}`).toBe(400);
        }

        // Control: a clean, well-formed create still succeeds (the validation isn't
        // a blanket reject).
        const good = await createChannel(request, token, {
            pluginId: 'slack-channel',
            name: uniqueName('Valid'),
            targetConfig: { webhookUrl: 'https://hooks.slack.com/services/T/B/ok' },
        });
        expect(good.id).toBeTruthy();
        expect(good.verified, 'verified is server-set false, never client-controlled').toBe(false);
    });

    test('UPDATE DTO validation: forbidNonWhitelisted rejects smuggled verified/userId/pluginId on PATCH', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request, {
            email: `nch-uval-${uniqueName('u')}@test.local`,
        });
        const token = u.access_token;
        const ch = await createChannel(request, token, {
            pluginId: 'discord-channel',
            name: uniqueName('Patchable'),
            targetConfig: { webhookUrl: 'https://discord.com/api/webhooks/1/a' },
        });

        for (const smuggle of [
            { label: 'verified', data: { verified: true } },
            { label: 'userId', data: { userId: BOGUS_UUID } },
            { label: 'pluginId (provider is immutable)', data: { pluginId: 'slack-channel' } },
            { label: 'id', data: { id: BOGUS_UUID } },
        ]) {
            const res = await request.patch(`${CHANNELS}/${ch.id}`, {
                headers: authedHeaders(token),
                data: smuggle.data,
                timeout: TIMEOUT,
            });
            expect(res.status(), `PATCH rejects smuggled ${smuggle.label}`).toBe(400);
        }

        // The channel is untouched by every rejected PATCH: provider + verified flag
        // are exactly as created.
        const after = (await listChannels(request, token)).find((c) => c.id === ch.id)!;
        expect(after.pluginId).toBe('discord-channel');
        expect(after.verified).toBe(false);
    });

    test('16KB targetConfig size cap: oversized blob is rejected 400 on CREATE and on PATCH', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request, {
            email: `nch-size-${uniqueName('z')}@test.local`,
        });
        const token = u.access_token;
        // 17_000 chars serializes to > 16_384 bytes including the JSON envelope.
        const oversized = { blob: 'x'.repeat(17_000) };

        const createRes = await request.post(CHANNELS, {
            headers: authedHeaders(token),
            data: { pluginId: 'slack-channel', name: uniqueName('Big'), targetConfig: oversized },
            timeout: TIMEOUT,
        });
        expect(createRes.status(), 'oversized targetConfig rejected on create').toBe(400);
        expect((await createRes.json()).message).toContain('16384');

        // Create a small channel, then PATCH it with an oversized config: the cap
        // applies on the update path too (assertTargetConfigSize runs in update()).
        const ch = await createChannel(request, token, {
            pluginId: 'slack-channel',
            name: uniqueName('Small'),
            targetConfig: { webhookUrl: 'https://hooks.slack.com/services/T/B/s' },
        });
        const patchRes = await request.patch(`${CHANNELS}/${ch.id}`, {
            headers: authedHeaders(token),
            data: { targetConfig: oversized },
            timeout: TIMEOUT,
        });
        expect(patchRes.status(), 'oversized targetConfig rejected on patch').toBe(400);
        expect((await patchRes.json()).message).toContain('16384');

        // The original small config is untouched after the rejected oversized PATCH.
        const after = (await listChannels(request, token)).find((c) => c.id === ch.id)!;
        expect(after.targetConfig).toEqual({
            webhookUrl: 'https://hooks.slack.com/services/T/B/s',
        });
    });

    test('ParseUUIDPipe: a NON-UUID :id is a clean 400 on PATCH/DELETE/test (distinct from unknown-UUID 404)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request, {
            email: `nch-uuid-${uniqueName('p')}@test.local`,
        });
        const token = u.access_token;

        // Non-UUID ids are rejected by the pipe BEFORE the service runs → 400.
        for (const verb of ['patch', 'delete', 'test'] as const) {
            const url = verb === 'test' ? `${CHANNELS}/not-a-uuid/test` : `${CHANNELS}/not-a-uuid`;
            let res;
            if (verb === 'patch') {
                res = await request.patch(url, {
                    headers: authedHeaders(token),
                    data: { name: 'x' },
                    timeout: TIMEOUT,
                });
            } else if (verb === 'delete') {
                res = await request.delete(url, {
                    headers: authedHeaders(token),
                    timeout: TIMEOUT,
                });
            } else {
                res = await request.post(url, { headers: authedHeaders(token), timeout: TIMEOUT });
            }
            expect(res.status(), `non-UUID ${verb} → 400`).toBe(400);
        }

        // CONTRAST: a well-FORMED but unknown UUID passes the pipe and reaches the
        // service's findOwnedOrThrow → 404 "Channel not found". This proves the 400
        // above is the pipe (shape), not a missing-row (existence) error.
        const unknownPatch = await request.patch(`${CHANNELS}/${BOGUS_UUID}`, {
            headers: authedHeaders(token),
            data: { name: 'x' },
            timeout: TIMEOUT,
        });
        expect(unknownPatch.status(), 'unknown-but-valid UUID → 404').toBe(404);
        expect((await unknownPatch.json()).message).toBe('Channel not found');
    });

    test('events/:pluginId @Public webhook: well-formed id → 202 anonymously; bad-shape id → 400 "Invalid pluginId"', async ({
        browser,
    }) => {
        // ANON context with EMPTY storageState so the shared auth cookie is NOT
        // inherited — the webhook is @Public and must work with no credentials.
        const anonContext = await browser.newContext({
            storageState: { cookies: [], origins: [] },
        });
        const anon = anonContext.request;
        try {
            // Well-formed plugin ids are accepted unauthenticated, echoing the param.
            for (const pluginId of ['slack-channel', 'novu-channel', 'whatsapp-channel']) {
                const res = await anon.post(`${CHANNELS}/events/${pluginId}`, {
                    data: { event: 'delivered' },
                    timeout: TIMEOUT,
                });
                expect(res.status(), `webhook ${pluginId}`).toBe(202);
                const body = await res.json();
                expect(body.received).toBe(true);
                expect(body.pluginId).toBe(pluginId);
            }

            // The controller constrains the reflected pluginId to a plugin-id shape
            // so an anonymous caller can't echo arbitrary/oversized garbage back.
            // A pluginId with illegal characters is rejected 400 "Invalid pluginId".
            const badChars = await anon.post(
                `${CHANNELS}/events/${encodeURIComponent('bad id!')}`,
                { data: {}, timeout: TIMEOUT },
            );
            expect(badChars.status(), 'illegal-char pluginId → 400').toBe(400);
            expect((await badChars.json()).message).toBe('Invalid pluginId');

            // An over-length pluginId (> 64 chars) also fails the shape guard.
            const tooLong = await anon.post(`${CHANNELS}/events/${'a'.repeat(80)}`, {
                data: {},
                timeout: TIMEOUT,
            });
            expect(tooLong.status(), 'over-length pluginId → 400').toBe(400);
        } finally {
            await anonContext.close();
        }
    });

    test('auth gates: list/create/patch/delete/test all 401 without a bearer token', async ({
        browser,
    }) => {
        // Empty-storageState anon context — no inherited session cookie.
        const anonContext = await browser.newContext({
            storageState: { cookies: [], origins: [] },
        });
        const anon = anonContext.request;
        try {
            const probes: Array<{ label: string; run: () => Promise<{ status(): number }> }> = [
                { label: 'GET list', run: () => anon.get(CHANNELS, { timeout: TIMEOUT }) },
                {
                    label: 'POST create',
                    run: () =>
                        anon.post(CHANNELS, {
                            data: { pluginId: 'slack-channel', name: 'x', targetConfig: {} },
                            timeout: TIMEOUT,
                        }),
                },
                {
                    label: 'PATCH',
                    run: () =>
                        anon.patch(`${CHANNELS}/${BOGUS_UUID}`, {
                            data: { name: 'x' },
                            timeout: TIMEOUT,
                        }),
                },
                {
                    label: 'DELETE',
                    run: () => anon.delete(`${CHANNELS}/${BOGUS_UUID}`, { timeout: TIMEOUT }),
                },
                {
                    label: 'POST test',
                    run: () => anon.post(`${CHANNELS}/${BOGUS_UUID}/test`, { timeout: TIMEOUT }),
                },
            ];
            for (const p of probes) {
                const res = await p.run();
                expect(res.status(), `${p.label} requires auth`).toBe(401);
            }
        } finally {
            await anonContext.close();
        }
    });

    test('partial-key uniqueness: same name + DIFFERENT pluginId is allowed (uq index is userId+pluginId+name)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request, {
            email: `nch-uniq-${uniqueName('q')}@test.local`,
        });
        const token = u.access_token;
        const sharedName = uniqueName('Shared');

        // First channel under (user, slack-channel, sharedName).
        const slack = await createChannel(request, token, {
            pluginId: 'slack-channel',
            name: sharedName,
            targetConfig: { webhookUrl: 'https://hooks.slack.com/services/T/B/x' },
        });

        // Same name but a DIFFERENT pluginId is a DIFFERENT unique-key tuple, so it
        // is allowed — proving the unique index keys on the FULL triple, not name
        // alone. (A same-triple duplicate hits the DB unique index; that rough edge
        // is intentionally NOT asserted here.)
        const discord = await createChannel(request, token, {
            pluginId: 'discord-channel',
            name: sharedName,
            targetConfig: { webhookUrl: 'https://discord.com/api/webhooks/1/a' },
        });

        expect(slack.id).not.toBe(discord.id);
        const ids = (await listChannels(request, token)).map((c) => c.id);
        expect(ids).toContain(slack.id);
        expect(ids).toContain(discord.id);
    });

    test('owner test-send + delete idempotency: own channel test is a truthful result; delete is 204 then 404', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request, {
            email: `nch-life-${uniqueName('l')}@test.local`,
        });
        const token = u.access_token;
        const ch = await createChannel(request, token, {
            pluginId: 'telegram-channel',
            name: uniqueName('Lifecycle'),
            targetConfig: { botToken: 'x:y', chatId: '1' },
        });

        // Owner test-send returns the result DIRECTLY (201). CI enables no channel
        // plugin → truthful 'failed' with a provider-specific error; a positive
        // status is tolerated if some env wires the plugin.
        const testRes = await request.post(`${CHANNELS}/${ch.id}/test`, {
            headers: authedHeaders(token),
            timeout: TIMEOUT,
        });
        expect(testRes.status()).toBe(201);
        const body = await testRes.json();
        expect(typeof body.status).toBe('string');
        if (body.status === 'failed') {
            expect(typeof body.error).toBe('string');
            expect(body.error.toLowerCase()).toMatch(/plugin|materialize|disabled|not found/);
        } else {
            expect(['delivered', 'queued', 'sent', 'accepted']).toContain(body.status);
        }

        // DELETE → 204 the first time.
        const del1 = await request.delete(`${CHANNELS}/${ch.id}`, {
            headers: authedHeaders(token),
            timeout: TIMEOUT,
        });
        expect(del1.status()).toBe(204);

        // The row is gone from the list, and a SECOND delete (or any op) on the same
        // id is now 404 — the delete is not idempotently 204; the row truly vanished.
        expect((await listChannels(request, token)).map((c) => c.id)).not.toContain(ch.id);
        const del2 = await request.delete(`${CHANNELS}/${ch.id}`, {
            headers: authedHeaders(token),
            timeout: TIMEOUT,
        });
        expect(del2.status(), 'deleting an already-deleted channel → 404').toBe(404);

        // And test-send on the deleted id is also a truthful 404.
        const testDeleted = await request.post(`${CHANNELS}/${ch.id}/test`, {
            headers: authedHeaders(token),
            timeout: TIMEOUT,
        });
        expect(testDeleted.status()).toBe(404);
        expect((await testDeleted.json()).message).toBe('Channel not found');
    });

    test('auth rejects a malformed / garbage bearer token (not just a missing one) on the channels list', async ({
        browser,
    }) => {
        const anonContext = await browser.newContext({
            storageState: { cookies: [], origins: [] },
        });
        const anon = anonContext.request;
        try {
            // A syntactically-present but invalid Bearer token is 401 (the guard
            // validates the session, it does not merely check header presence).
            const garbage = await anon.get(CHANNELS, {
                headers: { Authorization: 'Bearer totally-invalid-token-xyz' },
                timeout: TIMEOUT,
            });
            expect(garbage.status(), 'garbage bearer → 401').toBe(401);

            // An Authorization header that isn't even a Bearer scheme is also 401.
            const malformed = await anon.get(CHANNELS, {
                headers: { Authorization: 'totally-invalid' },
                timeout: TIMEOUT,
            });
            expect(malformed.status(), 'non-Bearer Authorization → 401').toBe(401);
        } finally {
            await anonContext.close();
        }
    });

    test('events/:pluginId acks WITHOUT acting on the body: extra/script/empty payloads all 202 and echo only the param', async ({
        browser,
    }) => {
        // The handler is deliberately side-effect-free until HMAC verification lands
        // (EW-673 P3): it must NOT read or reflect the body — only the pluginId
        // param. Probe a script-y payload, an oversized payload, and no body at all;
        // every case is a bare 202 { received, pluginId } with NO body echo.
        const anonContext = await browser.newContext({
            storageState: { cookies: [], origins: [] },
        });
        const anon = anonContext.request;
        try {
            const payloads: Array<Record<string, unknown> | undefined> = [
                { evil: '<script>alert(1)</script>', providerMessageId: 'pm-1' },
                { huge: 'a'.repeat(500) },
                undefined,
            ];
            for (const data of payloads) {
                const res = await anon.post(`${CHANNELS}/events/slack-channel`, {
                    data: data ?? {},
                    timeout: TIMEOUT,
                });
                expect(res.status()).toBe(202);
                const body = await res.json();
                // Exactly the two documented keys — the request body is NOT reflected.
                expect(Object.keys(body).sort()).toEqual(['pluginId', 'received']);
                expect(body.pluginId).toBe('slack-channel');
                expect(body.received).toBe(true);
            }
        } finally {
            await anonContext.close();
        }
    });

    test('existence gate: an unknown-but-valid-UUID id is 404 on PATCH(disabled) and DELETE (findOwnedOrThrow runs first)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request, {
            email: `nch-exist-${uniqueName('e')}@test.local`,
        });
        const token = u.access_token;

        // disabled:true on a non-existent (but well-formed) id 404s — the service
        // looks the row up BEFORE applying any patch, so there is no phantom write.
        const patchUnknown = await request.patch(`${CHANNELS}/${BOGUS_UUID}`, {
            headers: authedHeaders(token),
            data: { disabled: true },
            timeout: TIMEOUT,
        });
        expect(patchUnknown.status()).toBe(404);
        expect((await patchUnknown.json()).message).toBe('Channel not found');

        // DELETE on the same unknown id is likewise 404, not a silent 204.
        const deleteUnknown = await request.delete(`${CHANNELS}/${BOGUS_UUID}`, {
            headers: authedHeaders(token),
            timeout: TIMEOUT,
        });
        expect(deleteUnknown.status()).toBe(404);
    });

    test('verified flag is server-owned: a fresh channel is unverified and stays unverified across a rename PATCH', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request, {
            email: `nch-verif-${uniqueName('v')}@test.local`,
        });
        const token = u.access_token;
        const ch = await createChannel(request, token, {
            pluginId: 'novu-channel',
            name: uniqueName('Verif'),
            targetConfig: { apiKey: 'nv', workflowId: 'wf', subscriberId: 'sub' },
        });
        expect(ch.verified).toBe(false);
        expect(ch.disabledAt).toBeNull();

        // A legitimate rename (the one mutation a user may make to identity) leaves
        // verified untouched — the user can never flip it via the API surface.
        const renamed = await request.patch(`${CHANNELS}/${ch.id}`, {
            headers: authedHeaders(token),
            data: { name: uniqueName('Renamed') },
            timeout: TIMEOUT,
        });
        expect(renamed.status()).toBe(200);
        expect((await renamed.json()).channel.verified).toBe(false);
    });
});
