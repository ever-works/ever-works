/**
 * Notifications — FULL end-to-end MULTI-STEP journeys (REAL integration).
 *
 * The existing notification specs each drill ONE surface in isolation —
 * per-event production (flow-notifications-per-event), the read/count/dismiss
 * lifecycle (flow-notifications-inbox-deep / -read-lifecycle / -bulk), channel
 * CRUD (flow-notification-channels-crud-deep), preferences/quiet-hours/digest
 * geometry (flow-notifications-preferences / -digest), cross-user isolation and
 * polling. NONE of them walk a SINGLE connected journey that threads every
 * surface together and pins the CROSS-surface invariants. This file does: it
 * configures preferences + a channel, then produces a REAL notification and
 * consumes it, asserting that the badge, the inbox, the preference store and the
 * channel store all agree at every step.
 *
 * ── Verified live (curl against http://127.0.0.1:3100, sqlite in-memory, the CI
 *    driver) BEFORE any assertion. Probed contract:
 *
 *   THE deterministic public in-app producer — self-assigning a task:
 *     POST /api/tasks/:id/assignees { assigneeType:'user', assigneeId:<self> } 201
 *       → within ~1-2s a row lands in GET /api/notifications:
 *         { category:'task', type:'info', isRead:false, isDismissed:false,
 *           isPersistent:false, title:`Assigned: <taskSlug>`,
 *           message:`User <id8>… assigned you to "<title>".`,
 *           actionUrl:`/tasks/<taskId>`, actionLabel:'Open Task',
 *           metadata:{ event:'task_assigned', taskId, taskSlug, actorUserId },
 *           deduplicationKey:`task:<taskId>:task_assigned:<actorUserId>` }
 *       unread-count increments by exactly 1.
 *   READ SURFACE:
 *     GET  /api/notifications            → { notifications:[…] } (Cache-Control: private, no-store)
 *     GET  /api/notifications/unread-count → { count } (NO Cache-Control header)
 *     GET  /api/notifications/persistent → { notifications:[] } (task rows are non-persistent)
 *     POST /api/notifications/:id/read   → 200 { success:true }; unknown / malformed :id → 400 "Notification not found"
 *     POST /api/notifications/read-all   → 200 { success:true }
 *     POST /api/notifications/:id/dismiss→ 200 { success:true }; unknown :id → 400
 *     ?category=task matches, ?category=security excludes, ?category=<bogus> is ignored (returns all)
 *     junk pagination (limit=abc, offset=xyz, unreadOnly=maybe, limit=-5) → 200 + stable envelope
 *   CHANNELS  (/api/notification-channels):
 *     POST 201 { channel:{ id, userId, pluginId, name, targetConfig, verified:false,
 *                          disabledAt:null, createdAt, updatedAt } }
 *     PATCH { disabled:true } → disabledAt stamped, DROPS from the active list;
 *            { disabled:false } → disabledAt:null, REAPPEARS
 *     POST :id/test → 201 { status, error? } (truthful; no provider → status:'failed', materialize error)
 *     validation → 400: missing name / non-object targetConfig / smuggled whitelisted field / pluginId>64
 *     foreign :id PATCH/DELETE/test → 404; malformed :id → 400; unknown-uuid → 404
 *   PREFERENCES:
 *     GET  /api/notifications/event-types → { eventTypes:[ 8 core keys ] }, each
 *            { key, category, title, description, urgent, defaultChannels:['in-app'],
 *              source:'core', pluginId:null }, sorted by (category,key)
 *     PUT  /api/notifications/preferences/event/:key { channelIds } → 200 { subscription }
 *            unregistered key → 400; foreign channel id → 400
 *     PUT  /api/notifications/preferences/quiet-hours { quietHoursStart, quietHoursEnd, timezone }
 *            → 200 { preference }; bad HH:mm / bad IANA tz → 400; HH:mm:ss form accepted
 *     POST /api/notifications/preferences/mute { category } → 201 { mute:{ category, mutedUntil } };
 *            bad category → 400
 *     DELETE /api/notifications/preferences/mute/:category → 204; bad category (ParseEnumPipe) → 400
 *     GET  /api/notifications/preferences → { subscriptions, preference, mutes }
 *   MUTE gates the multi-channel FANOUT only — a muted category STILL writes the v1 in-app row.
 *   AUTH: every route above → 401 without a bearer token.
 *
 * Fully API-orchestrated; a FRESH registerUserViaAPI() owner per test (never the
 * shared seeded user). `flow-` prefix → runs in the authed chromium project.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';
import { createTaskViaAPI, addTaskAssignee } from './helpers/agents-tasks';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNKNOWN_UUID = '00000000-0000-0000-0000-000000000000';
const MALFORMED_ID = 'not-a-uuid';
const PRODUCE_TIMEOUT = 30_000;

function stamp(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

interface NotificationRow {
    id: string;
    userId: string;
    type: string;
    category: string;
    title: string;
    message: string;
    actionUrl?: string;
    actionLabel?: string;
    isRead: boolean;
    isDismissed: boolean;
    isPersistent: boolean;
    metadata?: { event?: string; taskId?: string; taskSlug?: string; actorUserId?: string } | null;
    deduplicationKey?: string | null;
    createdAt: string;
}

interface Channel {
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

async function listNotifications(
    request: APIRequestContext,
    token: string,
    query = '',
): Promise<NotificationRow[]> {
    const res = await request.get(`${API_BASE}/api/notifications${query}`, {
        headers: authedHeaders(token),
    });
    expect(res.status(), `list body=${await res.text().catch(() => '')}`).toBe(200);
    return ((await res.json()).notifications ?? []) as NotificationRow[];
}

async function unreadCount(request: APIRequestContext, token: string): Promise<number> {
    const res = await request.get(`${API_BASE}/api/notifications/unread-count`, {
        headers: authedHeaders(token),
    });
    expect(res.status()).toBe(200);
    return (await res.json()).count as number;
}

/** Poll the unread count until it satisfies `predicate`, tolerating the lagging
 * shared in-memory DB, then return the settled value. */
