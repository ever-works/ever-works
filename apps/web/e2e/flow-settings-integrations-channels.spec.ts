import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';
import {
    expectConfigRefused,
    expectPluginNotBound,
    expectProviderRejected,
    SLACK_OFF_HOST_REFUSAL,
    type BoundChannelPluginId,
    type ChannelTestResult,
} from './helpers/notification-channels';

/**
 * Settings → Integrations → CHANNELS — deep cross-feature integration flows for the
 * outbound notification-channel connectors (Discord / Slack / Telegram / WhatsApp /
 * Novu / generic webhook): connect → configure → test → reconfigure → disconnect,
 * the public provider delivery-event webhook, multi-provider coexistence, per-user
 * integration isolation, and the UI Add-channel wizard.
 *
 * COMPANION (none of which this file repeats):
 *   - settings-integrations.spec.ts          (ONE discord channel CRUD smoke +
 *                                             work-agent prefs + email registry)
 *   - flow-notification-email-channel.spec.ts (the EMAIL channel + the preference
 *                                             machinery: subscriptions/quiet-hours/mutes)
 *   - notification-channels.spec.ts / notifications-*.spec.ts (preference-endpoint shape)
 *   - flow-work-webhook-signatures.spec.ts / webhook-*.spec.ts (OUTBOUND work webhooks —
 *                                             a DIFFERENT subsystem to channel connectors)
 *
 * This file owns the CONNECTOR lifecycle for the chat/messaging integrations
 * (Slack/Discord/Telegram/WhatsApp/Novu/webhook), which the companions do not exercise:
 *   1. Slack connector full lifecycle: connect → test (the provider rejects the fictitious
 *      hook) → reconfigure webhook URL → disable (the off gate) → re-enable → disconnect →
 *      404 after.
 *   2. Multi-provider matrix in one inbox: discord/slack/telegram/whatsapp/novu/webhook
 *      coexist; each test-send reports that provider's own truthful failure; secrets stored
 *      verbatim.
 *   3. Public provider delivery-event webhook (POST /events/:pluginId) — 202 ACCEPTED,
 *      echoes the pluginId, @Public (no bearer), throttled, GET not allowed.
 *   4. Per-user channel ISOLATION matrix — list/patch/test/delete of a foreign channel id
 *      is a scoped 404 "Channel not found", never a cross-tenant leak or hijack.
 *   5. Configure-validation edges — CONNECT stores any pluginId+targetConfig verbatim, and
 *      the bound plugin is what validates it at send time: the Slack plugin refuses an
 *      off-host / plain-http / metadata-IP webhook before making any request, accepts a
 *      hooks.slack.com URL (which then reaches Slack), and an unknown pluginId resolves to
 *      no plugin. A missing `name` is rejected up front by the CreateChannelDto guard with
 *      a 400 class-validator error (the hardened replacement for the former no-DTO-guard 500).
 *   6. UI Add-channel wizard (seeded storageState) at /settings/integrations/channels —
 *      open dialog → pick Slack → fill webhook → Create → row appears → Test shows the
 *      provider's truthful failure badge → Remove drops the row.
 *
 * PROBED, TRUTHFUL contracts (verified via curl against http://127.0.0.1:3100 with
 * throwaway registered users BEFORE writing any assertion; cross-checked against
 * apps/api/src/notification-channels/notification-channels.{controller,service}.ts,
 * packages/plugins/{slack,discord}-channel/src/*-channel-plugin.ts, and
 * apps/web/src/components/settings/NotificationChannelsSettings.tsx):
 *
 *   @Controller('api/notification-channels')  (AuthSessionGuard, except events webhook):
 *     GET    /                 -> 200 { channels }  == repo.findActiveByUser(userId).
 *        DISABLED channels are FILTERED OUT of this list (the off gate). [] for fresh user.
 *     POST   /                 -> 201 { channel }   { id, userId, pluginId, name,
 *        targetConfig, verified:false, disabledAt:null, tenantId:null, organizationId:null,
 *        createdAt, updatedAt }.  NO validation at create: ANY pluginId string + ANY
 *        targetConfig is accepted (slack/discord/telegram/whatsapp/novu/webhook/garbage);
 *        even a non-hooks.slack.com URL is stored verbatim. The delivery plugin validates
 *        the config at test/send time, before it makes any request. Multi-field secrets
 *        (telegram botToken+chatId, whatsapp accessToken+phoneNumberId+to) round-trip
 *        verbatim in targetConfig.  Omitting `name` -> 400 {"statusCode":400,
 *        "error":"Bad Request","message":[…"name …"]} — the CreateChannelDto guard
 *        (`@IsString() @MinLength(1)`) rejects it via the global ValidationPipe BEFORE
 *        persistence (hardened replacement for the former no-DTO-guard 500); flow 5.
 *     PATCH  /:id { name?, targetConfig?, disabled? } -> 200 { channel }.
 *        disabled:true stamps disabledAt (ISO) AND drops it from GET; disabled:false
 *        clears disabledAt back to null (reappears). targetConfig is REPLACED wholesale.
 *        Empty PATCH ({}) is a no-op 200. Foreign/unknown id -> 404 "Channel not found".
 *     DELETE /:id -> 204 (scoped: findOwnedOrThrow runs first). Foreign/unknown id -> 404
 *        "Channel not found" (NOT a silent no-op — owner's row untouched).
 *     POST   /:id/test -> 201 { status, error?, providerMessageId? } returned DIRECTLY
 *        (NOT wrapped). Every channel plugin is BOUND (the loader materializes them since
 *        #2988) and every target here is fictitious, so an ENABLED channel's test-send is
 *        always status:'failed' with no providerMessageId, and the error is the plugin's:
 *          - its config refusal, e.g. "slack-channel: targetConfig.webhookUrl must start
 *            with https://hooks.slack.com/" (no request made); or
 *          - the provider's rejection, wrapped as "<Provider> … failed (<HTTP status>): …"
 *            (Slack/Discord 404 for an unknown hook; Telegram/WhatsApp/Novu 401 for a
 *            fictitious credential — see helpers/notification-channels.ts).
 *        A pluginId that names no channel plugin (`webhook`, a made-up id) ->
 *        error:"Notification channel plugin not found or disabled: <pluginId>".
 *        A DISABLED channel -> status:'failed', error:"channel disabled" (the gate is
 *        enforced at SEND time too, before the plugin). A foreign/deleted id -> 404
 *        "Channel not found".
 *     POST   /events/:pluginId  @Public @Throttle(600/60s) -> 202 ACCEPTED
 *        { received:true, pluginId } — echoes ANY pluginId path segment verbatim,
 *        no bearer required. GET on the same path -> 404 (POST-only route).
 *     GET    / without auth -> 401 {"message":"Unauthorized","statusCode":401}.
 *
 *   Channels are USER-scoped (tenantId/organizationId always null on create) — there is
 *   no org/work-scoped channel write path, so isolation is per-user (flow 4), not per-org.
 *
 *   UI (/settings/integrations/channels — localePrefix:'never', under (dashboard) group):
 *     unauth -> 307 /login. Authed: <h1>Notification Channels</h1>, an "Add channel"
 *     button opens a role=dialog aria-label="Add notification channel" with a Provider
 *     <select> (Discord/Slack/Telegram/WhatsApp/Novu), a Name input, per-provider field
 *     inputs (slack: "Incoming Webhook URL"), and a "Create channel" button. Each saved
 *     row renders Name + provider label + a "Test" and "Remove" button; Test renders a
 *     "✗ <error>"/"✓ Sent" badge; Remove drops the row.
 *
 * ENVIRONMENT NOTES (CI-faithful):
 *   - Every target is fictitious, so test-send NEVER succeeds; assertions pin the plugin's
 *     truthful failure reason per provider, never delivery. A well-formed target makes the
 *     plugin call the real provider host (the plugins pin their hosts, so no local fake can
 *     stand in), which needs outbound network from the API process. The connect/configure/
 *     disable/disconnect/isolation CONTRACT is fully deterministic and is what these flows
 *     assert.
 *   - CROSS-SPEC ISOLATION: every API mutation runs on a FRESH registerUserViaAPI() user
 *     (unique email per run). Membership uses toContain / not.toContain, never exact totals,
 *     to tolerate the shared in-memory DB. The seeded storageState user is used ONLY for the
 *     UI-driven flow (flow 6), and it self-cleans the channel it creates.
 *   - DEV HYDRATION RACE: the UI flow uses generous timeouts, retry-to-open the dialog, and
 *     asserts on visible text rather than network internals.
 */

