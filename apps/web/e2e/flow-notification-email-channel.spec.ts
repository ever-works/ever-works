import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';
import {
    isMailhogAvailable,
    clearMailhogInbox,
    waitForMessageTo,
    headerOf,
    type MailhogMessage,
} from './helpers/mailhog';

/**
 * Notification EMAIL CHANNEL — deep cross-feature integration flows.
 *
 * Companion to the shallow coverage already shipped (none of which this file
 * repeats):
 *   - notification-channels.spec.ts        (GET prefs shape + auth gate)
 *   - notifications-channel-toggle.spec.ts (generic boolean round-trip)
 *   - notifications-preferences.spec.ts    (single mute / quiet-hours persist;
 *                                           subscribe via discord-channel id)
 *   - notifications-v2-inbox.spec.ts       (channel CRUD smoke, event-types seeded)
 *   - flow-notifications.spec.ts           (in-app read lifecycle; prefs-gate UI;
 *                                           ONE email channel CRUD + forgot-password mail)
 *
 * This file targets the EMAIL CHANNEL as a first-class delivery target and the
 * preference machinery that gates email-vs-in-app:
 *   1. email channel enable → disable (DROPS it from the active list — the gate)
 *      → re-enable; rename; truthful test-send state.
 *   2. subscribing an event to a REAL owned email channel id (+ foreign/unknown
 *      rejection + clearing the selection to []).
 *   3. cross-user channel isolation matrix (the security-relevant edges).
 *   4. quiet-hours + multi-category mute composite delivery gate (+ expiry,
 *      upsert-dedup, unmute, clear-to-null) all surviving each other on read-back.
 *   5. an email-bearing event (forgot-password) landing in MailHog — best-effort —
 *      alongside a same-address email channel.
 *   6. email-channel preference precedence: a per-event subscription overrides the
 *      seeded `defaultChannels: ['in-app']`; the email id survives reads.
 *
 * PROBED, TRUTHFUL contracts (verified via curl against http://127.0.0.1:3100
 * with throwaway registered users BEFORE writing any assertion; cross-checked
 * against the controller/service source):
 *
 *   apps/api/src/notification-channels/notification-channels.controller.ts
 *   + .service.ts  @Controller('api/notification-channels') (AuthSessionGuard):
 *     GET    /                 -> 200 { channels }   service.list() ==
 *        repo.findActiveByUser() ⇒ DISABLED channels are FILTERED OUT of this list
 *        (a disabled channel does NOT appear on GET — the "off" gate). [] fresh.
 *     POST   /                 -> 201 { channel }
 *        channel = { id, userId, pluginId, name, targetConfig, verified:false,
 *                    disabledAt:null, tenantId:null, organizationId:null,
 *                    createdAt, updatedAt }
 *        (ANY pluginId string is accepted at create — 'email','webhook',… — the
 *         delivery plugin is only resolved at test/send time.)
 *        NOTE (probed bug, asserted truthfully): omitting `name` returns
 *        500 {"statusCode":500,"message":"Internal server error"} (no DTO
 *        validation guard) — NOT a 400. This file does not depend on that edge.
 *     PATCH  /:id { name?, targetConfig?, disabled? } -> 200 { channel }
 *        service: `patch.disabledAt = disabled ? new Date() : null`.
 *        disabled:true  -> stamps disabledAt (ISO) AND drops it from GET list.
 *        disabled:false -> clears disabledAt back to null (reappears on GET).
 *     DELETE /:id -> 204 (SCOPED via findOwnedOrThrow FIRST). A foreign/unknown
 *        id is therefore NOT a silent no-op: it 404s "Channel not found" and the
 *        owner's row is untouched (probed: owner count unchanged).
 *     POST   /:id/test -> 201 { status, error?, providerMessageId? }  (returned
 *        DIRECTLY — NOT wrapped). e2e/CI enables no channel-delivery plugin, so
 *        the TRUTHFUL state is status:'failed',
 *        error:"Notification channel plugin not found or disabled: email".
 *        foreign/unknown id -> 404 "Channel not found".
 *     update/remove/sendTest all 404 "Channel not found" for a non-owned id
 *        (findOwnedOrThrow → NotFoundException('Channel not found')).
 *
 *   apps/api/src/notifications/notification-preferences.controller.ts
 *   + .service.ts  @Controller('api/notifications') (AuthSessionGuard):
 *     GET  /event-types -> 200 { eventTypes }  (8 seeded core rows; categories
 *          ['agents','ai_credits','generation','integrations','system']; EVERY
 *          core row has defaultChannels:['in-app']; keys: agent_run_finished,
 *          ai_credits_depleted, ai_provider_error, generation_error,
 *          schedule_paused, work_generation_finished, git_auth_expired,
 *          mission_blocked. agent_run_finished is category 'agents'.)
 *     GET  /preferences -> 200 { subscriptions:[], preference:null, mutes:[] } fresh.
 *     PUT  /preferences/event/:key { channelIds } -> 200 { subscription:
 *          { id,userId,eventTypeKey,channelIds,updatedAt } }
 *        - 'in-app' is a built-in sentinel id (always allowed).
 *        - any non-built-in id must be a notification_channels row OWNED by the
 *          caller, else 400 "Unknown or unauthorized notification channel: <id>".
 *        - unknown event key -> 400 "Unknown notification event type: <key>".
 *        - channelIds:[] -> 200 (clears the selection; row persists with []).
 *        - channelIds de-duped, stored verbatim, order preserved as sent.
 *     PUT  /preferences/quiet-hours { quietHoursStart,quietHoursEnd,timezone } ->
 *          200 { preference } (explicit nulls accepted -> clears the window).
 *     POST /preferences/mute { category, mutedUntil? } -> 201 { mute }
 *          (upsert by category — re-muting the same category stays 201 and the
 *           preferences view shows ONE row per category; mutedUntil null = forever).
 *     DELETE /preferences/mute/:category -> 204.
 *     All endpoints 401 without auth (probed).
 *
 * ENVIRONMENT NOTES (CI-faithful):
 *   - There is NO public API that deterministically CREATES an in-app
 *     notification row (every producer fires from a background event needing an
 *     LLM key / Trigger.dev — absent in CI). So these flows assert the
 *     preference + channel ROUTING contract (subscriptions, gates, channel
 *     lifecycle) rather than literal delivery of a fired in-app notification.
 *   - There is NO digest/batching CRUD endpoint. The closest real batching gate
 *     is quiet-hours deferral (the fanout listener carries a deferUntil for
 *     deferred channels) — exercised in flow 4.
 *   - MAIL: MailHog HTTP API (:8025) is UP in CI but SMTP delivery is best-effort
 *     ("Missing credentials for PLAIN") — the mailbox may never receive. Mail
 *     assertions self-gate on isMailhogAvailable() and tolerate waitForMessageTo
 *     returning null; the email-triggering action + its API contract are always
 *     asserted. Locally without the container, the mailbox read is annotated-skip.
 *   - CROSS-SPEC ISOLATION: every mutation runs on a FRESH registerUserViaAPI()
 *     user (unique email per run). Counts use toContain / not.toContain, never
 *     exact totals, to tolerate the shared in-memory DB.
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
}

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

async function createEmailChannel(
    request: APIRequestContext,
    token: string,
    name: string,
    to: string,
): Promise<NotificationChannel> {
    const res = await request.post(`${API_BASE}/api/notification-channels`, {
        headers: authedHeaders(token),
        data: { pluginId: 'email', name, targetConfig: { to } },
        timeout: TIMEOUT,
    });
    expect(res.status(), `create channel body=${await res.text().catch(() => '')}`).toBe(201);
    return (await res.json()).channel as NotificationChannel;
}

async function getPreferences(request: APIRequestContext, token: string) {
    const res = await request.get(`${API_BASE}/api/notifications/preferences`, {
        headers: authedHeaders(token),
        timeout: TIMEOUT,
    });
    expect(res.status(), `prefs body=${await res.text().catch(() => '')}`).toBe(200);
    return res.json() as Promise<{
        subscriptions: Array<{ eventTypeKey: string; channelIds: string[]; userId: string }>;
        preference: {
            quietHoursStart: string | null;
            quietHoursEnd: string | null;
            timezone: string | null;
        } | null;
        mutes: Array<{ category: string; mutedUntil: string | null }>;
    }>;
}

test.describe('Notification email channel — deep integration', () => {
    test('email channel enable → disable (drops from active list) → re-enable round-trip + truthful test-send state', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request, { email: `nec-life-${Date.now()}@test.local` });
        const token = u.access_token;

        // Fresh user owns no channels.
        expect(await listChannels(request, token)).toEqual([]);

        // Create the email channel — born enabled (disabledAt null), unverified.
        const ch = await createEmailChannel(request, token, 'Primary Inbox', u.email);
        expect(ch.id).toBeTruthy();
        expect(ch.pluginId).toBe('email');
        expect(ch.name).toBe('Primary Inbox');
        expect(ch.targetConfig).toEqual({ to: u.email });
        expect(ch.verified).toBe(false);
        expect(ch.disabledAt, 'new email channel is enabled (disabledAt null)').toBeNull();
        expect(ch.userId).toBe(u.user.id);

        // Enabled channel appears in the active list.
        expect((await listChannels(request, token)).map((c) => c.id)).toContain(ch.id);

        // Disable — service stamps disabledAt. The list endpoint is
        // findActiveByUser, so a disabled channel is the OFF gate: it is
        // FILTERED OUT of GET entirely (probed: list returns [] when the only
        // channel is disabled), not merely flagged.
        const disable = await request.patch(`${API_BASE}/api/notification-channels/${ch.id}`, {
            headers: authedHeaders(token),
            data: { disabled: true },
            timeout: TIMEOUT,
        });
        expect(disable.status()).toBe(200);
        const disabled = (await disable.json()).channel as NotificationChannel;
        expect(disabled.disabledAt, 'disabled:true stamps disabledAt').toBeTruthy();
        expect(
            (await listChannels(request, token)).map((c) => c.id),
            'a disabled channel disappears from the active list (the off gate)',
        ).not.toContain(ch.id);

        // Re-enable — clears disabledAt back to null; the channel REAPPEARS in GET.
        const enable = await request.patch(`${API_BASE}/api/notification-channels/${ch.id}`, {
            headers: authedHeaders(token),
            data: { disabled: false },
            timeout: TIMEOUT,
        });
        expect(enable.status()).toBe(200);
        expect(
            (await enable.json()).channel.disabledAt,
            'disabled:false clears disabledAt back to null',
        ).toBeNull();
        expect(
            (await listChannels(request, token)).map((c) => c.id),
            'a re-enabled channel returns to the active list',
        ).toContain(ch.id);

        // Renaming persists alongside the enabled state.
        const rename = await request.patch(`${API_BASE}/api/notification-channels/${ch.id}`, {
            headers: authedHeaders(token),
            data: { name: 'Renamed Inbox' },
            timeout: TIMEOUT,
        });
        expect(rename.status()).toBe(200);
        const renamed = (await rename.json()).channel as NotificationChannel;
        expect(renamed.name).toBe('Renamed Inbox');
        expect(renamed.disabledAt, 'rename does not re-disable').toBeNull();

        // Test-send reports the TRUTHFUL provider state, returned DIRECTLY (not
        // wrapped). The e2e/CI env enables no channel-delivery plugin, so the
        // email channel cannot deliver — the facade returns a failed status with a
        // precise reason. If an env DID enable an email delivery plugin a
        // delivered/queued status is also acceptable.
        const testRes = await request.post(`${API_BASE}/api/notification-channels/${ch.id}/test`, {
            headers: authedHeaders(token),
            timeout: TIMEOUT,
        });
        expect(testRes.status()).toBe(201);
        const testBody = await testRes.json();
        expect(typeof testBody.status).toBe('string');
        if (testBody.status === 'failed') {
            // Probed exact wording: "Notification channel plugin not found or disabled: email".
            expect(testBody.error).toContain('email');
            expect(testBody.error.toLowerCase()).toMatch(/plugin not found|disabled|no .*plugin/);
        } else {
            expect(['delivered', 'queued', 'sent', 'accepted']).toContain(testBody.status);
        }
    });

    test('subscribe an event to a REAL owned email channel id; foreign + unknown ids rejected; selection clearable', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request, { email: `nec-sub-${Date.now()}@test.local` });
        const token = u.access_token;

        const email = await createEmailChannel(request, token, 'Sub Inbox', u.email);

        // Subscribe `agent_run_finished` to [email-channel-id, in-app]. This is the
        // real row the fanout resolver reads — proving a user can route an event to
        // their OWN email channel (not just the built-in in-app sentinel).
        const sub = await request.put(
            `${API_BASE}/api/notifications/preferences/event/agent_run_finished`,
            {
                headers: authedHeaders(token),
                data: { channelIds: [email.id, 'in-app'] },
                timeout: TIMEOUT,
            },
        );
        expect(sub.status()).toBe(200);
        const { subscription } = await sub.json();
        expect(subscription.eventTypeKey).toBe('agent_run_finished');
        expect(subscription.userId).toBe(u.user.id);
        // Stored verbatim, order preserved (email first, in-app fallback second).
        expect(subscription.channelIds).toEqual([email.id, 'in-app']);

        // Read-back proves it persisted into the preferences view.
        const prefs = await getPreferences(request, token);
        expect(prefs.subscriptions).toHaveLength(1);
        expect(prefs.subscriptions[0].channelIds).toEqual([email.id, 'in-app']);

        // A foreign/unknown channel UUID is rejected with the precise message —
        // you cannot route an event to a channel you do not own.
        const foreign = await request.put(
            `${API_BASE}/api/notifications/preferences/event/ai_credits_depleted`,
            { headers: authedHeaders(token), data: { channelIds: [BOGUS_UUID] }, timeout: TIMEOUT },
        );
        expect(foreign.status()).toBe(400);
        expect((await foreign.json()).message).toBe(
            `Unknown or unauthorized notification channel: ${BOGUS_UUID}`,
        );

        // A typo'd event key is rejected before any channel validation.
        const badEvent = await request.put(
            `${API_BASE}/api/notifications/preferences/event/totally_made_up_event`,
            { headers: authedHeaders(token), data: { channelIds: ['in-app'] }, timeout: TIMEOUT },
        );
        expect(badEvent.status()).toBe(400);
        expect((await badEvent.json()).message).toBe(
            'Unknown notification event type: totally_made_up_event',
        );

        // The failed writes did not corrupt the good subscription.
        const prefsAfterRejects = await getPreferences(request, token);
        expect(prefsAfterRejects.subscriptions).toHaveLength(1);
        expect(prefsAfterRejects.subscriptions[0].channelIds).toEqual([email.id, 'in-app']);

        // Clearing the selection (channelIds:[]) is accepted and overwrites the row.
        const clear = await request.put(
            `${API_BASE}/api/notifications/preferences/event/agent_run_finished`,
            { headers: authedHeaders(token), data: { channelIds: [] }, timeout: TIMEOUT },
        );
        expect(clear.status()).toBe(200);
        expect((await clear.json()).subscription.channelIds).toEqual([]);
        const prefsCleared = await getPreferences(request, token);
        expect(prefsCleared.subscriptions[0].channelIds).toEqual([]);
    });

    test('cross-user email channel isolation matrix — no read/route/patch/test/delete across tenants', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request, {
            email: `nec-own-${Date.now()}@test.local`,
        });
        const other = await registerUserViaAPI(request, {
            email: `nec-oth-${Date.now()}@test.local`,
        });

        const ownerChannel = await createEmailChannel(
            request,
            owner.access_token,
            'Owner Inbox',
            owner.email,
        );

        // The other user's list never includes the owner's channel.
        const otherList = await listChannels(request, other.access_token);
        expect(otherList.map((c) => c.id)).not.toContain(ownerChannel.id);

        // The other user cannot ROUTE an event to the owner's channel id — the
        // ownership check treats it as foreign (400, NOT a leak of existence shape).
        const routeForeign = await request.put(
            `${API_BASE}/api/notifications/preferences/event/agent_run_finished`,
            {
                headers: authedHeaders(other.access_token),
                data: { channelIds: [ownerChannel.id] },
                timeout: TIMEOUT,
            },
        );
        expect(routeForeign.status()).toBe(400);
        expect((await routeForeign.json()).message).toBe(
            `Unknown or unauthorized notification channel: ${ownerChannel.id}`,
        );

        // The other user cannot PATCH the owner's channel — scoped lookup 404s
        // "Channel not found" (NOT 403; the row simply doesn't exist in their view).
        const patchForeign = await request.patch(
            `${API_BASE}/api/notification-channels/${ownerChannel.id}`,
            {
                headers: authedHeaders(other.access_token),
                data: { name: 'hijacked' },
                timeout: TIMEOUT,
            },
        );
        expect(patchForeign.status()).toBe(404);
        expect((await patchForeign.json()).message).toBe('Channel not found');

        // The other user cannot test-send through the owner's channel — same 404.
        const testForeign = await request.post(
            `${API_BASE}/api/notification-channels/${ownerChannel.id}/test`,
            { headers: authedHeaders(other.access_token), timeout: TIMEOUT },
        );
        expect(testForeign.status()).toBe(404);
        expect((await testForeign.json()).message).toBe('Channel not found');

        // DELETE of a foreign id is SCOPED (findOwnedOrThrow runs first), so it
        // 404s rather than silently succeeding — and the owner's row is untouched.
        const delForeign = await request.delete(
            `${API_BASE}/api/notification-channels/${ownerChannel.id}`,
            { headers: authedHeaders(other.access_token), timeout: TIMEOUT },
        );
        expect(delForeign.status()).toBe(404);
        expect((await delForeign.json()).message).toBe('Channel not found');

        const ownerListAfter = await listChannels(request, owner.access_token);
        expect(
            ownerListAfter.map((c) => c.id),
            'owner channel survives a foreign DELETE attempt',
        ).toContain(ownerChannel.id);

        // The owner CAN delete their own channel (204) and it disappears.
        const delOwn = await request.delete(
            `${API_BASE}/api/notification-channels/${ownerChannel.id}`,
            { headers: authedHeaders(owner.access_token), timeout: TIMEOUT },
        );
        expect(delOwn.status()).toBe(204);
        expect((await listChannels(request, owner.access_token)).map((c) => c.id)).not.toContain(
            ownerChannel.id,
        );

        // Testing a now-deleted channel is a truthful 404 "Channel not found".
        const testDeleted = await request.post(
            `${API_BASE}/api/notification-channels/${ownerChannel.id}/test`,
            { headers: authedHeaders(owner.access_token), timeout: TIMEOUT },
        );
        expect(testDeleted.status()).toBe(404);
        expect((await testDeleted.json()).message).toBe('Channel not found');
    });

    test('quiet-hours + multi-category mute composite delivery gate persists together, with expiry, upsert-dedup, unmute, and clear-to-null', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request, { email: `nec-gate-${Date.now()}@test.local` });
        const token = u.access_token;

        // Route an event to the email channel so there's a live subscription that
        // the gates (quiet-hours/mute) sit on top of.
        const email = await createEmailChannel(request, token, 'Gate Inbox', u.email);
        const sub = await request.put(
            `${API_BASE}/api/notifications/preferences/event/generation_error`,
            {
                headers: authedHeaders(token),
                data: { channelIds: [email.id, 'in-app'] },
                timeout: TIMEOUT,
            },
        );
        expect(sub.status()).toBe(200);

        // Set quiet hours (the time-window gate that DEFERS email delivery — the
        // closest thing to a batching/digest contract in this API).
        const quiet = await request.put(`${API_BASE}/api/notifications/preferences/quiet-hours`, {
            headers: authedHeaders(token),
            data: {
                quietHoursStart: '23:30',
                quietHoursEnd: '06:15',
                timezone: 'America/New_York',
            },
            timeout: TIMEOUT,
        });
        expect(quiet.status()).toBe(200);
        const { preference } = await quiet.json();
        expect(preference.quietHoursStart).toBe('23:30');
        expect(preference.quietHoursEnd).toBe('06:15');
        expect(preference.timezone).toBe('America/New_York');

        // Mute two categories: one forever (no mutedUntil), one with a far-future
        // expiry. Both are the per-category gate that suppresses delivery.
        const muteForever = await request.post(`${API_BASE}/api/notifications/preferences/mute`, {
            headers: authedHeaders(token),
            data: { category: 'generation' },
            timeout: TIMEOUT,
        });
        expect(muteForever.status()).toBe(201);
        expect((await muteForever.json()).mute).toEqual({
            category: 'generation',
            mutedUntil: null,
        });

        const farFuture = '2999-01-01T00:00:00.000Z';
        // NOTE: the mute endpoint validates `category` against the
        // NotificationCategory ENUM (@IsEnum), whose agent value is the SINGULAR
        // 'agent' — NOT the plural 'agents' used as an event-type *category*. A
        // plural 'agents' here 400s "category must be one of: …, agent, task".
        // (The seeded event-type `agent_run_finished` lives under the plural
        // 'agents' category, but that is a different vocabulary from the mute enum.)
        const muteUntil = await request.post(`${API_BASE}/api/notifications/preferences/mute`, {
            headers: authedHeaders(token),
            data: { category: 'agent', mutedUntil: farFuture },
            timeout: TIMEOUT,
        });
        expect(muteUntil.status()).toBe(201);
        expect((await muteUntil.json()).mute).toEqual({
            category: 'agent',
            mutedUntil: farFuture,
        });

        // Re-muting the SAME category is an upsert (still 201) and must NOT create a
        // duplicate row — the preferences view shows one entry per category.
        const reMute = await request.post(`${API_BASE}/api/notifications/preferences/mute`, {
            headers: authedHeaders(token),
            data: { category: 'agent', mutedUntil: farFuture },
            timeout: TIMEOUT,
        });
        expect(reMute.status()).toBe(201);

        // Read-back proves all gates persisted together (subscription + quiet hours
        // + both mutes), and mutes are de-duplicated by category.
        const prefs = await getPreferences(request, token);
        expect(prefs.subscriptions.map((s) => s.eventTypeKey)).toContain('generation_error');
        expect(prefs.preference?.timezone).toBe('America/New_York');
        expect(prefs.preference?.quietHoursStart).toBe('23:30');
        const muteCats = prefs.mutes.map((m) => m.category);
        expect(muteCats).toContain('generation');
        expect(muteCats).toContain('agent');
        expect(
            muteCats.filter((c) => c === 'agent'),
            'mutes are upserted by category (no duplicate rows)',
        ).toHaveLength(1);
        const agentsMute = prefs.mutes.find((m) => m.category === 'agent');
        expect(agentsMute?.mutedUntil).toBe(farFuture);

        // Unmute one category (204) — it disappears, the other mute + quiet-hours
        // + subscription all survive.
        const unmute = await request.delete(
            `${API_BASE}/api/notifications/preferences/mute/generation`,
            { headers: authedHeaders(token), timeout: TIMEOUT },
        );
        expect(unmute.status()).toBe(204);
        const prefsAfterUnmute = await getPreferences(request, token);
        expect(prefsAfterUnmute.mutes.map((m) => m.category)).not.toContain('generation');
        expect(prefsAfterUnmute.mutes.map((m) => m.category)).toContain('agent');
        expect(prefsAfterUnmute.preference?.timezone).toBe('America/New_York');
        expect(prefsAfterUnmute.subscriptions.map((s) => s.eventTypeKey)).toContain(
            'generation_error',
        );

        // Clearing quiet hours with explicit nulls is accepted and zeroes the
        // window without touching mutes/subscriptions.
        const clearQuiet = await request.put(
            `${API_BASE}/api/notifications/preferences/quiet-hours`,
            {
                headers: authedHeaders(token),
                data: { quietHoursStart: null, quietHoursEnd: null, timezone: null },
                timeout: TIMEOUT,
            },
        );
        expect(clearQuiet.status()).toBe(200);
        const cleared = (await clearQuiet.json()).preference;
        expect(cleared.quietHoursStart).toBeNull();
        expect(cleared.quietHoursEnd).toBeNull();
        expect(cleared.timezone).toBeNull();
        const prefsFinal = await getPreferences(request, token);
        expect(prefsFinal.preference?.quietHoursStart ?? null).toBeNull();
        expect(prefsFinal.mutes.map((m) => m.category)).toContain('agent');
    });

    test('email-bearing event (forgot-password) lands in MailHog — best-effort — alongside a same-address email channel', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request, { email: `nec-mail-${Date.now()}@test.local` });
        const token = u.access_token;

        // Register an email channel pointed at the SAME address the email-bearing
        // event will target. The channel (a user-config row) and the transactional
        // mail (an auth event) are independent subsystems; this proves they coexist
        // without one shadowing the other.
        const channel = await createEmailChannel(request, token, 'Mailbox', u.email);
        expect(channel.targetConfig).toEqual({ to: u.email });

        // Gate the mailbox read on MailHog reachability; clear noise if up.
        const mailhogUp = await isMailhogAvailable(request);
        if (mailhogUp) {
            await clearMailhogInbox(request);
        }

        // Trigger a REAL email-bearing event. forgot-password is @Public, uniform-
        // response, and emits the reset email via the mail service -> SMTP (MailHog
        // in CI). This is asserted UNCONDITIONALLY regardless of delivery success.
        const forgot = await request.post(`${API_BASE}/api/auth/forgot-password`, {
            data: { email: u.email },
            timeout: TIMEOUT,
        });
        expect(forgot.status()).toBe(200);
        expect((await forgot.json()).message).toBe(
            'If the email exists, a reset link has been sent',
        );

        // The email channel is unaffected by the auth-event mail send.
        expect((await listChannels(request, token)).map((c) => c.id)).toContain(channel.id);

        if (!mailhogUp) {
            test.info().annotations.push({
                type: 'skip-reason',
                description:
                    'MailHog (:8025) unreachable — mailbox read skipped (runs in CI). The forgot-password trigger + 200 contract are asserted above.',
            });
            return;
        }

        // Mailbox content is BEST-EFFORT: MailHog HTTP is up but e2e SMTP delivery
        // can fail ("Missing credentials for PLAIN"), so the message may never land.
        // Validate the email IF delivered; otherwise the API contract above stands.
        const message: MailhogMessage | null = await waitForMessageTo(request, u.email, {
            timeoutMs: 15_000,
        });
        if (!message) {
            test.info().annotations.push({
                type: 'mail-not-delivered',
                description: `reset email to ${u.email} not delivered (e2e SMTP delivery is best-effort); forgot-password 200 already asserted.`,
            });
            return;
        }

        const to = message.To.map((t) => `${t.Mailbox}@${t.Domain}`.toLowerCase());
        expect(to).toContain(u.email.toLowerCase());
        const subject = headerOf(message, 'Subject') ?? '';
        expect(subject.length).toBeGreaterThan(0);
        expect(subject.toLowerCase()).toMatch(/password|reset/);
        const body = message.Content.Body ?? '';
        expect(body.toLowerCase()).toContain('reset');
        expect(body).toMatch(/token=/i);
    });

    test('email-channel preference precedence — a per-event subscription overrides the seeded in-app default and the email id survives reads', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request, { email: `nec-prec-${Date.now()}@test.local` });
        const token = u.access_token;

        // The seeded event-type registry: 8 core rows, every one defaulting to
        // in-app only. This is the BASELINE the user overrides per event.
        const etRes = await request.get(`${API_BASE}/api/notifications/event-types`, {
            headers: authedHeaders(token),
            timeout: TIMEOUT,
        });
        expect(etRes.status()).toBe(200);
        const eventTypes = (await etRes.json()).eventTypes as Array<{
            key: string;
            category: string;
            defaultChannels: string[];
        }>;
        expect(Array.isArray(eventTypes)).toBe(true);
        // 8 seeded core rows (probed). Tolerate plugin-contributed extras with >=.
        expect(eventTypes.length).toBeGreaterThanOrEqual(8);
        const keys = eventTypes.map((e) => e.key);
        for (const k of ['agent_run_finished', 'ai_credits_depleted', 'generation_error']) {
            expect(keys).toContain(k);
        }
        const agentEvent = eventTypes.find((e) => e.key === 'agent_run_finished')!;
        expect(agentEvent.category).toBe('agents');
        // The seeded default is in-app only — email is NOT a default channel.
        expect(agentEvent.defaultChannels).toContain('in-app');
        expect(agentEvent.defaultChannels).not.toContain('email');

        // Fresh user has no overrides — delivery would follow the in-app default.
        const prefs0 = await getPreferences(request, token);
        expect(prefs0.subscriptions).toEqual([]);

        // Create an email channel and OVERRIDE agent_run_finished to deliver to the
        // email channel ONLY (drop the in-app default). This is the user opting into
        // email-vs-in-app: the per-event subscription takes precedence over the
        // seeded defaultChannels.
        const email = await createEmailChannel(request, token, 'Precedence Inbox', u.email);
        const override = await request.put(
            `${API_BASE}/api/notifications/preferences/event/agent_run_finished`,
            { headers: authedHeaders(token), data: { channelIds: [email.id] }, timeout: TIMEOUT },
        );
        expect(override.status()).toBe(200);
        expect((await override.json()).subscription.channelIds).toEqual([email.id]);

        // The override persists and shadows the in-app default on read-back.
        const prefs1 = await getPreferences(request, token);
        const arf = prefs1.subscriptions.find((s) => s.eventTypeKey === 'agent_run_finished');
        expect(arf, 'agent_run_finished now has an explicit subscription row').toBeTruthy();
        expect(arf!.channelIds, 'email-only override replaces the in-app default').toEqual([
            email.id,
        ]);

        // A DIFFERENT event keeps the in-app default (no subscription row created) —
        // proving the override is per-event, not global.
        const otherArf = prefs1.subscriptions.find((s) => s.eventTypeKey === 'ai_credits_depleted');
        expect(otherArf, 'ai_credits_depleted is untouched (still default-driven)').toBeUndefined();

        // Re-add in-app alongside email (user wants BOTH channels). Order is stored
        // as sent, proving the subscription is the authoritative channel list.
        const both = await request.put(
            `${API_BASE}/api/notifications/preferences/event/agent_run_finished`,
            {
                headers: authedHeaders(token),
                data: { channelIds: ['in-app', email.id] },
                timeout: TIMEOUT,
            },
        );
        expect(both.status()).toBe(200);
        expect((await both.json()).subscription.channelIds).toEqual(['in-app', email.id]);

        // Deleting the email channel must not break the preferences read (the stored
        // id may dangle, but the GET still returns a sane shape — no 5xx).
        const del = await request.delete(`${API_BASE}/api/notification-channels/${email.id}`, {
            headers: authedHeaders(token),
            timeout: TIMEOUT,
        });
        expect(del.status()).toBe(204);
        const prefsAfterDelete = await getPreferences(request, token);
        expect(Array.isArray(prefsAfterDelete.subscriptions)).toBe(true);
        const arfAfter = prefsAfterDelete.subscriptions.find(
            (s) => s.eventTypeKey === 'agent_run_finished',
        );
        // The subscription row survives the channel delete (stored verbatim).
        expect(arfAfter?.channelIds).toContain('in-app');
    });
});
