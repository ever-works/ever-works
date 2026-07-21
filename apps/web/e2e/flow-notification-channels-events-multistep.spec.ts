import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * Notification CHANNELS × EVENT-TYPES × PER-EVENT SUBSCRIPTIONS — MULTI-STEP
 * integration. Where the sibling specs each pin ONE surface in isolation, this
 * file threads the three surfaces together into end-to-end journeys and pins the
 * cross-surface CONTRACTS that only emerge when a channel row and a subscription
 * row interact. Every assertion was probed via curl against http://127.0.0.1:3100
 * with throwaway registered users BEFORE it was written, and cross-checked against
 * notification-channels.service.ts + notification-preferences.service.ts +
 * notification-preferences.controller.ts.
 *
 * NON-DUPLICATION — sibling specs own these and are NOT repeated here:
 *   - flow-notification-channels-crud-deep.spec.ts   channel CRUD/isolation/DTO
 *       validation/16KB cap/ParseUUIDPipe/webhook shape-guard/auth gates/uniqueness
 *       /verified-server-owned (the CHANNEL row in isolation).
 *   - flow-notification-preferences-deep.spec.ts     quiet-hours time/tz/partial/
 *       empty gates; mute enum + mutedUntil coercion + active-filter; unmute
 *       ParseEnumPipe; preference-record isolation; catalogue shape + (category,key)
 *       ordering (the PREFERENCE row in isolation).
 *   - flow-notifications-per-event.spec.ts           the PRODUCER side (task_assigned
 *       rows) + registry-gated subscribe 400s for UNREGISTERED keys.
 *
 * THIS FILE pins the residual CROSS-SURFACE / multi-step contracts none assert:
 *   1. SUBSCRIPTION UPSERT is REPLACE-in-place — re-PUT-ing an event overwrites its
 *      channelIds AND keeps the SAME subscription row id (exactly one row per event,
 *      never an append). updatedAt advances.
 *   2. channelIds DEDUP collapses duplicates preserving first-seen order
 *      (`[...new Set(channelIds)]`): [in-app,in-app,CA,CA] persists as [in-app,CA].
 *   3. EMPTY channelIds [] is a valid "silence this event" write (200, []), the
 *      unsubscribe-all shape — distinct from deleting the row.
 *   4. MAX_SUBSCRIPTION_CHANNELS=20 — the length gate runs BEFORE ownership: 21
 *      unique ids → 400 "Too many notification channels: maximum 20 allowed per
 *      subscription"; EXACTLY 20 unknown ids passes the length gate and 400s later
 *      on ownership ("Unknown or unauthorized …") — a message divergence at the
 *      boundary.
 *   5. built-in 'in-app' is OWNERSHIP-EXEMPT — a fresh user with ZERO channel rows
 *      subscribes ['in-app'] → 200. Owned + built-in mix routes/orders intact.
 *   6. DISABLED-channel DIVERGENCE — a disabled channel is ABSENT from GET
 *      /notification-channels (findActiveByUser filters disabledAt) yet STILL
 *      SUBSCRIBABLE (ownership uses findByIdForUser which ignores disabledAt);
 *      an existing subscription referencing it is untouched by the disable.
 *   7. DANGLING reference — DELETE-ing a subscribed channel leaves the dead id in
 *      the subscription's channelIds (no cascade cleanup), but the dead id can no
 *      longer be re-subscribed (400 unknown/unauthorized).
 *   8. CROSS-USER IDOR on the subscription gate — Alice cannot route an event to
 *      Bob's REAL channel id (400), even mixed with her own valid ids; the whole
 *      write is ATOMIC — nothing persists for that event on rejection.
 *   9. Per-event INDEPENDENCE — distinct events are distinct rows; mutating one
 *      never disturbs another.
 *  10. Channel RENAME is id-stable — a subscription references the channel by id,
 *      so renaming the channel does not alter the subscription's channelIds.
 *  11. COMBINED preferences triple — subscriptions + quiet-hours + mutes coexist in
 *      the single GET /preferences view without cross-contamination.
 *  12. event-types is a GET-only immutable registry (POST → 404); a user
 *      subscription OVERRIDES an event's catalogue defaultChannels without mutating
 *      the catalogue entry.
 *  13. test-send threads with a subscription — creating, subscribing, and test-
 *      sending a channel leaves the subscription intact (truthful CI send failure).
 *
 * PROBED, TRUTHFUL contracts (curl, 127.0.0.1:3100, fresh users):
 *   PUT /api/notifications/preferences/event/:key { channelIds:[…] }
 *     registered key           → 200 { subscription:{ id, userId, eventTypeKey,
 *                                     channelIds, updatedAt } }; re-PUT keeps id.
 *     channelIds dedup         → [...new Set(...)] first-seen order.
 *     []                       → 200 channelIds:[].
 *     >20 unique               → 400 "Too many notification channels: maximum 20 …".
 *     20 unknown               → 400 "Unknown or unauthorized notification channel: …".
 *     'in-app'                 → exempt from ownership (built-in).
 *     disabled owned channel   → still subscribable (200).
 *     deleted/foreign id       → 400 "Unknown or unauthorized notification channel: …".
 *     mixed valid+foreign      → 400, atomic (no row persisted).
 *   GET  /api/notifications/preferences → { subscriptions[], preference|null, mutes[] }.
 *   GET  /api/notifications/event-types → { eventTypes[] } (POST → 404).
 *   POST /api/notification-channels → 201 { channel }; GET list = findActiveByUser
 *     (excludes disabled); PATCH {disabled:true} sets disabledAt; DELETE → 204.
 *   POST /api/notification-channels/:id/test → 201 { status, error? }.
 *
 * ENVIRONMENT NOTES (CI-faithful):
 *   - FULL ISOLATION: every test registers its OWN fresh user(s) via
 *     registerUserViaAPI (unique email per call); no module-scope await/clock.
 *     Ids asserted via toContain/not.toContain, never exact global counts.
 *   - Pure API-contract (no LLM/mail/Redis) → keyless-CI safe. No channel-delivery
 *     plugin is enabled, so :id/test is a truthful failure (a positive status is
 *     tolerated). Anonymous probes use an EMPTY-storageState context so the shared
 *     auth cookie is not inherited.
 */