const TIMEOUT = 20_000;
const BOGUS_UUID = '00000000-0000-0000-0000-000000000000';

interface NotificationChannel {
    id: string;
    userId: string;
    pluginId: string;
    name: string;
    targetConfig: Record<string, unknown>;
    verified: boolean;
    disabledAt: string | null;
    tenantId: string | null;
    organizationId: string | null;
}

type TestResult = ChannelTestResult;

async function listChannels(
    request: APIRequestContext,
    token: string,
): Promise<NotificationChannel[]> {
    const res = await request.get(`${API_BASE}/api/notification-channels`, {
        headers: authedHeaders(token),
        timeout: TIMEOUT,
    });
    expect(res.status(), `list channels body=${await res.text().catch(() => '')}`).toBe(200);
    return (await res.json()).channels as NotificationChannel[];
}

async function connectChannel(
    request: APIRequestContext,
    token: string,
    pluginId: string,
    name: string,
    targetConfig: Record<string, unknown>,
): Promise<NotificationChannel> {
    const res = await request.post(`${API_BASE}/api/notification-channels`, {
        headers: authedHeaders(token),
        data: { pluginId, name, targetConfig },
        timeout: TIMEOUT,
    });
    expect(res.status(), `connect ${pluginId} body=${await res.text().catch(() => '')}`).toBe(201);
    return (await res.json()).channel as NotificationChannel;
}