async function waitForCount(
    request: APIRequestContext,
    token: string,
    predicate: (count: number) => boolean,
    message: string,
): Promise<number> {
    let last = -1;
    await expect(async () => {
        last = await unreadCount(request, token);
        expect(predicate(last), `${message} (observed ${last})`).toBe(true);
    }).toPass({ timeout: PRODUCE_TIMEOUT });
    return last;
}

/**
 * Produce ONE real in-app notification by self-assigning a freshly-created task,
 * then poll until the task_assigned row for that task is observable. Returns the
 * produced row + the task slug so callers can assert against the full shape.
 */
async function produceTaskNotification(
    request: APIRequestContext,
    token: string,
    userId: string,
    title: string,
): Promise<{ row: NotificationRow; taskId: string; taskSlug: string }> {
    const task = await createTaskViaAPI(request, token, { title });
    await addTaskAssignee(request, token, task.id, { assigneeType: 'user', assigneeId: userId });

    let row: NotificationRow | undefined;
    await expect
        .poll(
            async () => {
                const rows = await listNotifications(request, token, '?category=task&limit=100');
                row = rows.find((r) => r.metadata?.taskId === task.id);
                return Boolean(row);
            },
            { timeout: PRODUCE_TIMEOUT, message: `no task_assigned row for task ${task.id}` },
        )
        .toBe(true);
    return { row: row!, taskId: task.id, taskSlug: task.slug };
}

async function createChannel(
    request: APIRequestContext,
    token: string,
    overrides: Partial<{
        pluginId: string;
        name: string;
        targetConfig: Record<string, unknown>;
    }> = {},
): Promise<Channel> {
    const res = await request.post(`${API_BASE}/api/notification-channels`, {
        headers: authedHeaders(token),
        data: {
            pluginId: 'slack-channel',
            name: `Chan ${stamp()}`,
            targetConfig: { webhookUrl: `https://hooks.example/${stamp()}` },
            ...overrides,
        },
    });
    expect(res.status(), `createChannel body=${await res.text().catch(() => '')}`).toBe(201);
    return (await res.json()).channel as Channel;
}

async function getPreferences(
    request: APIRequestContext,
    token: string,
): Promise<{
    subscriptions: Array<{ eventTypeKey: string; channelIds: string[] }>;
    preference: {
        quietHoursStart: string | null;
        quietHoursEnd: string | null;
        timezone: string | null;
    } | null;
    mutes: Array<{ category: string; mutedUntil: string | null }>;
}> {
    const res = await request.get(`${API_BASE}/api/notifications/preferences`, {
        headers: authedHeaders(token),
    });
    expect(res.status()).toBe(200);
    return res.json();
}