const TIMEOUT = 30_000;
const CHANNELS = `${API_BASE}/api/notification-channels`;
const PREFS = `${API_BASE}/api/notifications/preferences`;
const EVENT = (key: string) => `${PREFS}/event/${key}`;

// Core registered fanout event keys (probed live from GET /event-types).
const CORE_EVENTS = [
    'agent_run_finished',
    'ai_credits_depleted',
    'ai_provider_error',
    'generation_error',
    'schedule_paused',
    'work_generation_finished',
    'git_auth_expired',
    'mission_blocked',
] as const;

interface NotificationChannel {
    id: string;
    userId: string;
    pluginId: string;
    name: string;
    targetConfig: Record<string, unknown>;
    verified: boolean;
    disabledAt: string | null;
}

interface Subscription {
    id: string;
    userId: string;
    eventTypeKey: string;
    channelIds: string[];
    updatedAt: string;
}

interface PreferencesView {
    subscriptions: Subscription[];
    preference: {
        quietHoursStart: string | null;
        quietHoursEnd: string | null;
        timezone: string | null;
    } | null;
    mutes: Array<{ category: string; mutedUntil: string | null }>;
}

/** A per-process counter keeps names unique WITHOUT a module-scope clock read. */
let seq = 0;
function uniq(prefix: string): string {
    seq += 1;
    return `${prefix}-${seq}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

async function freshUser(request: APIRequestContext) {
    const u = await registerUserViaAPI(request);
    return { token: u.access_token, headers: authedHeaders(u.access_token), id: u.user.id };
}

async function createChannel(
    request: APIRequestContext,
    token: string,
    pluginId = 'slack',
    targetConfig: Record<string, unknown> = {},
): Promise<NotificationChannel> {
    const res = await request.post(CHANNELS, {
        headers: authedHeaders(token),
        data: { pluginId, name: uniq('chan'), targetConfig },
        timeout: TIMEOUT,
    });
    expect(res.status(), `create channel body=${await res.text().catch(() => '')}`).toBe(201);
    return (await res.json()).channel as NotificationChannel;
}

async function listChannels(
    request: APIRequestContext,
    token: string,
): Promise<NotificationChannel[]> {
    const res = await request.get(CHANNELS, { headers: authedHeaders(token), timeout: TIMEOUT });
    expect(res.status()).toBe(200);
    return (await res.json()).channels as NotificationChannel[];
}

async function subscribe(
    request: APIRequestContext,
    token: string,
    key: string,
    channelIds: string[],
) {
    return request.put(EVENT(key), {
        headers: authedHeaders(token),
        data: { channelIds },
        timeout: TIMEOUT,
    });
}

async function getPrefs(request: APIRequestContext, token: string): Promise<PreferencesView> {
    const res = await request.get(PREFS, { headers: authedHeaders(token), timeout: TIMEOUT });
    expect(res.status(), `prefs body=${await res.text().catch(() => '')}`).toBe(200);
    return (await res.json()) as PreferencesView;
}

function subFor(view: PreferencesView, key: string): Subscription | undefined {
    return view.subscriptions.find((s) => s.eventTypeKey === key);
}

/** N unique, well-formed UUID-shaped strings (8-4-4-4-12) that own no channel. */
function bogusUuids(n: number): string[] {
    return Array.from(
        { length: n },
        (_, i) => `${i.toString(16).padStart(8, '0')}-0000-0000-0000-000000000000`,
    );
}

test.describe('Notification channels × events × subscriptions — multi-step integration', () => {
    test('END-TO-END journey: create channels → subscribe distinct events → quiet-hours → mute → disable → delete → verify aggregate state at each step', async ({
        request,
    }) => {
        const { token } = await freshUser(request);

        // Baseline: a brand-new user owns the empty triple and zero channels.
        expect(await listChannels(request, token)).toHaveLength(0);
        const base = await getPrefs(request, token);
        expect(base).toMatchObject({ subscriptions: [], preference: null, mutes: [] });

        // Step 1 — provision three channels across three providers.
        const slack = await createChannel(request, token, 'slack', {
            webhookUrl: 'https://hooks.slack.com/services/T/B/x',
        });
        const discord = await createChannel(request, token, 'discord', {
            webhookUrl: 'https://discord.com/api/webhooks/1/a',
        });
        const telegram = await createChannel(request, token, 'telegram', {
            botToken: 'x:y',
            chatId: '1',
        });
        const chanIds = [slack.id, discord.id, telegram.id];
        expect(new Set(chanIds).size, 'three distinct channel ids').toBe(3);
        expect((await listChannels(request, token)).map((c) => c.id).sort()).toEqual(
            [...chanIds].sort(),
        );

        // Step 2 — route three DISTINCT events to three DISTINCT channel sets.
        expect(
            (await subscribe(request, token, 'agent_run_finished', ['in-app', slack.id])).status(),
        ).toBe(200);
        expect((await subscribe(request, token, 'generation_error', [discord.id])).status()).toBe(
            200,
        );
        expect(
            (await subscribe(request, token, 'git_auth_expired', ['in-app', telegram.id])).status(),
        ).toBe(200);

        // Step 3 — set quiet hours + mute a category (all in the SAME preference view).
        expect(
            (
                await request.put(`${PREFS}/quiet-hours`, {
                    headers: authedHeaders(token),
                    data: { quietHoursStart: '22:00', quietHoursEnd: '07:30', timezone: 'UTC' },
                    timeout: TIMEOUT,
                })
            ).status(),
        ).toBe(200);
        expect(
            (
                await request.post(`${PREFS}/mute`, {
                    headers: authedHeaders(token),
                    data: { category: 'generation' },
                    timeout: TIMEOUT,
                })
            ).status(),
        ).toBe(201);

        // Assert the FULL aggregate state in one read.
        const full = await getPrefs(request, token);
        expect(full.subscriptions.map((s) => s.eventTypeKey).sort()).toEqual(
            ['agent_run_finished', 'generation_error', 'git_auth_expired'].sort(),
        );
        expect(subFor(full, 'agent_run_finished')!.channelIds).toEqual(['in-app', slack.id]);
        expect(subFor(full, 'generation_error')!.channelIds).toEqual([discord.id]);
        expect(subFor(full, 'git_auth_expired')!.channelIds).toEqual(['in-app', telegram.id]);
        expect(full.preference).toMatchObject({
            quietHoursStart: '22:00',
            quietHoursEnd: '07:30',
            timezone: 'UTC',
        });
        expect(full.mutes.map((m) => m.category)).toContain('generation');

        // Step 4 — DISABLE the slack channel: it drops out of the channel LIST but
        // the agent_run_finished subscription that references it is UNCHANGED.
        expect(
            (
                await request.patch(`${CHANNELS}/${slack.id}`, {
                    headers: authedHeaders(token),
                    data: { disabled: true },
                    timeout: TIMEOUT,
                })
            ).status(),
        ).toBe(200);
        expect((await listChannels(request, token)).map((c) => c.id)).not.toContain(slack.id);
        const afterDisable = await getPrefs(request, token);
        expect(
            subFor(afterDisable, 'agent_run_finished')!.channelIds,
            'disable ≠ unsubscribe — the subscription keeps the id',
        ).toEqual(['in-app', slack.id]);

        // Step 5 — DELETE the discord channel: subscription keeps the DANGLING id.
        expect(
            (
                await request.delete(`${CHANNELS}/${discord.id}`, {
                    headers: authedHeaders(token),
                    timeout: TIMEOUT,
                })
            ).status(),
        ).toBe(204);
        const afterDelete = await getPrefs(request, token);
        expect(
            subFor(afterDelete, 'generation_error')!.channelIds,
            'delete leaves a dangling id in the subscription (no cascade)',
        ).toEqual([discord.id]);

        // Step 6 — silence one event with an empty channelIds write; the row stays.
        expect((await subscribe(request, token, 'git_auth_expired', [])).status()).toBe(200);
        const finalView = await getPrefs(request, token);
        expect(subFor(finalView, 'git_auth_expired')!.channelIds).toEqual([]);
        // The other two subscriptions + quiet-hours + mute are all still present.
        expect(finalView.subscriptions.map((s) => s.eventTypeKey).sort()).toEqual(
            ['agent_run_finished', 'generation_error', 'git_auth_expired'].sort(),
        );
        expect(finalView.preference!.quietHoursStart).toBe('22:00');
        expect(finalView.mutes.map((m) => m.category)).toContain('generation');
    });

    test('subscription UPSERT is REPLACE-in-place: re-PUT overwrites channelIds and keeps the SAME row id (one row per event)', async ({
        request,
    }) => {
        const { token } = await freshUser(request);
        const a = await createChannel(request, token, 'slack');
        const b = await createChannel(request, token, 'discord');

        const first = await subscribe(request, token, 'agent_run_finished', ['in-app', a.id, b.id]);
        expect(first.status()).toBe(200);
        const firstSub = (await first.json()).subscription as Subscription;
        expect(firstSub.channelIds).toEqual(['in-app', a.id, b.id]);

        // Re-subscribe the SAME event to a NARROWER set — REPLACE, not append.
        const second = await subscribe(request, token, 'agent_run_finished', [b.id]);
        expect(second.status()).toBe(200);
        const secondSub = (await second.json()).subscription as Subscription;
        expect(secondSub.id, 'upsert keeps the same subscription row id').toBe(firstSub.id);
        expect(secondSub.channelIds, 'channelIds are replaced wholesale').toEqual([b.id]);
        expect(
            new Date(secondSub.updatedAt).getTime(),
            'updatedAt advances on re-write',
        ).toBeGreaterThanOrEqual(new Date(firstSub.updatedAt).getTime());

        // Exactly ONE row exists for this event in the read.
        const view = await getPrefs(request, token);
        expect(
            view.subscriptions.filter((s) => s.eventTypeKey === 'agent_run_finished'),
        ).toHaveLength(1);
        expect(subFor(view, 'agent_run_finished')!.channelIds).toEqual([b.id]);
    });

    test('channelIds are DEDUPED preserving first-seen order ([...new Set])', async ({
        request,
    }) => {
        const { token } = await freshUser(request);
        const a = await createChannel(request, token, 'slack');

        const res = await subscribe(request, token, 'generation_error', [
            'in-app',
            'in-app',
            a.id,
            a.id,
            'in-app',
        ]);
        expect(res.status()).toBe(200);
        // Duplicates collapse; the first occurrence position is retained.
        expect((await res.json()).subscription.channelIds).toEqual(['in-app', a.id]);

        // Round-trips through the read identically.
        expect(subFor(await getPrefs(request, token), 'generation_error')!.channelIds).toEqual([
            'in-app',
            a.id,
        ]);
    });

    test('empty channelIds [] is a valid "silence event" write (200, []) — distinct from removing the row', async ({
        request,
    }) => {
        const { token } = await freshUser(request);
        const a = await createChannel(request, token, 'slack');

        // Establish a real routing, then silence it with [].
        expect(
            (await subscribe(request, token, 'mission_blocked', ['in-app', a.id])).status(),
        ).toBe(200);
        const silenced = await subscribe(request, token, 'mission_blocked', []);
        expect(silenced.status()).toBe(200);
        expect((await silenced.json()).subscription.channelIds).toEqual([]);

        // The subscription ROW persists (empty), it is not deleted.
        const view = await getPrefs(request, token);
        expect(view.subscriptions.map((s) => s.eventTypeKey)).toContain('mission_blocked');
        expect(subFor(view, 'mission_blocked')!.channelIds).toEqual([]);
    });

    test('MAX 20 channels: 21 unique ids → "Too many" (length gate first); 20 unknown ids → ownership 400 (boundary message divergence)', async ({
        request,
    }) => {
        const { token } = await freshUser(request);

        // 21 unique ids trips the length cap BEFORE any ownership query runs — so
        // even though these are all unknown ids, the message is the count message.
        const over = await subscribe(request, token, 'schedule_paused', bogusUuids(21));
        expect(over.status()).toBe(400);
        expect((await over.json()).message).toBe(
            'Too many notification channels: maximum 20 allowed per subscription.',
        );

        // EXACTLY 20 unknown ids passes the length gate (20 is not > 20) and then
        // fails on the FIRST ownership check — a different, per-id message.
        const atCap = await subscribe(request, token, 'schedule_paused', bogusUuids(20));
        expect(atCap.status()).toBe(400);
        expect((await atCap.json()).message).toContain(
            'Unknown or unauthorized notification channel',
        );

        // Neither rejected write persisted a subscription row.
        expect(subFor(await getPrefs(request, token), 'schedule_paused')).toBeUndefined();
    });

    test('built-in "in-app" is ownership-EXEMPT: a fresh user with ZERO channels subscribes ["in-app"] (200)', async ({
        request,
    }) => {
        const { token } = await freshUser(request);
        expect(await listChannels(request, token), 'no owned channels').toHaveLength(0);

        const res = await subscribe(request, token, 'agent_run_finished', ['in-app']);
        expect(res.status(), `body=${await res.text().catch(() => '')}`).toBe(200);
        expect((await res.json()).subscription.channelIds).toEqual(['in-app']);

        // Mixing the built-in with a NOW-owned channel keeps both, in order.
        const owned = await createChannel(request, token, 'telegram');
        const mixed = await subscribe(request, token, 'agent_run_finished', ['in-app', owned.id]);
        expect(mixed.status()).toBe(200);
        expect((await mixed.json()).subscription.channelIds).toEqual(['in-app', owned.id]);
    });

    test('DISABLED-channel divergence: disabled channel is absent from the list yet still SUBSCRIBABLE (findByIdForUser ignores disabledAt)', async ({
        request,
    }) => {
        const { token } = await freshUser(request);
        const ch = await createChannel(request, token, 'slack');

        // Subscribe BEFORE disabling.
        expect(
            (await subscribe(request, token, 'work_generation_finished', [ch.id])).status(),
        ).toBe(200);

        // Disable → it disappears from the active list.
        expect(
            (
                await request.patch(`${CHANNELS}/${ch.id}`, {
                    headers: authedHeaders(token),
                    data: { disabled: true },
                    timeout: TIMEOUT,
                })
            ).status(),
        ).toBe(200);
        expect((await listChannels(request, token)).map((c) => c.id)).not.toContain(ch.id);

        // The pre-existing subscription still references it.
        expect(
            subFor(await getPrefs(request, token), 'work_generation_finished')!.channelIds,
        ).toEqual([ch.id]);

        // And a FRESH subscription to the disabled channel STILL succeeds — the
        // ownership gate (findByIdForUser) does not filter disabledAt, unlike the
        // active list (findActiveByUser). This divergence is the contract.
        const again = await subscribe(request, token, 'ai_provider_error', [ch.id]);
        expect(
            again.status(),
            `subscribe-disabled body=${await again.text().catch(() => '')}`,
        ).toBe(200);
        expect((await again.json()).subscription.channelIds).toEqual([ch.id]);
    });

    test('DANGLING reference: deleting a subscribed channel keeps the dead id in the subscription but blocks re-subscribing it', async ({
        request,
    }) => {
        const { token } = await freshUser(request);
        const ch = await createChannel(request, token, 'slack');

        expect((await subscribe(request, token, 'agent_run_finished', [ch.id])).status()).toBe(200);
        expect(
            (
                await request.delete(`${CHANNELS}/${ch.id}`, {
                    headers: authedHeaders(token),
                    timeout: TIMEOUT,
                })
            ).status(),
        ).toBe(204);

        // The existing subscription still carries the now-dead id (no cascade).
        expect(subFor(await getPrefs(request, token), 'agent_run_finished')!.channelIds).toEqual([
            ch.id,
        ]);

        // But re-subscribing ANOTHER event to that deleted id is a truthful 400 —
        // the ownership check no longer finds the row.
        const reuse = await subscribe(request, token, 'generation_error', [ch.id]);
        expect(reuse.status()).toBe(400);
        expect((await reuse.json()).message).toBe(
            `Unknown or unauthorized notification channel: ${ch.id}`,
        );
        expect(subFor(await getPrefs(request, token), 'generation_error')).toBeUndefined();
    });

    test('cross-user IDOR: Alice cannot route an event to Bob’s REAL channel id (400), and the write is ATOMIC when mixed with her own valid ids', async ({
        request,
    }) => {
        const alice = await freshUser(request);
        const bob = await freshUser(request);

        const bobCh = await createChannel(request, bob.token, 'telegram');
        const aliceCh = await createChannel(request, alice.token, 'slack');

        // Bob's real channel id is rejected for Alice — send-time scoping already
        // blocks delivery, but storing a foreign id is also refused up front.
        const idor = await subscribe(request, alice.token, 'agent_run_finished', [bobCh.id]);
        expect(idor.status()).toBe(400);
        expect((await idor.json()).message).toBe(
            `Unknown or unauthorized notification channel: ${bobCh.id}`,
        );

        // Mixed [in-app, aliceCh(valid), bobCh(foreign)] — the WHOLE write is
        // rejected atomically: no generation_error subscription is created for
        // Alice despite two of the three ids being valid.
        const mixed = await subscribe(request, alice.token, 'generation_error', [
            'in-app',
            aliceCh.id,
            bobCh.id,
        ]);
        expect(mixed.status()).toBe(400);
        expect(subFor(await getPrefs(request, alice.token), 'generation_error')).toBeUndefined();

        // Sanity: the SAME request without the foreign id succeeds for Alice.
        const clean = await subscribe(request, alice.token, 'generation_error', [
            'in-app',
            aliceCh.id,
        ]);
        expect(clean.status()).toBe(200);
        expect((await clean.json()).subscription.channelIds).toEqual(['in-app', aliceCh.id]);
    });

    test('per-event INDEPENDENCE: distinct events are distinct rows; overwriting one never disturbs another', async ({
        request,
    }) => {
        const { token } = await freshUser(request);
        const a = await createChannel(request, token, 'slack');
        const b = await createChannel(request, token, 'discord');

        expect((await subscribe(request, token, 'agent_run_finished', [a.id])).status()).toBe(200);
        expect((await subscribe(request, token, 'generation_error', [b.id])).status()).toBe(200);

        // Overwrite ONLY agent_run_finished.
        expect((await subscribe(request, token, 'agent_run_finished', ['in-app'])).status()).toBe(
            200,
        );

        const view = await getPrefs(request, token);
        expect(subFor(view, 'agent_run_finished')!.channelIds).toEqual(['in-app']);
        // generation_error is completely untouched by the sibling overwrite.
        expect(subFor(view, 'generation_error')!.channelIds).toEqual([b.id]);
        expect(view.subscriptions).toHaveLength(2);
    });

    test('channel RENAME is id-stable: renaming a subscribed channel does not alter the subscription’s channelIds', async ({
        request,
    }) => {
        const { token } = await freshUser(request);
        const ch = await createChannel(request, token, 'slack', {
            webhookUrl: 'https://hooks.slack.com/services/T/B/x',
        });

        expect(
            (await subscribe(request, token, 'mission_blocked', ['in-app', ch.id])).status(),
        ).toBe(200);

        // Rename the channel — the subscription references it by ID, so its
        // channelIds are unaffected.
        const newName = uniq('Renamed');
        const renamed = await request.patch(`${CHANNELS}/${ch.id}`, {
            headers: authedHeaders(token),
            data: { name: newName },
            timeout: TIMEOUT,
        });
        expect(renamed.status()).toBe(200);
        expect((await renamed.json()).channel.name).toBe(newName);

        expect(subFor(await getPrefs(request, token), 'mission_blocked')!.channelIds).toEqual([
            'in-app',
            ch.id,
        ]);
    });

    test('event-types is a GET-only immutable registry; a subscription OVERRIDES an event’s defaultChannels without mutating the catalogue', async ({
        request,
    }) => {
        const { token } = await freshUser(request);

        // The catalogue read carries a defaultChannels of ['in-app'] for core events.
        const catRes = await request.get(`${API_BASE}/api/notifications/event-types`, {
            headers: authedHeaders(token),
            timeout: TIMEOUT,
        });
        expect(catRes.status()).toBe(200);
        const catalogue = (await catRes.json()).eventTypes as Array<{
            key: string;
            defaultChannels: string[];
            source: string;
            pluginId: string | null;
        }>;
        const before = catalogue.find((e) => e.key === 'agent_run_finished')!;
        expect(before.defaultChannels).toContain('in-app');
        expect(before.source).toBe('core');
        expect(before.pluginId).toBeNull();

        // The catalogue is READ-ONLY: there is no POST route.
        const post = await request.post(`${API_BASE}/api/notifications/event-types`, {
            headers: authedHeaders(token),
            data: { key: 'x' },
            timeout: TIMEOUT,
        });
        expect(post.status(), 'no create route on the catalogue').toBe(404);

        // A user subscription that routes the event to a DIFFERENT channel set does
        // NOT rewrite the catalogue's defaultChannels — the two are separate rows.
        const owned = await createChannel(request, token, 'discord');
        expect((await subscribe(request, token, 'agent_run_finished', [owned.id])).status()).toBe(
            200,
        );

        const catRes2 = await request.get(`${API_BASE}/api/notifications/event-types`, {
            headers: authedHeaders(token),
            timeout: TIMEOUT,
        });
        const after = ((await catRes2.json()).eventTypes as typeof catalogue).find(
            (e) => e.key === 'agent_run_finished',
        )!;
        expect(after.defaultChannels, 'catalogue defaultChannels is immutable').toEqual(
            before.defaultChannels,
        );
        // Yet the per-user subscription reflects the override.
        expect(subFor(await getPrefs(request, token), 'agent_run_finished')!.channelIds).toEqual([
            owned.id,
        ]);
    });

    test('test-send threads with a subscription: create → subscribe → test-send leaves the subscription intact (truthful CI failure)', async ({
        request,
    }) => {
        const { token } = await freshUser(request);
        const ch = await createChannel(request, token, 'slack', {
            webhookUrl: 'https://hooks.slack.com/services/T/B/x',
        });

        expect(
            (await subscribe(request, token, 'git_auth_expired', ['in-app', ch.id])).status(),
        ).toBe(200);

        // Test-send returns the send result DIRECTLY (201). CI enables no channel
        // plugin → truthful 'failed'; a positive status is tolerated.
        const testRes = await request.post(`${CHANNELS}/${ch.id}/test`, {
            headers: authedHeaders(token),
            timeout: TIMEOUT,
        });
        expect(testRes.status()).toBe(201);
        const body = await testRes.json();
        expect(typeof body.status).toBe('string');
        if (body.status === 'failed') {
            expect(typeof body.error).toBe('string');
            expect(String(body.error).toLowerCase()).toMatch(
                /plugin|disabled|not found|materialize/,
            );
        } else {
            expect(['delivered', 'queued', 'sent', 'accepted']).toContain(body.status);
        }

        // The subscription is unaffected by the test-send.
        expect(subFor(await getPrefs(request, token), 'git_auth_expired')!.channelIds).toEqual([
            'in-app',
            ch.id,
        ]);
    });

    test('fan-out: every core event can be subscribed to ["in-app"] in one pass → 8 independent rows, then one is silenced', async ({
        request,
    }) => {
        const { token } = await freshUser(request);

        for (const key of CORE_EVENTS) {
            const res = await subscribe(request, token, key, ['in-app']);
            expect(res.status(), `subscribe ${key}`).toBe(200);
            expect((await res.json()).subscription.eventTypeKey).toBe(key);
        }

        const view = await getPrefs(request, token);
        const keys = view.subscriptions.map((s) => s.eventTypeKey);
        for (const key of CORE_EVENTS) expect(keys, `row for ${key}`).toContain(key);
        // Each event has exactly one row and every row is routed to in-app.
        expect(view.subscriptions).toHaveLength(CORE_EVENTS.length);
        for (const s of view.subscriptions) expect(s.channelIds).toEqual(['in-app']);

        // Silence just one — the other seven are untouched.
        expect((await subscribe(request, token, 'ai_credits_depleted', [])).status()).toBe(200);
        const after = await getPrefs(request, token);
        expect(subFor(after, 'ai_credits_depleted')!.channelIds).toEqual([]);
        expect(
            after.subscriptions
                .filter((s) => s.eventTypeKey !== 'ai_credits_depleted')
                .every((s) => s.channelIds.includes('in-app')),
            'the other seven rows still route to in-app',
        ).toBe(true);
    });

    test('unregistered event key is rejected and NOT persisted, while a valid neighbour in the same request-batch persists', async ({
        request,
    }) => {
        const { token } = await freshUser(request);

        // A valid event persists.
        expect((await subscribe(request, token, 'agent_run_finished', ['in-app'])).status()).toBe(
            200,
        );

        // An unregistered key is a truthful 400 and creates no row.
        const bad = await subscribe(request, token, 'totally_unknown_event_zzz', ['in-app']);
        expect(bad.status()).toBe(400);
        expect((await bad.json()).message).toContain('Unknown notification event type');

        // task_assigned is a DIRECT-create producer, not in the fanout registry — a
        // subscribe attempt is likewise rejected.
        const taskAssigned = await subscribe(request, token, 'task_assigned', ['in-app']);
        expect(taskAssigned.status()).toBe(400);
        expect((await taskAssigned.json()).message).toContain('Unknown notification event type');

        // Only the valid event survived; the two bad keys left no rows.
        const view = await getPrefs(request, token);
        expect(view.subscriptions.map((s) => s.eventTypeKey)).toEqual(['agent_run_finished']);
    });

    test('combined preferences triple is cross-contamination-free: subscriptions, quiet-hours, and mutes are independent slices of one view', async ({
        request,
    }) => {
        const { token } = await freshUser(request);
        const ch = await createChannel(request, token, 'slack');

        // Populate all three slices.
        expect(
            (await subscribe(request, token, 'agent_run_finished', ['in-app', ch.id])).status(),
        ).toBe(200);
        expect(
            (
                await request.put(`${PREFS}/quiet-hours`, {
                    headers: authedHeaders(token),
                    data: {
                        quietHoursStart: '01:15',
                        quietHoursEnd: '05:45',
                        timezone: 'America/New_York',
                    },
                    timeout: TIMEOUT,
                })
            ).status(),
        ).toBe(200);
        expect(
            (
                await request.post(`${PREFS}/mute`, {
                    headers: authedHeaders(token),
                    data: { category: 'security' },
                    timeout: TIMEOUT,
                })
            ).status(),
        ).toBe(201);

        const view = await getPrefs(request, token);
        expect(subFor(view, 'agent_run_finished')!.channelIds).toEqual(['in-app', ch.id]);
        expect(view.preference).toMatchObject({
            quietHoursStart: '01:15',
            quietHoursEnd: '05:45',
            timezone: 'America/New_York',
        });
        expect(view.mutes.map((m) => m.category)).toContain('security');

        // Unmuting the category touches ONLY the mutes slice.
        expect(
            (
                await request.delete(`${PREFS}/mute/security`, {
                    headers: authedHeaders(token),
                    timeout: TIMEOUT,
                })
            ).status(),
        ).toBe(204);
        const afterUnmute = await getPrefs(request, token);
        expect(afterUnmute.mutes.map((m) => m.category)).not.toContain('security');
        // Subscription + quiet-hours are unchanged by the unmute.
        expect(subFor(afterUnmute, 'agent_run_finished')!.channelIds).toEqual(['in-app', ch.id]);
        expect(afterUnmute.preference!.quietHoursStart).toBe('01:15');
    });

    test('the event-subscription PUT route is auth-gated: an anonymous caller is 401 before validation', async ({
        browser,
    }) => {
        // Empty storageState so the shared seeded auth cookie is NOT inherited.
        const anonCtx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
        const anon = anonCtx.request;
        try {
            // Even a WELL-FORMED body is 401 — the guard short-circuits before the
            // service, so anon never learns whether the payload was valid.
            const wellFormed = await anon.put(EVENT('agent_run_finished'), {
                data: { channelIds: ['in-app'] },
                timeout: TIMEOUT,
            });
            expect(wellFormed.status(), 'anon well-formed subscribe').toBe(401);

            // A payload with a foreign channel id is ALSO 401 (not 400): auth wins.
            const foreign = await anon.put(EVENT('agent_run_finished'), {
                data: { channelIds: ['00000000-0000-0000-0000-000000000000'] },
                timeout: TIMEOUT,
            });
            expect(foreign.status(), 'anon foreign-id subscribe').toBe(401);

            // The preferences read is equally gated.
            expect((await anon.get(PREFS, { timeout: TIMEOUT })).status()).toBe(401);
        } finally {
            await anonCtx.close();
        }
    });
});