async function testSend(
    request: APIRequestContext,
    token: string,
    id: string,
): Promise<{ http: number; body: TestResult }> {
    const res = await request.post(`${API_BASE}/api/notification-channels/${id}/test`, {
        headers: authedHeaders(token),
        timeout: TIMEOUT,
    });
    return { http: res.status(), body: (await res.json()) as TestResult };
}

test.describe('Settings · Integrations · Channels — connector lifecycle', () => {
    test('Slack connector: connect → test → reconfigure URL → disable gate → re-enable → disconnect', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request, {
            email: `sic-slack-${Date.now()}@test.local`,
        });
        const token = u.access_token;

        // A fresh account owns no integration channels.
        expect(await listChannels(request, token)).toEqual([]);

        // CONNECT a Slack incoming-webhook channel. Create performs NO URL validation —
        // the plugin's hooks.slack.com host check runs at test/send time.
        const slack = await connectChannel(request, token, 'slack-channel', 'Eng Alerts', {
            webhookUrl: 'https://hooks.slack.com/services/T000/B000/firstsecret',
        });
        expect(slack.pluginId).toBe('slack-channel');
        expect(slack.name).toBe('Eng Alerts');
        expect(slack.targetConfig).toEqual({
            webhookUrl: 'https://hooks.slack.com/services/T000/B000/firstsecret',
        });
        // Born enabled + unverified; user-scoped (no tenant/org binding).
        expect(slack.verified).toBe(false);
        expect(slack.disabledAt).toBeNull();
        expect(slack.userId).toBe(u.user.id);
        expect(slack.tenantId).toBeNull();
        expect(slack.organizationId).toBeNull();
        expect((await listChannels(request, token)).map((c) => c.id)).toContain(slack.id);

        // TEST — the slack-channel plugin is bound and the URL is a well-formed hooks.slack.com
        // hook, so the plugin really POSTs it; Slack answers 404 for a hook that does not
        // exist, and the plugin reports exactly that. Never a fabricated success. The "Test"
        // button surfaces this same result to the operator.
        const t1 = await testSend(request, token, slack.id);
        expect(t1.http).toBe(201);
        expectProviderRejected(t1.body, 'slack-channel', 404);

        // RECONFIGURE — point the connector at a new webhook URL (rotating the secret).
        // targetConfig is replaced wholesale, name + enabled state untouched.
        const reconfig = await request.patch(`${API_BASE}/api/notification-channels/${slack.id}`, {
            headers: authedHeaders(token),
            data: {
                targetConfig: { webhookUrl: 'https://hooks.slack.com/services/T000/B000/rotated' },
            },
            timeout: TIMEOUT,
        });
        expect(reconfig.status()).toBe(200);
        const reconfigured = (await reconfig.json()).channel as NotificationChannel;
        expect(reconfigured.targetConfig).toEqual({
            webhookUrl: 'https://hooks.slack.com/services/T000/B000/rotated',
        });
        expect(reconfigured.name).toBe('Eng Alerts');
        expect(reconfigured.disabledAt).toBeNull();

        // DISABLE — the off gate. A disabled connector is FILTERED OUT of the active list
        // AND its test-send short-circuits with "channel disabled" before plugin resolution.
        const disable = await request.patch(`${API_BASE}/api/notification-channels/${slack.id}`, {
            headers: authedHeaders(token),
            data: { disabled: true },
            timeout: TIMEOUT,
        });
        expect(disable.status()).toBe(200);
        expect((await disable.json()).channel.disabledAt, 'disable stamps disabledAt').toBeTruthy();
        expect(
            (await listChannels(request, token)).map((c) => c.id),
            'disabled connector disappears from the active list',
        ).not.toContain(slack.id);

        const tDisabled = await testSend(request, token, slack.id);
        expect(tDisabled.http).toBe(201);
        expect(tDisabled.body.status).toBe('failed');
        expect(tDisabled.body.error, 'disabled gate is enforced at send time too').toBe(
            'channel disabled',
        );

        // RE-ENABLE — clears disabledAt; the connector returns to the active list and the
        // test-send reaches the plugin again (the gate is lifted), which POSTs the ROTATED
        // hook and reports Slack's 404 for it.
        const enable = await request.patch(`${API_BASE}/api/notification-channels/${slack.id}`, {
            headers: authedHeaders(token),
            data: { disabled: false },
            timeout: TIMEOUT,
        });
        expect(enable.status()).toBe(200);
        expect((await enable.json()).channel.disabledAt).toBeNull();
        expect((await listChannels(request, token)).map((c) => c.id)).toContain(slack.id);
        const tReenabled = await testSend(request, token, slack.id);
        expect(tReenabled.http).toBe(201);
        expect(
            tReenabled.body.error,
            're-enabled connector is no longer "channel disabled"',
        ).not.toBe('channel disabled');
        expectProviderRejected(tReenabled.body, 'slack-channel', 404);

        // DISCONNECT — DELETE is scoped + idempotent on the owner; the row vanishes and a
        // subsequent test-send 404s "Channel not found".
        const del = await request.delete(`${API_BASE}/api/notification-channels/${slack.id}`, {
            headers: authedHeaders(token),
            timeout: TIMEOUT,
        });
        expect(del.status()).toBe(204);
        expect((await listChannels(request, token)).map((c) => c.id)).not.toContain(slack.id);
        const tGone = await testSend(request, token, slack.id);
        expect(tGone.http).toBe(404);
        expect(tGone.body as unknown as { message: string }).toMatchObject({
            message: 'Channel not found',
        });
    });

    test('multi-provider inbox: discord/slack/telegram/whatsapp/novu/webhook coexist; secrets stored verbatim; per-pluginId truthful test', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request, {
            email: `sic-multi-${Date.now()}@test.local`,
        });
        const token = u.access_token;

        // Connect one of each supported connector kind in a single inbox. The CONFIG shapes
        // mirror the UI wizard's per-provider field map (NotificationChannelsSettings PROVIDERS).
        // Every config is well-formed for its plugin but fictitious, so each test-send reaches
        // the real provider and `testSend` pins the HTTP status that provider rejects it with
        // (`webhook` names no channel plugin, so it never leaves the facade).
        const rejectedWith =
            (pluginId: BoundChannelPluginId, httpStatus: number) => (r: TestResult) =>
                expectProviderRejected(r, pluginId, httpStatus);
        const specs: Array<{
            pluginId: string;
            name: string;
            cfg: Record<string, unknown>;
            testSend: (r: TestResult) => void;
        }> = [
            {
                pluginId: 'discord-channel',
                name: 'Team Discord',
                cfg: { webhookUrl: 'https://discord.com/api/webhooks/100/discordsecret' },
                // Unknown webhook id → 404 (Discord code 10015 "Unknown Webhook").
                testSend: rejectedWith('discord-channel', 404),
            },
            {
                pluginId: 'slack-channel',
                name: 'Team Slack',
                cfg: { webhookUrl: 'https://hooks.slack.com/services/T/B/slacksecret' },
                // Unknown incoming webhook → 404.
                testSend: rejectedWith('slack-channel', 404),
            },
            {
                pluginId: 'telegram-channel',
                name: 'Team Telegram',
                cfg: { botToken: '123456:tgsecrettoken', chatId: '@teamchannel' },
                // Well-formed but unknown bot token → 401 "Unauthorized".
                testSend: rejectedWith('telegram-channel', 401),
            },
            {
                pluginId: 'whatsapp-channel',
                name: 'Team WhatsApp',
                cfg: { accessToken: 'wa-secret', phoneNumberId: '55501', to: '+15551234567' },
                // Unparseable access token → 401 (OAuthException).
                testSend: rejectedWith('whatsapp-channel', 401),
            },
            {
                pluginId: 'novu-channel',
                name: 'Team Novu',
                cfg: { apiKey: 'novu-secret', workflowId: 'wf-1', subscriberId: 'sub-1' },
                // Unknown API key → 401 "API Key not found".
                testSend: rejectedWith('novu-channel', 401),
            },
            {
                pluginId: 'webhook',
                name: 'Generic Webhook',
                cfg: { url: 'https://example.com/ingest', secret: 'hmac-secret' },
                testSend: (r) => expectPluginNotBound(r, 'webhook'),
            },
        ];

        const created: NotificationChannel[] = [];
        for (const s of specs) {
            const ch = await connectChannel(request, token, s.pluginId, s.name, s.cfg);
            expect(ch.pluginId).toBe(s.pluginId);
            // Multi-field secrets (telegram botToken+chatId, whatsapp triple, novu triple)
            // round-trip VERBATIM into targetConfig — nothing is dropped or coerced.
            expect(ch.targetConfig, `${s.pluginId} targetConfig round-trip`).toEqual(s.cfg);
            created.push(ch);
        }

        // All six coexist in the one inbox (membership, not exact count — shared DB).
        const list = await listChannels(request, token);
        const listedIds = list.map((c) => c.id);
        for (const ch of created) {
            expect(listedIds, `${ch.pluginId} present in inbox`).toContain(ch.id);
        }
        // The inbox spans all six distinct provider plugin ids.
        const pluginIds = new Set(list.map((c) => c.pluginId));
        for (const s of specs) {
            expect(pluginIds).toContain(s.pluginId);
        }

        // Each connector's test-send reports its own provider's truthful failure — proving the
        // facade resolves per-pluginId (each error carries that plugin's own prefix) and that
        // the stored multi-field secrets reach the plugin intact (each provider got far enough
        // to reject the credential itself, not a missing-field refusal).
        for (const [i, ch] of created.entries()) {
            const t = await testSend(request, token, ch.id);
            expect(t.http, `${ch.pluginId} test-send`).toBe(201);
            specs[i].testSend(t.body);
        }

        // Disconnecting ONE connector leaves the others intact (scoped delete).
        const dropped = created[2]; // telegram
        const del = await request.delete(`${API_BASE}/api/notification-channels/${dropped.id}`, {
            headers: authedHeaders(token),
            timeout: TIMEOUT,
        });
        expect(del.status()).toBe(204);
        const after = (await listChannels(request, token)).map((c) => c.id);
        expect(after).not.toContain(dropped.id);
        for (const ch of created.filter((c) => c.id !== dropped.id)) {
            expect(after, `${ch.pluginId} survives a sibling disconnect`).toContain(ch.id);
        }
    });

    test('public provider delivery-event webhook (POST /events/:pluginId) — 202, echoes pluginId, @Public, GET rejected', async ({
        request,
    }) => {
        // The provider callback that channel integrations POST delivery receipts to. It is
        // @Public (no bearer), accepts ANY pluginId path segment, and ACKs 202 ACCEPTED with
        // { received:true, pluginId }. The bare `request` fixture sends NO Authorization
        // header — an anonymous caller — which is exactly how a channel provider hits it
        // (providers cannot present a user bearer). This proves the @Public gate.
        for (const pluginId of ['slack-channel', 'discord-channel', 'telegram-channel']) {
            const res = await request.post(
                `${API_BASE}/api/notification-channels/events/${pluginId}`,
                { data: { event: 'delivered', messageRef: `evt-${Date.now()}` }, timeout: TIMEOUT },
            );
            expect(res.status(), `events/${pluginId} should ACK 202`).toBe(202);
            const body = await res.json();
            expect(body.received).toBe(true);
            // The route echoes the path segment verbatim — even an unknown plugin id.
            expect(body.pluginId).toBe(pluginId);
        }

        // An arbitrary/unknown plugin id is still echoed (no allowlist at this stage).
        const arbitrary = await request.post(
            `${API_BASE}/api/notification-channels/events/some-unregistered-provider`,
            { data: {}, timeout: TIMEOUT },
        );
        expect(arbitrary.status()).toBe(202);
        expect((await arbitrary.json()).pluginId).toBe('some-unregistered-provider');

        // The route is POST-only — a GET to the same path is a 404 (no handler).
        const get = await request.get(
            `${API_BASE}/api/notification-channels/events/slack-channel`,
            { timeout: TIMEOUT },
        );
        expect(get.status()).toBe(404);
    });

    test('per-user channel isolation matrix — list/patch/test/delete of a foreign id is a scoped 404, never a hijack', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request, {
            email: `sic-own-${Date.now()}@test.local`,
        });
        const other = await registerUserViaAPI(request, {
            email: `sic-oth-${Date.now()}@test.local`,
        });

        const ownerChannel = await connectChannel(
            request,
            owner.access_token,
            'discord-channel',
            'Owner Discord',
            { webhookUrl: 'https://discord.com/api/webhooks/200/ownersecret' },
        );

        // The other user's inbox never contains the owner's connector.
        expect((await listChannels(request, other.access_token)).map((c) => c.id)).not.toContain(
            ownerChannel.id,
        );

        // PATCH a foreign id — scoped lookup 404s "Channel not found" (NOT 403; the row simply
        // does not exist in the other user's view). No config hijack is possible.
        const patchForeign = await request.patch(
            `${API_BASE}/api/notification-channels/${ownerChannel.id}`,
            {
                headers: authedHeaders(other.access_token),
                data: {
                    name: 'hijacked',
                    targetConfig: { webhookUrl: 'https://discord.com/api/webhooks/x/y' },
                },
                timeout: TIMEOUT,
            },
        );
        expect(patchForeign.status()).toBe(404);
        expect((await patchForeign.json()).message).toBe('Channel not found');

        // TEST-send through a foreign id — same scoped 404, no secret leak.
        const testForeign = await request.post(
            `${API_BASE}/api/notification-channels/${ownerChannel.id}/test`,
            { headers: authedHeaders(other.access_token), timeout: TIMEOUT },
        );
        expect(testForeign.status()).toBe(404);
        expect((await testForeign.json()).message).toBe('Channel not found');

        // DELETE a foreign id — scoped 404, and the owner's connector is untouched.
        const delForeign = await request.delete(
            `${API_BASE}/api/notification-channels/${ownerChannel.id}`,
            { headers: authedHeaders(other.access_token), timeout: TIMEOUT },
        );
        expect(delForeign.status()).toBe(404);
        expect((await delForeign.json()).message).toBe('Channel not found');
        expect(
            (await listChannels(request, owner.access_token)).map((c) => c.id),
            'owner connector survives a foreign DELETE attempt',
        ).toContain(ownerChannel.id);

        // The owner's config is unchanged after all the foreign attempts.
        const ownerView = (await listChannels(request, owner.access_token)).find(
            (c) => c.id === ownerChannel.id,
        );
        expect(ownerView?.name).toBe('Owner Discord');
        expect(ownerView?.targetConfig).toEqual({
            webhookUrl: 'https://discord.com/api/webhooks/200/ownersecret',
        });

        // The owner CAN disconnect their own connector (204); afterwards even the owner
        // gets a truthful 404 on test-send.
        const delOwn = await request.delete(
            `${API_BASE}/api/notification-channels/${ownerChannel.id}`,
            { headers: authedHeaders(owner.access_token), timeout: TIMEOUT },
        );
        expect(delOwn.status()).toBe(204);
        const tGone = await testSend(request, owner.access_token, ownerChannel.id);
        expect(tGone.http).toBe(404);
        expect(tGone.body as unknown as { message: string }).toMatchObject({
            message: 'Channel not found',
        });
    });

    test('configure-validation edges — connect stores any config verbatim, the bound plugin refuses an off-host or unsafe webhook at send and accepts a hooks.slack.com one, empty PATCH is a no-op, missing name is a 400 DTO-guard rejection', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request, { email: `sic-cfg-${Date.now()}@test.local` });
        const token = u.access_token;

        // Auth gate: anonymous list is 401.
        const anonList = await request.get(`${API_BASE}/api/notification-channels`);
        expect(anonList.status()).toBe(401);

        // CONNECT a Slack connector with a NON-slack URL. Create performs no URL validation —
        // it is stored verbatim. Validation belongs to the plugin, which runs it on send.
        const badUrl = await connectChannel(request, token, 'slack-channel', 'Misconfigured', {
            webhookUrl: 'https://evil.example.com/not-a-slack-hook',
        });
        expect(badUrl.targetConfig).toEqual({
            webhookUrl: 'https://evil.example.com/not-a-slack-hook',
        });
        // Test-send of the misconfigured connector: the bound slack-channel plugin refuses the
        // off-host URL BEFORE making any request (its SSRF/host guard) — a truthful failure
        // with the plugin's exact reason, never a 5xx and never a request to evil.example.com.
        const tBad = await testSend(request, token, badUrl.id);
        expect(tBad.http).toBe(201);
        expectConfigRefused(tBad.body, SLACK_OFF_HOST_REFUSAL);

        // What the plugin REFUSES: anything that is not an https URL on hooks.slack.com —
        // plain http, a look-alike host that merely starts with the Slack host name, and the
        // cloud metadata address. Each is stored verbatim, then refused at send with the same
        // exact reason, before any request leaves the API.
        const probe = await connectChannel(request, token, 'slack-channel', 'Host probe', {
            webhookUrl: 'https://evil.example.com/probe',
        });
        for (const refused of [
            'http://hooks.slack.com/services/T000/B000/plainhttp',
            'https://hooks.slack.com.evil.example/services/T000/B000/lookalike',
            'http://169.254.169.254/latest/meta-data/',
        ]) {
            const repoint = await request.patch(
                `${API_BASE}/api/notification-channels/${probe.id}`,
                {
                    headers: authedHeaders(token),
                    data: { targetConfig: { webhookUrl: refused } },
                    timeout: TIMEOUT,
                },
            );
            expect(repoint.status(), `store ${refused}`).toBe(200);
            const t = await testSend(request, token, probe.id);
            expect(t.http, `test-send ${refused}`).toBe(201);
            expectConfigRefused(t.body, SLACK_OFF_HOST_REFUSAL);
        }

        // What the plugin ACCEPTS: a hooks.slack.com URL passes its validation, so the plugin
        // really POSTs it — and Slack's 404 for the fictitious hook comes back as the reason.
        const accepted = await request.patch(`${API_BASE}/api/notification-channels/${probe.id}`, {
            headers: authedHeaders(token),
            data: { targetConfig: { webhookUrl: 'https://hooks.slack.com/services/T000/B000/ok' } },
            timeout: TIMEOUT,
        });
        expect(accepted.status()).toBe(200);
        const tAccepted = await testSend(request, token, probe.id);
        expect(tAccepted.http).toBe(201);
        expectProviderRejected(tAccepted.body, 'slack-channel', 404);

        // CONNECT a totally unknown pluginId — also accepted at create; at send time the
        // facade resolves no plugin for it and names the pluginId in the error.
        const unknownPlugin = await connectChannel(
            request,
            token,
            'totally-made-up-channel',
            'Mystery',
            {
                anything: 'goes',
            },
        );
        const tUnknown = await testSend(request, token, unknownPlugin.id);
        expect(tUnknown.http).toBe(201);
        expectPluginNotBound(tUnknown.body, 'totally-made-up-channel');

        // Empty PATCH ({}) is a no-op 200 that preserves the row as-is.
        const noop = await request.patch(`${API_BASE}/api/notification-channels/${badUrl.id}`, {
            headers: authedHeaders(token),
            data: {},
            timeout: TIMEOUT,
        });
        expect(noop.status()).toBe(200);
        const noopBody = (await noop.json()).channel as NotificationChannel;
        expect(noopBody.name).toBe('Misconfigured');
        expect(noopBody.targetConfig).toEqual({
            webhookUrl: 'https://evil.example.com/not-a-slack-hook',
        });

        // Rename-only PATCH leaves targetConfig intact (independent field updates).
        const rename = await request.patch(`${API_BASE}/api/notification-channels/${badUrl.id}`, {
            headers: authedHeaders(token),
            data: { name: 'Renamed Connector' },
            timeout: TIMEOUT,
        });
        expect(rename.status()).toBe(200);
        const renamed = (await rename.json()).channel as NotificationChannel;
        expect(renamed.name).toBe('Renamed Connector');
        expect(renamed.targetConfig).toEqual({
            webhookUrl: 'https://evil.example.com/not-a-slack-hook',
        });

        // PROBED truthful edge: omitting `name` at create is rejected up front by the
        // CreateChannelDto guard (`@IsString() @MinLength(1)` on `name`), so the global
        // ValidationPipe (whitelist + forbidNonWhitelisted) 400s BEFORE the service/persistence
        // layer is reached. The body is the standard class-validator error: a `message` ARRAY of
        // per-constraint strings (all naming `name`) plus `error:'Bad Request'`. This is the
        // hardened replacement for the former no-DTO-guard 500 — the request never reaches the DB.
        const missingName = await request.post(`${API_BASE}/api/notification-channels`, {
            headers: authedHeaders(token),
            data: {
                pluginId: 'slack-channel',
                targetConfig: { webhookUrl: 'https://hooks.slack.com/services/a/b/c' },
            },
            timeout: TIMEOUT,
        });
        expect(missingName.status()).toBe(400);
        const missingNameBody = (await missingName.json()) as { message: string[]; error: string };
        expect(Array.isArray(missingNameBody.message)).toBe(true);
        expect(missingNameBody.message.join(' ')).toContain('name');
        expect(missingNameBody.error).toBe('Bad Request');

        // A foreign/unknown UUID PATCH is a scoped 404, not a create.
        const foreign = await request.patch(`${API_BASE}/api/notification-channels/${BOGUS_UUID}`, {
            headers: authedHeaders(token),
            data: { name: 'nope' },
            timeout: TIMEOUT,
        });
        expect(foreign.status()).toBe(404);
        expect((await foreign.json()).message).toBe('Channel not found');
    });
});