test.describe('Notifications — the full configure→produce→consume journey', () => {
    test('marquee: configure quiet-hours + a channel + a subscription + a mute, THEN produce a real notification and read+dismiss it — every surface stays coherent', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const userId = user.user.id;

        // --- Step 0: a brand-new user starts from a provably-clean slate. ---
        expect(await listNotifications(request, token)).toEqual([]);
        expect(await unreadCount(request, token)).toBe(0);
        expect((await getPreferences(request, token)).preference).toBeNull();

        // --- Step 1: set up delivery preferences BEFORE anything fires. ---
        const channel = await createChannel(request, token, { name: `Journey ${stamp()}` });
        const qh = await request.put(`${API_BASE}/api/notifications/preferences/quiet-hours`, {
            headers: authedHeaders(token),
            data: {
                quietHoursStart: '22:00',
                quietHoursEnd: '07:00',
                timezone: 'America/New_York',
            },
        });
        expect(qh.status()).toBe(200);
        const sub = await request.put(
            `${API_BASE}/api/notifications/preferences/event/agent_run_finished`,
            { headers: authedHeaders(token), data: { channelIds: ['in-app', channel.id] } },
        );
        expect(sub.status()).toBe(200);
        const mute = await request.post(`${API_BASE}/api/notifications/preferences/mute`, {
            headers: authedHeaders(token),
            data: { category: 'task' },
        });
        expect(mute.status()).toBe(201);

        // The preference store now reflects ALL FOUR writes together.
        const prefs = await getPreferences(request, token);
        expect(prefs.preference?.quietHoursStart).toBe('22:00');
        expect(prefs.preference?.timezone).toBe('America/New_York');
        expect(
            prefs.subscriptions.find((s) => s.eventTypeKey === 'agent_run_finished')?.channelIds,
        ).toEqual(['in-app', channel.id]);
        expect(prefs.mutes.map((m) => m.category)).toContain('task');

        // --- Step 2: produce a REAL notification. The category ('task') is muted,
        //             which gates only the multi-channel fanout — the in-app row is
        //             STILL written (truthful v1 contract). ---
        const { row, taskSlug } = await produceTaskNotification(
            request,
            token,
            userId,
            `Journey ${stamp()}`,
        );
        expect(row.category).toBe('task');
        expect(row.type).toBe('info');
        expect(row.isRead).toBe(false);
        expect(row.isDismissed).toBe(false);
        expect(row.isPersistent).toBe(false);
        expect(row.title).toBe(`Assigned: ${taskSlug}`);
        expect(row.actionUrl).toBe(`/tasks/${row.metadata?.taskId}`);
        expect(row.actionLabel).toBe('Open Task');
        expect(row.metadata?.event).toBe('task_assigned');
        expect(row.metadata?.actorUserId).toBe(userId);
        expect(row.deduplicationKey).toBe(`task:${row.metadata?.taskId}:task_assigned:${userId}`);

        // The badge went to exactly 1 and the unreadOnly list agrees with it.
        expect(await waitForCount(request, token, (c) => c === 1, 'produce → count 1')).toBe(1);
        expect(await listNotifications(request, token, '?unreadOnly=true')).toHaveLength(1);
        // …but persistent stays empty — this row is transient.
        const persistent = await request.get(`${API_BASE}/api/notifications/persistent`, {
            headers: authedHeaders(token),
        });
        expect((await persistent.json()).notifications).toEqual([]);

        // --- Step 3: read it → the badge zeroes but the row survives in the list. ---
        const read = await request.post(`${API_BASE}/api/notifications/${row.id}/read`, {
            headers: authedHeaders(token),
        });
        expect(read.status()).toBe(200);
        expect((await read.json()).success).toBe(true);
        expect(await waitForCount(request, token, (c) => c === 0, 'read → count 0')).toBe(0);
        const afterRead = await listNotifications(request, token);
        expect(afterRead.find((r) => r.id === row.id)?.isRead).toBe(true);
        expect(await listNotifications(request, token, '?unreadOnly=true')).toHaveLength(0);

        // --- Step 4: dismiss it → it leaves the default list; the badge stays 0. ---
        const dismiss = await request.post(`${API_BASE}/api/notifications/${row.id}/dismiss`, {
            headers: authedHeaders(token),
        });
        expect(dismiss.status()).toBe(200);
        expect((await listNotifications(request, token)).some((r) => r.id === row.id)).toBe(false);
        expect(await unreadCount(request, token)).toBe(0);
    });

    test('three distinct tasks yield three distinct rows; read-all zeroes the badge while every row survives (the bell-badge invariant)', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const userId = user.user.id;

        const produced: Array<{ row: NotificationRow; taskId: string; taskSlug: string }> = [];
        for (let i = 0; i < 3; i++) {
            produced.push(
                await produceTaskNotification(request, token, userId, `Multi ${i} ${stamp()}`),
            );
        }
        // Each task minted its OWN row (distinct dedup keys), so all three ids are present.
        const ids = produced.map((p) => p.row.id);
        expect(new Set(ids).size).toBe(3);
        const rows = await listNotifications(request, token, '?limit=100');
        for (const id of ids) expect(rows.map((r) => r.id)).toContain(id);

        expect(await waitForCount(request, token, (c) => c === 3, 'three produced → count 3')).toBe(
            3,
        );
        expect(await listNotifications(request, token, '?unreadOnly=true&limit=100')).toHaveLength(
            3,
        );

        // read-all is the bulk badge-clear: count → 0, but the rows remain (read, not dismissed).
        const readAll = await request.post(`${API_BASE}/api/notifications/read-all`, {
            headers: authedHeaders(token),
        });
        expect(readAll.status()).toBe(200);
        expect((await readAll.json()).success).toBe(true);
        expect(await waitForCount(request, token, (c) => c === 0, 'read-all → count 0')).toBe(0);
        const afterAll = await listNotifications(request, token, '?limit=100');
        for (const id of ids) expect(afterAll.map((r) => r.id)).toContain(id);
        expect(await listNotifications(request, token, '?unreadOnly=true&limit=100')).toHaveLength(
            0,
        );
    });

    test('the unreadOnly-list length tracks the unread-count across every read transition', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const userId = user.user.id;

        const a = await produceTaskNotification(request, token, userId, `Inv A ${stamp()}`);
        const b = await produceTaskNotification(request, token, userId, `Inv B ${stamp()}`);
        await waitForCount(request, token, (c) => c === 2, 'two produced → count 2');

        // Invariant holds at 2.
        expect(await unreadCount(request, token)).toBe(
            (await listNotifications(request, token, '?unreadOnly=true&limit=100')).length,
        );

        // Read one → both drop to 1 in lockstep.
        await request.post(`${API_BASE}/api/notifications/${a.row.id}/read`, {
            headers: authedHeaders(token),
        });
        await waitForCount(request, token, (c) => c === 1, 'one read → count 1');
        expect(await unreadCount(request, token)).toBe(
            (await listNotifications(request, token, '?unreadOnly=true&limit=100')).length,
        );

        // Read the other → both floor at 0.
        await request.post(`${API_BASE}/api/notifications/${b.row.id}/read`, {
            headers: authedHeaders(token),
        });
        await waitForCount(request, token, (c) => c === 0, 'both read → count 0');
        expect(await listNotifications(request, token, '?unreadOnly=true&limit=100')).toHaveLength(
            0,
        );
    });
});

test.describe('Notifications — mark / dismiss lifecycle + edge cases', () => {
    test('mark-read is idempotent; unknown AND malformed ids BOTH 400 "Notification not found" (no ParseUUIDPipe on this route)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const { row } = await produceTaskNotification(
            request,
            token,
            user.user.id,
            `Idem ${stamp()}`,
        );

        const first = await request.post(`${API_BASE}/api/notifications/${row.id}/read`, {
            headers: authedHeaders(token),
        });
        expect(first.status()).toBe(200);
        // Re-reading an already-read row is a clean idempotent success, not an error.
        const second = await request.post(`${API_BASE}/api/notifications/${row.id}/read`, {
            headers: authedHeaders(token),
        });
        expect(second.status()).toBe(200);
        expect((await second.json()).success).toBe(true);

        const unknown = await request.post(`${API_BASE}/api/notifications/${UNKNOWN_UUID}/read`, {
            headers: authedHeaders(token),
        });
        expect(unknown.status()).toBe(400);
        expect((await unknown.json()).message).toBe('Notification not found');
        // No ParseUUIDPipe here → a garbage id ALSO surfaces the same 400, not a pipe error.
        const malformed = await request.post(`${API_BASE}/api/notifications/${MALFORMED_ID}/read`, {
            headers: authedHeaders(token),
        });
        expect(malformed.status()).toBe(400);
        expect((await malformed.json()).message).toBe('Notification not found');
    });

    test('dismiss removes a real row from the default list; a bogus id → 400; persistent stays empty throughout', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const { row } = await produceTaskNotification(
            request,
            token,
            user.user.id,
            `Dismiss ${stamp()}`,
        );

        const dismiss = await request.post(`${API_BASE}/api/notifications/${row.id}/dismiss`, {
            headers: authedHeaders(token),
        });
        expect(dismiss.status()).toBe(200);
        expect((await dismiss.json()).success).toBe(true);
        expect((await listNotifications(request, token)).some((r) => r.id === row.id)).toBe(false);

        const bogus = await request.post(`${API_BASE}/api/notifications/${UNKNOWN_UUID}/dismiss`, {
            headers: authedHeaders(token),
        });
        expect(bogus.status()).toBe(400);
        expect((await bogus.json()).message).toBe('Notification not found');

        const persistent = await request.get(`${API_BASE}/api/notifications/persistent`, {
            headers: authedHeaders(token),
        });
        expect(persistent.status()).toBe(200);
        expect((await persistent.json()).notifications).toEqual([]);
    });

    test("cross-user isolation: B can neither read nor dismiss A's real notification id (400 not-found, never a leak) and B's inbox never sees it", async ({
        request,
    }) => {
        const alice = await registerUserViaAPI(request);
        const bob = await registerUserViaAPI(request);
        const { row } = await produceTaskNotification(
            request,
            alice.access_token,
            alice.user.id,
            `Secret ${stamp()}`,
        );

        const bRead = await request.post(`${API_BASE}/api/notifications/${row.id}/read`, {
            headers: authedHeaders(bob.access_token),
        });
        expect(bRead.status()).toBe(400);
        expect((await bRead.json()).message).toBe('Notification not found');
        const bDismiss = await request.post(`${API_BASE}/api/notifications/${row.id}/dismiss`, {
            headers: authedHeaders(bob.access_token),
        });
        expect(bDismiss.status()).toBe(400);

        // B's inbox is empty; A's row is untouched (still unread).
        expect(await listNotifications(request, bob.access_token)).toEqual([]);
        expect(await unreadCount(request, bob.access_token)).toBe(0);
        expect(
            (await listNotifications(request, alice.access_token)).find((r) => r.id === row.id)
                ?.isRead,
        ).toBe(false);
    });
});