test.describe('Settings · Integrations · Channels — UI', () => {
    test('Add-channel wizard: open → pick Slack → fill webhook → submit surfaces the truthful server-action result', async ({
        page,
        baseURL,
    }) => {
        const origin = baseURL ?? 'http://localhost:3000';
        const uniqueName = `E2E Slack ${Date.now()}`;

        // The page lives under the (dashboard) group with localePrefix:'never', so the URL
        // is unprefixed. The seeded storageState provides auth; unauth would 307 to /login.
        await page.goto(`${origin}/settings/integrations/channels`, {
            waitUntil: 'domcontentloaded',
            timeout: 45_000,
        });

        // Header proves the integrations-channels surface rendered (not a redirect to login).
        const heading = page.getByRole('heading', { name: /notification channels/i }).first();
        await expect(heading).toBeVisible({ timeout: 30_000 });

        // The web notification-channels client targets the CORRECT route: API_URL is normalized
        // to end with `/api` and the client endpoint is `/notification-channels`, so the server
        // component's list() resolves `/api/notification-channels` and SUCCEEDS (verified 200 via
        // curl against the live API). A fresh session renders the empty state; a session that
        // already owns channels renders the table. The real precondition is that the channels
        // surface rendered (not a redirect to login), so assert the always-present "Add channel"
        // affordance rather than a specific channel count (retry-safe under the shared DB).
        const addButton = page.getByRole('button', { name: /add channel/i }).first();
        await expect(addButton).toBeVisible({ timeout: 15_000 });

        // Open the Add-channel wizard. Retry the first click to ride out the hydration
        // race (a pre-hydration click is swallowed), then wait for the dialog to mount.
        const dialog = page.getByRole('dialog', { name: /add notification channel/i });
        await expect(async () => {
            await addButton.click({ timeout: 5_000 }).catch(() => {});
            await expect(dialog).toBeVisible({ timeout: 5_000 });
        }).toPass({ timeout: 30_000 });

        // The wizard heading + provider/name controls prove the wizard mounted and hydrated.
        await expect(dialog.getByRole('heading', { name: /^add channel$/i })).toBeVisible();

        // Pick Slack from the provider <select> and fill the wizard fields.
        await dialog.getByRole('combobox').first().selectOption({ label: 'Slack' });
        // Name input is the first text input in the dialog; target by its placeholder which
        // is "My <Provider> channel".
        const nameInput = dialog.getByPlaceholder(/my slack channel/i).first();
        await expect(nameInput).toBeVisible({ timeout: 10_000 });
        await nameInput.fill(uniqueName);
        // Slack's only field is the Incoming Webhook URL (placeholder hooks.slack.com/services/…).
        const webhookInput = dialog.getByPlaceholder(/hooks\.slack\.com\/services/i).first();
        const webhookUrl = 'https://hooks.slack.com/services/T123/B456/uiwebhooksecret';
        await webhookInput.fill(webhookUrl);
        // Controlled inputs hold what we typed — proves the wizard's onChange wiring is live.
        await expect(nameInput).toHaveValue(uniqueName);
        await expect(webhookInput).toHaveValue(webhookUrl);

        // Submit. The create server action POSTs to the CORRECT `/api/notification-channels`
        // route (verified 201 via curl against the live API), resolves `{ success:true,
        // channel }`, so `onCreated` appends the new channel and closes the wizard. Retry the
        // click to ride out the pre-hydration swallow; re-fill each pass so a swallowed-then-
        // cleared input can't submit blank. The Create button is disabled while the create
        // transition is pending, so a retried click can't double-submit. Success = dialog closed.
        const createButton = dialog.getByRole('button', { name: /create channel/i });
        await expect(async () => {
            if (await dialog.isVisible()) {
                if ((await nameInput.inputValue()) !== uniqueName) await nameInput.fill(uniqueName);
                if ((await webhookInput.inputValue()) !== webhookUrl)
                    await webhookInput.fill(webhookUrl);
                await createButton.click({ timeout: 5_000 }).catch(() => {});
            }
            await expect(dialog).toBeHidden({ timeout: 5_000 });
        }).toPass({ timeout: 30_000 });

        // The newly created channel lands as a data row: its unique name, the Slack provider
        // label, and the per-row Test + Remove actions. The unique-per-attempt name keeps this
        // retry-safe (a prior attempt's row can't be mistaken for this one).
        const createdRow = page.getByRole('row').filter({ hasText: uniqueName }).first();
        await expect(createdRow).toBeVisible({ timeout: 20_000 });
        await expect(createdRow.getByText('Slack', { exact: true })).toBeVisible();
        const rowTestButton = createdRow.getByRole('button', { name: /^test$/i });
        const rowRemoveButton = createdRow.getByRole('button', { name: /^remove$/i });
        await expect(rowTestButton).toBeVisible();
        await expect(rowRemoveButton).toBeVisible();

        // Test surfaces the TRUTHFUL provider failure badge — the bound slack-channel plugin
        // POSTs the fictitious hook, Slack answers 404, so the server-action test resolves
        // `{ status:'failed', error:'Slack webhook failed (404): …' }` and the row renders a red
        // "✗ <error>" badge, never the green "✓ Sent". Retry the click to ride out any
        // pre-hydration swallow.
        const testBadge = createdRow.locator('span.text-red-600');
        await expect(async () => {
            await rowTestButton.click({ timeout: 5_000 }).catch(() => {});
            await expect(testBadge).toBeVisible({ timeout: 5_000 });
        }).toPass({ timeout: 30_000 });
        await expect(testBadge).toContainText('✗ Slack webhook failed (404): ');
        await expect(createdRow.locator('span.text-green-600')).toHaveCount(0);

        // Remove drops the row (the documented flow-6 affordance) and cleans up the channel this
        // test created in the shared in-memory DB. Retry the click to ride out a swallow.
        await expect(async () => {
            if (await createdRow.isVisible().catch(() => false)) {
                await rowRemoveButton.click({ timeout: 5_000 }).catch(() => {});
            }
            await expect(page.getByRole('row').filter({ hasText: uniqueName })).toHaveCount(0, {
                timeout: 5_000,
            });
        }).toPass({ timeout: 30_000 });
    });
});