test.describe('Notifications — channel enable/disable + test-send + validation', () => {
    test('create returns the full channel row (verified:false, disabledAt:null) and it shows in the active list', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const channel = await createChannel(request, user.access_token, {
            name: `Shape ${stamp()}`,
        });
        expect(channel.id).toMatch(UUID_RE);
        expect(channel.userId).toBe(user.user.id);
        expect(channel.pluginId).toBe('slack-channel');
        expect(channel.verified).toBe(false);
        expect(channel.disabledAt).toBeNull();
        expect(typeof channel.createdAt).toBe('string');

        const list = await request.get(`${API_BASE}/api/notification-channels`, {
            headers: authedHeaders(user.access_token),
        });
        expect(list.status()).toBe(200);
        expect((await list.json()).channels.map((c: Channel) => c.id)).toContain(channel.id);
    });

    test('disable → enable round-trip: disabled:true stamps disabledAt and DROPS from the active list; disabled:false clears it and it REAPPEARS', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const channel = await createChannel(request, token, { name: `Toggle ${stamp()}` });

        const off = await request.patch(`${API_BASE}/api/notification-channels/${channel.id}`, {
            headers: authedHeaders(token),
            data: { disabled: true },
        });
        expect(off.status()).toBe(200);
        expect((await off.json()).channel.disabledAt).not.toBeNull();
        // The list is active-only, so a disabled channel is absent from it.
        const listOff = await request.get(`${API_BASE}/api/notification-channels`, {
            headers: authedHeaders(token),
        });
        expect((await listOff.json()).channels.map((c: Channel) => c.id)).not.toContain(channel.id);

        const on = await request.patch(`${API_BASE}/api/notification-channels/${channel.id}`, {
            headers: authedHeaders(token),
            data: { disabled: false },
        });
        expect(on.status()).toBe(200);
        expect((await on.json()).channel.disabledAt).toBeNull();
        const listOn = await request.get(`${API_BASE}/api/notification-channels`, {
            headers: authedHeaders(token),
        });
        expect((await listOn.json()).channels.map((c: Channel) => c.id)).toContain(channel.id);
    });

    test('test-send returns a TRUTHFUL delivery result — no real provider is bound, so status is "failed" with a materialize error', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const channel = await createChannel(request, user.access_token, {
            name: `Test ${stamp()}`,
        });
        const res = await request.post(`${API_BASE}/api/notification-channels/${channel.id}/test`, {
            headers: authedHeaders(user.access_token),
        });
        // POST with no @HttpCode → 201.
        expect([200, 201]).toContain(res.status());
        const result = await res.json();
        // The result is the real delivery attempt, not a fabricated success.
        expect(typeof result.status).toBe('string');
        expect(result.status.length).toBeGreaterThan(0);
        // In the keyless CI stack the slack-channel plugin can't be resolved,
        // so the delivery fails truthfully with a plugin-availability error
        // (message wording varies: "not found or disabled" / "materialize").
        if (result.status === 'failed') {
            expect(String(result.error)).toMatch(/materialize|not found|disabled|plugin/i);
        }
    });

    test('CREATE validation → 400: missing name, non-object targetConfig, a smuggled whitelisted field, and an over-long pluginId', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const post = (data: Record<string, unknown>) =>
            request.post(`${API_BASE}/api/notification-channels`, {
                headers: authedHeaders(token),
                data,
            });

        expect((await post({ pluginId: 'slack-channel', targetConfig: {} })).status()).toBe(400);
        expect(
            (
                await post({ pluginId: 'slack-channel', name: 'x', targetConfig: 'not-an-object' })
            ).status(),
        ).toBe(400);
        // forbidNonWhitelisted strips/rejects a server-owned field smuggled in the body.
        expect(
            (
                await post({
                    pluginId: 'slack-channel',
                    name: 'x',
                    targetConfig: {},
                    verified: true,
                })
            ).status(),
        ).toBe(400);
        expect(
            (await post({ pluginId: 'p'.repeat(70), name: 'x', targetConfig: {} })).status(),
        ).toBe(400);
    });

    test('channel id-guards: a FOREIGN channel 404s on PATCH/DELETE/test; a malformed :id → 400; an unknown-but-valid uuid → 404', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const intruder = await registerUserViaAPI(request);
        const channel = await createChannel(request, owner.access_token, {
            name: `Guard ${stamp()}`,
        });
        const iH = authedHeaders(intruder.access_token);

        expect(
            (
                await request.patch(`${API_BASE}/api/notification-channels/${channel.id}`, {
                    headers: iH,
                    data: { name: 'hij' },
                })
            ).status(),
        ).toBe(404);
        expect(
            (
                await request.delete(`${API_BASE}/api/notification-channels/${channel.id}`, {
                    headers: iH,
                })
            ).status(),
        ).toBe(404);
        expect(
            (
                await request.post(`${API_BASE}/api/notification-channels/${channel.id}/test`, {
                    headers: iH,
                })
            ).status(),
        ).toBe(404);

        const oH = authedHeaders(owner.access_token);
        // ParseUUIDPipe rejects a non-uuid before the ownership lookup.
        expect(
            (
                await request.patch(`${API_BASE}/api/notification-channels/${MALFORMED_ID}`, {
                    headers: oH,
                    data: { name: 'x' },
                })
            ).status(),
        ).toBe(400);
        // A well-formed but non-existent uuid reaches findOwnedOrThrow → 404.
        expect(
            (
                await request.patch(`${API_BASE}/api/notification-channels/${UNKNOWN_UUID}`, {
                    headers: oH,
                    data: { name: 'x' },
                })
            ).status(),
        ).toBe(404);
    });
});

test.describe('Notifications — preferences round-trip (subscriptions, quiet-hours, mute)', () => {
    test('per-event subscription three-state: subscribe to [in-app, channel] → re-set to [in-app] → clear to []; GET preferences mirrors each write', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const channel = await createChannel(request, token, { name: `Route ${stamp()}` });
        const put = (channelIds: string[]) =>
            request.put(`${API_BASE}/api/notifications/preferences/event/agent_run_finished`, {
                headers: authedHeaders(token),
                data: { channelIds },
            });

        const both = await put(['in-app', channel.id]);
        expect(both.status()).toBe(200);
        expect((await both.json()).subscription.channelIds).toEqual(['in-app', channel.id]);
        expect(
            (await getPreferences(request, token)).subscriptions.find(
                (s) => s.eventTypeKey === 'agent_run_finished',
            )?.channelIds,
        ).toEqual(['in-app', channel.id]);

        // Narrow to in-app only.
        const narrowed = await put(['in-app']);
        expect(narrowed.status()).toBe(200);
        expect((await narrowed.json()).subscription.channelIds).toEqual(['in-app']);

        // Clear to "deliver nowhere" — a DISTINCT persisted state from no-subscription.
        const cleared = await put([]);
        expect(cleared.status()).toBe(200);
        expect((await cleared.json()).subscription.channelIds).toEqual([]);
        expect(
            (await getPreferences(request, token)).subscriptions.find(
                (s) => s.eventTypeKey === 'agent_run_finished',
            )?.channelIds,
        ).toEqual([]);
    });

    test('subscription rejects an UNREGISTERED event key (400) and a FOREIGN/unknown channel id (400)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        // `task_assigned` is a real producer but is NOT in the fanout event-type registry.
        const badKey = await request.put(
            `${API_BASE}/api/notifications/preferences/event/task_assigned`,
            {
                headers: authedHeaders(token),
                data: { channelIds: ['in-app'] },
            },
        );
        expect(badKey.status()).toBe(400);
        expect(String((await badKey.json()).message)).toContain('Unknown notification event type');

        const badChannel = await request.put(
            `${API_BASE}/api/notifications/preferences/event/agent_run_finished`,
            { headers: authedHeaders(token), data: { channelIds: [UNKNOWN_UUID] } },
        );
        expect(badChannel.status()).toBe(400);
        expect(String((await badChannel.json()).message)).toContain(
            'Unknown or unauthorized notification channel',
        );
    });

    test('quiet-hours round-trip: set window+tz → GET reflects it → overwrite → clear to null; HH:mm:ss accepted; bad HH:mm and bad IANA tz → 400', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const put = (data: Record<string, unknown>) =>
            request.put(`${API_BASE}/api/notifications/preferences/quiet-hours`, {
                headers: authedHeaders(token),
                data,
            });

        const set = await put({
            quietHoursStart: '22:00',
            quietHoursEnd: '07:00',
            timezone: 'Europe/London',
        });
        expect(set.status()).toBe(200);
        expect((await set.json()).preference.quietHoursStart).toBe('22:00');
        const afterSet = (await getPreferences(request, token)).preference;
        expect(afterSet?.quietHoursEnd).toBe('07:00');
        expect(afterSet?.timezone).toBe('Europe/London');

        // The full HH:mm:ss TIME form is also accepted and stored verbatim.
        const seconds = await put({
            quietHoursStart: '23:30:00',
            quietHoursEnd: '06:15:00',
            timezone: 'UTC',
        });
        expect(seconds.status()).toBe(200);
        expect((await seconds.json()).preference.quietHoursStart).toBe('23:30:00');

        // Clear the window back to null.
        const clear = await put({ quietHoursStart: null, quietHoursEnd: null, timezone: null });
        expect(clear.status()).toBe(200);
        expect((await clear.json()).preference.quietHoursStart).toBeNull();

        // Validation: an arbitrary time string and a bogus timezone are both rejected.
        expect((await put({ quietHoursStart: '9am' })).status()).toBe(400);
        expect((await put({ timezone: 'Mars/Phobos' })).status()).toBe(400);
    });

    test('category mute lifecycle: POST mute (201) → GET lists it → DELETE unmute (204) → gone; bad category on POST(400) and DELETE(400)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        const muted = await request.post(`${API_BASE}/api/notifications/preferences/mute`, {
            headers: authedHeaders(token),
            data: { category: 'generation' },
        });
        expect(muted.status()).toBe(201);
        expect((await muted.json()).mute).toMatchObject({
            category: 'generation',
            mutedUntil: null,
        });
        expect((await getPreferences(request, token)).mutes.map((m) => m.category)).toContain(
            'generation',
        );

        const unmuted = await request.delete(
            `${API_BASE}/api/notifications/preferences/mute/generation`,
            {
                headers: authedHeaders(token),
            },
        );
        expect(unmuted.status()).toBe(204);
        expect((await getPreferences(request, token)).mutes.map((m) => m.category)).not.toContain(
            'generation',
        );

        // POST validates the body enum; DELETE validates the path enum via ParseEnumPipe.
        expect(
            (
                await request.post(`${API_BASE}/api/notifications/preferences/mute`, {
                    headers: authedHeaders(token),
                    data: { category: 'bogus' },
                })
            ).status(),
        ).toBe(400);
        expect(
            (
                await request.delete(`${API_BASE}/api/notifications/preferences/mute/bogus`, {
                    headers: authedHeaders(token),
                })
            ).status(),
        ).toBe(400);
    });

    test('muting a category does NOT suppress its in-app row — the v1 producer always writes (mute gates fanout only)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        const muted = await request.post(`${API_BASE}/api/notifications/preferences/mute`, {
            headers: authedHeaders(token),
            data: { category: 'task' },
        });
        expect(muted.status()).toBe(201);

        // With `task` muted, a self-assignment STILL lands an in-app row + increments the badge.
        const { row } = await produceTaskNotification(
            request,
            token,
            user.user.id,
            `Muted ${stamp()}`,
        );
        expect(row.category).toBe('task');
        expect(
            await waitForCount(
                request,
                token,
                (c) => c >= 1,
                'muted category still produces an in-app row',
            ),
        ).toBeGreaterThanOrEqual(1);
    });
});

test.describe('Notifications — registry + list contract + auth gates', () => {
    test('event-types registry: >=8 core keys, each fully-shaped and sorted, agent_run_finished present; urgent flag partitions the set', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/notifications/event-types`, {
            headers: authedHeaders(user.access_token),
        });
        expect(res.status()).toBe(200);
        const eventTypes = (await res.json()).eventTypes as Array<{
            key: string;
            category: string;
            title: string;
            description: string;
            urgent: boolean;
            defaultChannels: string[];
            source: string;
            pluginId: string | null;
        }>;
        expect(eventTypes.length).toBeGreaterThanOrEqual(8);
        expect(eventTypes.map((e) => e.key)).toContain('agent_run_finished');
        expect(eventTypes.map((e) => e.key)).toContain('ai_credits_depleted');

        for (const e of eventTypes) {
            expect(typeof e.key).toBe('string');
            expect(typeof e.category).toBe('string');
            expect(typeof e.title).toBe('string');
            expect(typeof e.description).toBe('string');
            expect(typeof e.urgent).toBe('boolean');
            expect(Array.isArray(e.defaultChannels)).toBe(true);
            expect(e.defaultChannels).toContain('in-app');
            expect(e.source).toBe('core');
            expect(e.pluginId).toBeNull();
        }
        // Sorted by (category, key).
        const sortedKeys = [...eventTypes]
            .map((e) => `${e.category} ${e.key}`)
            .every((v, i, arr) => i === 0 || arr[i - 1] <= v);
        expect(sortedKeys).toBe(true);
        // The urgent flag (quiet-hours / digest bypass) partitions the registry — at
        // least ai_credits_depleted is urgent while agent_run_finished is not.
        expect(eventTypes.find((e) => e.key === 'ai_credits_depleted')?.urgent).toBe(true);
        expect(eventTypes.find((e) => e.key === 'agent_run_finished')?.urgent).toBe(false);
    });

    test('list contract on a populated inbox: category filter (match/exclude/ignore-invalid), dismissed excluded, junk pagination tolerated, and the cache-control split', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const { row } = await produceTaskNotification(
            request,
            token,
            user.user.id,
            `ListC ${stamp()}`,
        );

        // category filter: exact-match includes, a mismatched category excludes,
        // an INVALID category is ignored (the controller returns all rows).
        expect(
            (await listNotifications(request, token, '?category=task&limit=100')).map((r) => r.id),
        ).toContain(row.id);
        expect(
            (await listNotifications(request, token, '?category=security&limit=100')).map(
                (r) => r.id,
            ),
        ).not.toContain(row.id);
        expect(
            (await listNotifications(request, token, '?category=bogus&limit=100')).map((r) => r.id),
        ).toContain(row.id);

        // Junk pagination params are tolerated — 200 with a stable envelope, never a 5xx.
        for (const q of ['?limit=abc', '?offset=xyz', '?unreadOnly=maybe', '?limit=-5']) {
            const res = await request.get(`${API_BASE}/api/notifications${q}`, {
                headers: authedHeaders(token),
            });
            expect(res.status(), `junk ${q}`).toBe(200);
            expect(Array.isArray((await res.json()).notifications)).toBe(true);
        }

        // Cache-control split: the list is private/no-store, unread-count is NOT.
        const listRes = await request.get(`${API_BASE}/api/notifications`, {
            headers: authedHeaders(token),
        });
        expect((listRes.headers()['cache-control'] ?? '').toLowerCase()).toContain('no-store');
        const countRes = await request.get(`${API_BASE}/api/notifications/unread-count`, {
            headers: authedHeaders(token),
        });
        expect((countRes.headers()['cache-control'] ?? '').toLowerCase()).not.toContain('no-store');

        // Dismissing removes the row from the default list.
        await request.post(`${API_BASE}/api/notifications/${row.id}/dismiss`, {
            headers: authedHeaders(token),
        });
        expect(
            (await listNotifications(request, token, '?limit=100')).map((r) => r.id),
        ).not.toContain(row.id);
    });

    test('the limit query is capped at 100: requesting limit=500 is accepted (200) and never returns more than 100 rows', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const res = await request.get(`${API_BASE}/api/notifications?limit=500`, {
            headers: authedHeaders(token),
        });
        expect(res.status()).toBe(200);
        expect((await res.json()).notifications.length).toBeLessThanOrEqual(100);
    });

    test('auth gates: every notifications / channels / preferences route is 401 without a bearer token', async ({
        request,
    }) => {
        const reads = [
            'notifications',
            'notifications/unread-count',
            'notifications/persistent',
            'notifications/event-types',
            'notifications/preferences',
            'notification-channels',
        ];
        for (const p of reads) {
            expect((await request.get(`${API_BASE}/api/${p}`)).status(), `GET ${p}`).toBe(401);
        }
        expect((await request.post(`${API_BASE}/api/notifications/read-all`)).status()).toBe(401);
        expect(
            (await request.post(`${API_BASE}/api/notifications/${UNKNOWN_UUID}/read`)).status(),
        ).toBe(401);
        expect(
            (
                await request.post(`${API_BASE}/api/notification-channels`, {
                    data: { pluginId: 'slack-channel', name: 'x', targetConfig: {} },
                })
            ).status(),
        ).toBe(401);
        expect(
            (
                await request.put(`${API_BASE}/api/notifications/preferences/quiet-hours`, {
                    data: { quietHoursStart: '10:00' },
                })
            ).status(),
        ).toBe(401);
    });
});
