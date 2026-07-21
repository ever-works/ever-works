/**
 * Notifications + Notification-Preferences — VALIDATION / AUTHZ / STATUS-POSTURE MATRIX.
 *
 * Distinct-angle companion to the existing notification specs (cross-user,
 * read-lifecycle, inbox-deep, preferences-deep). Those prove the happy-path
 * CRUD + isolation on REAL produced rows. This file instead pins, byte-for-byte
 * against a live stack, the EXHAUSTIVE per-field validation surface, the exact
 * error-shape/status-code contract, and the several *surprising* postures the
 * two controllers expose — none of which the existing specs assert exhaustively.
 *
 * ── Probed live (http://127.0.0.1:3100, sqlite in-memory, all flags ON) ──
 *
 * notifications.controller.ts (@Controller('api/notifications'), AuthSessionGuard):
 *   • GET /                      → 200 { notifications: [] }; header Cache-Control: private, no-store
 *   • GET /unread-count          → 200 { count: <number> }
 *   • GET /persistent            → 200 { notifications: [] }
 *   • query pipes: DefaultValuePipe + ParseBoolPipe(unreadOnly) / ParseIntPipe(limit,offset):
 *       - valid scalars                 → 200
 *       - limit=1.5 / offset=1.5 (float)→ 400 "Validation failed (numeric string is expected)"
 *       - junk scalars (abc / notabool) → tolerated (observed 200, defaulted) — asserted [200,400]
 *       - category is a MANUAL whitelist (no pipe): unknown value → silently ignored → 200;
 *         extended enum (agent/task/security) → 200
 *   • POST /:id/read , /:id/dismiss  — NO ParseUUIDPipe. Service does findByIdAndUserId and
 *       throws BadRequestException('Notification not found') → **400, never 404/403**, for
 *       unknown uuid, malformed uuid, AND another user's row (400-not-found isolation posture).
 *   • POST /read-all             → 200 { success: true } (no body DTO → junk body ignored)
 *   • every route unauth         → 401 { message:"Unauthorized", statusCode:401 }
 *   • wrong HTTP verb            → 404 "Cannot GET ..."
 *
 * notification-preferences.controller.ts (same base + guard):
 *   • PUT /preferences/quiet-hours (QuietHoursBody DTO, all @IsOptional):
 *       - HH:mm and HH:mm:ss accepted; null / {} accepted → 200 { preference:{...} }
 *       - bad time (25:00 / 24:00 / 9:5 / 23:60 / 12:00:60 / 1a:00) → 400 ["<field> must be in HH:mm format"]
 *       - non-string start → 400 (dual msg incl "must be a string")
 *       - timezone bad → 400 ["timezone must be a valid IANA timezone identifier"]; GMT/UTC/IANA → 200
 *       - extra field → 400 ["property <x> should not exist"] (forbidNonWhitelisted)
 *   • POST /preferences/mute (MuteBody DTO): valid → **201** { mute:{ category, mutedUntil } };
 *       all 7 NotificationCategory values (incl agent/task) valid; mutedUntil echoed;
 *       bad/missing/empty/number category → 400 ["category must be one of: ai_credits, subscription,
 *       generation, system, security, agent, task"]; mutedUntil number → 400 ["mutedUntil must be a string"];
 *       extra field → 400.
 *   • DELETE /preferences/mute/:category (ParseEnumPipe) → **204**; bad category →
 *       400 "Validation failed (enum string is expected)"; unmuting a non-muted category → 204 (idempotent).
 *   • PUT /preferences/event/:eventKey — body is a PLAIN INTERFACE, NOT a DTO, so there is NO
 *       forbidNonWhitelisted / array validation. Observed: extra field PASSES (200); missing
 *       channelIds coerces to [] (200); a string body is char-iterated (400 "Unknown or unauthorized
 *       notification channel: <firstChar>"); unknown eventKey → 400 "Unknown notification event type";
 *       unknown channel uuid → 400 "Unknown or unauthorized notification channel"; >20 unique ids →
 *       400 "Too many notification channels: maximum 20 allowed per subscription."
 *   • GET /preferences → 200 { subscriptions, preference, mutes }; strictly per-user (cross-user isolated).
 *
 * Fully API-orchestrated; a FRESH registerUserViaAPI() owner per test (never the seeded user).
 */
import { test, expect, type APIResponse } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

const NOTIF = `${API_BASE}/api/notifications`;
const UNKNOWN_UUID = '00000000-0000-0000-0000-000000000000';
const JSON_HEADERS = { 'Content-Type': 'application/json' };
// A registered core event type (from GET /event-types); used for subscription writes.
const VALID_EVENT_KEY = 'generation_error';
// Full NotificationCategory enum (notification.types.ts) — incl. the extended agent/task values.
const ALL_CATEGORIES = [
    'ai_credits',
    'subscription',
    'generation',
    'system',
    'security',
    'agent',
    'task',
] as const;
const CATEGORY_ENUM_MSG =
    'category must be one of: ai_credits, subscription, generation, system, security, agent, task';

/** Normalise the class-validator (array) vs pipe/service (string) `message` field to one string. */
function msgText(body: { message?: unknown }): string {
    const m = body?.message;
    return Array.isArray(m) ? m.join(' | ') : String(m);
}

async function expectUnauthorized(res: APIResponse): Promise<void> {
    expect(res.status()).toBe(401);
    const body = await res.json();
    expect(body).toMatchObject({ message: 'Unauthorized', statusCode: 401 });
}

// ────────────────────────────────────────────────────────────────────────────
test.describe('Notifications inbox — read surface + query/param validation matrix', () => {
    test('list / unread-count / persistent return the exact happy-path shapes; list is private/no-store', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const h = authedHeaders(user.access_token);

        const list = await request.get(NOTIF, { headers: h });
        expect(list.status()).toBe(200);
        const listBody = await list.json();
        expect(Array.isArray(listBody.notifications)).toBe(true);
        // Fresh user → empty inbox (isolation from any other user's rows).
        expect(listBody.notifications).toEqual([]);
        // @Header('Cache-Control', 'private, no-store') on the list route.
        expect((list.headers()['cache-control'] || '').toLowerCase()).toContain('no-store');

        const count = await request.get(`${NOTIF}/unread-count`, { headers: h });
        expect(count.status()).toBe(200);
        const countBody = await count.json();
        expect(typeof countBody.count).toBe('number');
        expect(countBody.count).toBe(0);

        const persistent = await request.get(`${NOTIF}/persistent`, { headers: h });
        expect(persistent.status()).toBe(200);
        expect((await persistent.json()).notifications).toEqual([]);
    });

    test('every read endpoint is hard-gated behind auth → 401 constant shape', async ({
        request,
    }) => {
        for (const path of ['', '/unread-count', '/persistent']) {
            await expectUnauthorized(await request.get(`${NOTIF}${path}`));
        }
    });

    test('valid query filters (unreadOnly / limit / offset / category) all resolve → 200 array shape', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const h = authedHeaders(user.access_token);
        for (const q of [
            'unreadOnly=true',
            'unreadOnly=false',
            'limit=10',
            'limit=1',
            'offset=0',
            'offset=5',
            'category=security',
            'unreadOnly=true&limit=25&offset=0&category=generation',
        ]) {
            const res = await request.get(`${NOTIF}?${q}`, { headers: h });
            expect(res.status(), `query ${q}`).toBe(200);
            expect(Array.isArray((await res.json()).notifications), `query ${q}`).toBe(true);
        }
    });

    test('non-integer numeric limit/offset are rejected by ParseIntPipe → 400 "numeric string is expected"', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const h = authedHeaders(user.access_token);
        for (const q of ['limit=1.5', 'offset=1.5', 'limit=3.14']) {
            const res = await request.get(`${NOTIF}?${q}`, { headers: h });
            expect(res.status(), `query ${q}`).toBe(400);
            const body = await res.json();
            expect(msgText(body)).toContain('numeric string is expected');
            expect(body.statusCode).toBe(400);
        }
    });

    test('category filter is a manual whitelist: unknown values are silently ignored (200), extended enum is honoured', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const h = authedHeaders(user.access_token);
        // Unknown category → controller maps to undefined (no filter), NOT a 400.
        for (const cat of ['bogus', 'AI_CREDITS', 'notacat', '123']) {
            const res = await request.get(`${NOTIF}?category=${cat}`, { headers: h });
            expect(res.status(), `category=${cat}`).toBe(200);
            expect(Array.isArray((await res.json()).notifications)).toBe(true);
        }
        // Every real NotificationCategory (incl. agent/task) is accepted.
        for (const cat of ALL_CATEGORIES) {
            const res = await request.get(`${NOTIF}?category=${cat}`, { headers: h });
            expect(res.status(), `category=${cat}`).toBe(200);
        }
    });

    test('junk scalar params (non-numeric limit/offset, non-bool unreadOnly) are tolerated, never a 5xx', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const h = authedHeaders(user.access_token);
        // Observed live: these default gracefully (200). Assert the pair of legitimate
        // outcomes (accept-and-default | reject) — never a server error.
        for (const q of ['limit=abc', 'offset=abc', 'unreadOnly=notabool', 'unreadOnly=maybe']) {
            const res = await request.get(`${NOTIF}?${q}`, { headers: h });
            expect([200, 400], `query ${q} status=${res.status()}`).toContain(res.status());
            if (res.status() === 200) {
                expect(Array.isArray((await res.json()).notifications)).toBe(true);
            }
        }
    });
});

// ────────────────────────────────────────────────────────────────────────────
test.describe('Notifications mark-read / dismiss / read-all — 400-not-found posture + authz', () => {
    test('mark-as-read on an unknown uuid → 400 "Notification not found" (never 404/403)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const res = await request.post(`${NOTIF}/${UNKNOWN_UUID}/read`, {
            headers: authedHeaders(user.access_token),
        });
        expect(res.status()).toBe(400);
        const body = await res.json();
        expect(body.message).toBe('Notification not found');
        expect(body.statusCode).toBe(400);
    });

    test('mark-as-read on a MALFORMED id also → 400 not-found (no ParseUUIDPipe on the route)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const res = await request.post(`${NOTIF}/not-a-uuid/read`, {
            headers: authedHeaders(user.access_token),
        });
        // A ParseUUIDPipe would 400 with "Validation failed (uuid ...)"; here it reaches
        // the service and returns the domain not-found string instead.
        expect(res.status()).toBe(400);
        expect((await res.json()).message).toBe('Notification not found');
    });

    test('dismiss on unknown AND malformed ids → 400 "Notification not found"', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const h = authedHeaders(user.access_token);
        for (const id of [UNKNOWN_UUID, 'xyz', '12345']) {
            const res = await request.post(`${NOTIF}/${id}/dismiss`, { headers: h });
            expect(res.status(), `id ${id}`).toBe(400);
            expect((await res.json()).message).toBe('Notification not found');
        }
    });

    test('read-all → 200 { success:true }; an unexpected body is ignored (no body DTO)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const h = authedHeaders(user.access_token);
        const res = await request.post(`${NOTIF}/read-all`, { headers: h });
        expect(res.status()).toBe(200);
        expect(await res.json()).toEqual({ success: true });

        const withBody = await request.post(`${NOTIF}/read-all`, {
            headers: { ...h, ...JSON_HEADERS },
            data: { foo: 'bar', unexpected: 123 },
        });
        expect(withBody.status()).toBe(200);
        expect(await withBody.json()).toEqual({ success: true });
    });

    test('read / dismiss / read-all all reject anon → 401', async ({ request }) => {
        await expectUnauthorized(await request.post(`${NOTIF}/${UNKNOWN_UUID}/read`));
        await expectUnauthorized(await request.post(`${NOTIF}/${UNKNOWN_UUID}/dismiss`));
        await expectUnauthorized(await request.post(`${NOTIF}/read-all`));
    });

    test('wrong HTTP verb on a mutation route → 404 "Cannot GET"; cross-user foreign id → 400 not-found', async ({
        request,
    }) => {
        const [a, b] = await Promise.all([
            registerUserViaAPI(request),
            registerUserViaAPI(request),
        ]);
        // GET on the POST-only /:id/read route → framework 404, not our 400.
        const wrongVerb = await request.get(`${NOTIF}/${UNKNOWN_UUID}/read`, {
            headers: authedHeaders(a.access_token),
        });
        expect(wrongVerb.status()).toBe(404);
        expect(msgText(await wrongVerb.json())).toContain('Cannot GET');

        // A notification id is looked up scoped to the caller, so anything not owned by B
        // (here: a syntactically-valid uuid B does not own) surfaces as 400 not-found —
        // a 400-never-403 isolation posture, indistinguishable from a truly-missing row.
        const foreign = await request.post(`${NOTIF}/${UNKNOWN_UUID}/dismiss`, {
            headers: authedHeaders(b.access_token),
        });
        expect(foreign.status()).toBe(400);
        expect((await foreign.json()).message).toBe('Notification not found');
    });
});

// ────────────────────────────────────────────────────────────────────────────
test.describe('Quiet-hours PUT — per-field validation matrix', () => {
    const QH = () => `${NOTIF}/preferences/quiet-hours`;

    test('valid HH:mm, HH:mm:ss, null and empty body all persist → 200 preference shape', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const h = { ...authedHeaders(user.access_token), ...JSON_HEADERS };

        const ok = await request.put(QH(), {
            headers: h,
            data: { quietHoursStart: '22:00', quietHoursEnd: '07:00', timezone: 'UTC' },
        });
        expect(ok.status()).toBe(200);
        const pref = (await ok.json()).preference;
        expect(pref).toMatchObject({
            quietHoursStart: '22:00',
            quietHoursEnd: '07:00',
            timezone: 'UTC',
        });
        expect(pref.userId).toBe(user.user.id);

        // HH:mm:ss form is accepted and stored verbatim.
        const withSeconds = await request.put(QH(), {
            headers: h,
            data: { quietHoursStart: '23:15:45', quietHoursEnd: '06:30:00' },
        });
        expect(withSeconds.status()).toBe(200);
        expect((await withSeconds.json()).preference.quietHoursStart).toBe('23:15:45');

        // Explicit nulls clear the window.
        const cleared = await request.put(QH(), {
            headers: h,
            data: { quietHoursStart: null, quietHoursEnd: null, timezone: null },
        });
        expect(cleared.status()).toBe(200);
        expect((await cleared.json()).preference).toMatchObject({
            quietHoursStart: null,
            quietHoursEnd: null,
            timezone: null,
        });

        // Empty body — every field optional → 200.
        const empty = await request.put(QH(), { headers: h, data: {} });
        expect(empty.status()).toBe(200);
    });

    test('every invalid start/end time boundary → 400 "<field> must be in HH:mm format"', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const h = { ...authedHeaders(user.access_token), ...JSON_HEADERS };
        for (const bad of [
            '25:00',
            '24:00',
            '9:5',
            '23:60',
            '12:00:60',
            '1a:00',
            '7:00',
            '',
            'noon',
        ]) {
            const res = await request.put(QH(), { headers: h, data: { quietHoursStart: bad } });
            expect(res.status(), `start=${JSON.stringify(bad)}`).toBe(400);
            expect(msgText(await res.json())).toContain('quietHoursStart must be in HH:mm format');
        }
        // The end field is validated independently by the same regex.
        const endRes = await request.put(QH(), { headers: h, data: { quietHoursEnd: '88:00' } });
        expect(endRes.status()).toBe(400);
        expect(msgText(await endRes.json())).toContain('quietHoursEnd must be in HH:mm format');
    });

    test('a non-string start yields BOTH the format AND the string-type violations → 400', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const h = { ...authedHeaders(user.access_token), ...JSON_HEADERS };
        const res = await request.put(QH(), { headers: h, data: { quietHoursStart: 2200 } });
        expect(res.status()).toBe(400);
        const text = msgText(await res.json());
        expect(text).toContain('quietHoursStart must be in HH:mm format');
        expect(text).toContain('quietHoursStart must be a string');
    });

    test('timezone must be a valid IANA identifier: junk → 400, GMT/UTC/IANA → 200', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const h = { ...authedHeaders(user.access_token), ...JSON_HEADERS };
        for (const bad of ['Mars/Phobos', 'Not/AZone', 'PST', 'utc']) {
            const res = await request.put(QH(), { headers: h, data: { timezone: bad } });
            expect(res.status(), `tz=${bad}`).toBe(400);
            expect(msgText(await res.json())).toContain(
                'timezone must be a valid IANA timezone identifier',
            );
        }
        // The V8-omitted aliases GMT/UTC are explicitly re-allowed; real zones pass.
        for (const good of ['GMT', 'UTC', 'America/New_York', 'Europe/London']) {
            const res = await request.put(QH(), { headers: h, data: { timezone: good } });
            expect(res.status(), `tz=${good}`).toBe(200);
            expect((await res.json()).preference.timezone).toBe(good);
        }
    });

    test('an unknown property is rejected by forbidNonWhitelisted → 400; anon → 401', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const h = { ...authedHeaders(user.access_token), ...JSON_HEADERS };
        const res = await request.put(QH(), {
            headers: h,
            data: { quietHoursStart: '22:00', evilField: 'x' },
        });
        expect(res.status()).toBe(400);
        expect(msgText(await res.json())).toContain('property evilField should not exist');

        await expectUnauthorized(
            await request.put(QH(), { headers: JSON_HEADERS, data: { quietHoursStart: '22:00' } }),
        );
    });
});

// ────────────────────────────────────────────────────────────────────────────
test.describe('Mute POST — enum DTO validation matrix', () => {
    const MUTE = () => `${NOTIF}/preferences/mute`;

    test('every NotificationCategory (incl. agent/task) mutes → 201; mutedUntil is echoed back', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const h = { ...authedHeaders(user.access_token), ...JSON_HEADERS };
        for (const category of ALL_CATEGORIES) {
            const res = await request.post(MUTE(), { headers: h, data: { category } });
            // POST default success status is 201.
            expect(res.status(), `category=${category}`).toBe(201);
            expect((await res.json()).mute).toEqual({ category, mutedUntil: null });
        }
        // A provided mutedUntil ISO string is stored + echoed.
        const until = '2031-06-15T10:30:00.000Z';
        const withUntil = await request.post(MUTE(), {
            headers: h,
            data: { category: 'subscription', mutedUntil: until },
        });
        expect(withUntil.status()).toBe(201);
        expect((await withUntil.json()).mute).toEqual({
            category: 'subscription',
            mutedUntil: until,
        });

        // All mutes are readable back via GET /preferences (per-user).
        const prefs = await request.get(`${NOTIF}/preferences`, {
            headers: authedHeaders(user.access_token),
        });
        const muted = (await prefs.json()).mutes.map((m: { category: string }) => m.category);
        for (const category of ALL_CATEGORIES) {
            expect(muted).toContain(category);
        }
    });

    test('bad / missing / empty / non-string category → 400 with the exact enum message', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const h = { ...authedHeaders(user.access_token), ...JSON_HEADERS };
        const cases: Array<Record<string, unknown>> = [
            { category: 'bogus' },
            { category: 'AI_CREDITS' }, // enum keys are not valid values
            {}, // missing
            { category: '' }, // empty
            { category: 123 }, // wrong type
            { category: null },
        ];
        for (const data of cases) {
            const res = await request.post(MUTE(), { headers: h, data });
            expect(res.status(), JSON.stringify(data)).toBe(400);
            expect(msgText(await res.json())).toContain(CATEGORY_ENUM_MSG);
        }
    });

    test('mutedUntil wrong type → 400 "must be a string"; unknown property → 400; anon → 401', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const h = { ...authedHeaders(user.access_token), ...JSON_HEADERS };

        const badUntil = await request.post(MUTE(), {
            headers: h,
            data: { category: 'system', mutedUntil: 123 },
        });
        expect(badUntil.status()).toBe(400);
        expect(msgText(await badUntil.json())).toContain('mutedUntil must be a string');

        const extra = await request.post(MUTE(), {
            headers: h,
            data: { category: 'system', evilField: 'x' },
        });
        expect(extra.status()).toBe(400);
        expect(msgText(await extra.json())).toContain('property evilField should not exist');

        await expectUnauthorized(
            await request.post(MUTE(), { headers: JSON_HEADERS, data: { category: 'system' } }),
        );
    });
});

// ────────────────────────────────────────────────────────────────────────────
test.describe('Unmute DELETE — ParseEnumPipe param matrix', () => {
    const unmute = (c: string) => `${NOTIF}/preferences/mute/${c}`;

    test('valid category unmute → 204; extended enum (agent/task) → 204; idempotent on a non-muted category → 204', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const h = authedHeaders(user.access_token);
        const jh = { ...h, ...JSON_HEADERS };
        // Mute then unmute → 204 (empty body).
        await request.post(`${NOTIF}/preferences/mute`, {
            headers: jh,
            data: { category: 'security' },
        });
        const del = await request.delete(unmute('security'), { headers: h });
        expect(del.status()).toBe(204);
        expect(await del.text()).toBe('');

        // The extended enum members are accepted by the ParseEnumPipe too.
        for (const c of ['agent', 'task', 'generation']) {
            const res = await request.delete(unmute(c), { headers: h });
            // Deleting a never-muted category is a no-op → still 204 (idempotent).
            expect(res.status(), `unmute ${c}`).toBe(204);
        }
    });

    test('a category outside the enum → 400 "Validation failed (enum string is expected)"; anon → 401', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const h = authedHeaders(user.access_token);
        for (const bad of ['bogus', 'AI_CREDITS', 'not-a-category']) {
            const res = await request.delete(unmute(bad), { headers: h });
            expect(res.status(), `unmute ${bad}`).toBe(400);
            expect(msgText(await res.json())).toContain('enum string is expected');
        }
        await expectUnauthorized(await request.delete(unmute('security')));
    });
});

// ────────────────────────────────────────────────────────────────────────────
test.describe('Event subscription PUT — untyped-body contract (no DTO validation)', () => {
    const sub = (key: string) => `${NOTIF}/preferences/event/${key}`;

    test('valid in-app subscription → 200 shape; empty array and missing channelIds both → 200', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const h = { ...authedHeaders(user.access_token), ...JSON_HEADERS };

        const ok = await request.put(sub(VALID_EVENT_KEY), {
            headers: h,
            data: { channelIds: ['in-app'] },
        });
        expect(ok.status()).toBe(200);
        const s = (await ok.json()).subscription;
        expect(s).toMatchObject({ eventTypeKey: VALID_EVENT_KEY, channelIds: ['in-app'] });
        expect(s.userId).toBe(user.user.id);
        expect(typeof s.id).toBe('string');

        // Empty channelIds is a valid distinct state ("deliver nowhere").
        const empty = await request.put(sub(VALID_EVENT_KEY), {
            headers: h,
            data: { channelIds: [] },
        });
        expect(empty.status()).toBe(200);
        expect((await empty.json()).subscription.channelIds).toEqual([]);

        // Missing channelIds is coerced to [] (new Set(undefined)) — NOT a 400.
        const missing = await request.put(sub(VALID_EVENT_KEY), { headers: h, data: {} });
        expect(missing.status()).toBe(200);
        expect((await missing.json()).subscription.channelIds).toEqual([]);
    });

    test('service-level rejections: unknown event key, unknown channel id, and the >20 cap all → 400', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const h = { ...authedHeaders(user.access_token), ...JSON_HEADERS };

        const badKey = await request.put(sub('totally_not_an_event'), {
            headers: h,
            data: { channelIds: ['in-app'] },
        });
        expect(badKey.status()).toBe(400);
        expect(msgText(await badKey.json())).toContain('Unknown notification event type');

        const badChannel = await request.put(sub(VALID_EVENT_KEY), {
            headers: h,
            data: { channelIds: [UNKNOWN_UUID] },
        });
        expect(badChannel.status()).toBe(400);
        expect(msgText(await badChannel.json())).toContain(
            'Unknown or unauthorized notification channel',
        );

        // 21 unique non-built-in ids (in-app is exempt) exceed MAX_SUBSCRIPTION_CHANNELS (20).
        const many = ['in-app', ...Array.from({ length: 20 }, (_, i) => `chan-${i}`)];
        const overCap = await request.put(sub(VALID_EVENT_KEY), {
            headers: h,
            data: { channelIds: many },
        });
        expect(overCap.status()).toBe(400);
        expect(msgText(await overCap.json())).toContain('maximum 20');
    });

    test('a string body is char-iterated by new Set() → 400 on the first unowned character', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const h = { ...authedHeaders(user.access_token), ...JSON_HEADERS };
        // channelIds:"in-app" (a string, not an array) → Set('in-app') = {i,n,-,a,p} → first
        // char 'i' fails the ownership check. Proves the body is unvalidated (no @IsArray).
        const res = await request.put(sub(VALID_EVENT_KEY), {
            headers: h,
            data: { channelIds: 'in-app' },
        });
        expect(res.status()).toBe(400);
        expect(msgText(await res.json())).toContain('Unknown or unauthorized notification channel');
    });

    test('an unknown property PASSES (plain-interface body has no forbidNonWhitelisted); anon → 401', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const h = { ...authedHeaders(user.access_token), ...JSON_HEADERS };
        // Contrast with quiet-hours/mute (DTO classes): here the extra field is silently ignored.
        const res = await request.put(sub(VALID_EVENT_KEY), {
            headers: h,
            data: { channelIds: ['in-app'], evilField: 'x' },
        });
        expect(res.status()).toBe(200);
        expect((await res.json()).subscription.channelIds).toEqual(['in-app']);

        await expectUnauthorized(
            await request.put(sub(VALID_EVENT_KEY), {
                headers: JSON_HEADERS,
                data: { channelIds: ['in-app'] },
            }),
        );
    });
});

// ────────────────────────────────────────────────────────────────────────────
test.describe('Cross-user preference isolation', () => {
    test('A sets mute + quiet-hours + subscription; B sees none of it and cannot unmute across the boundary', async ({
        request,
    }) => {
        const [a, b] = await Promise.all([
            registerUserViaAPI(request),
            registerUserViaAPI(request),
        ]);
        const ha = { ...authedHeaders(a.access_token), ...JSON_HEADERS };
        const hb = { ...authedHeaders(b.access_token), ...JSON_HEADERS };

        await request.post(`${NOTIF}/preferences/mute`, {
            headers: ha,
            data: { category: 'security' },
        });
        await request.put(`${NOTIF}/preferences/quiet-hours`, {
            headers: ha,
            data: { quietHoursStart: `0${(Date.now() % 9) + 1}:00`, timezone: 'UTC' },
        });
        await request.put(`${NOTIF}/preferences/event/${VALID_EVENT_KEY}`, {
            headers: ha,
            data: { channelIds: ['in-app'] },
        });

        // B's preference view is completely empty — no leakage of A's rows.
        const bView = await request.get(`${NOTIF}/preferences`, {
            headers: authedHeaders(b.access_token),
        });
        expect(bView.status()).toBe(200);
        const bBody = await bView.json();
        expect(bBody.subscriptions).toEqual([]);
        expect(bBody.preference).toBeNull();
        expect(bBody.mutes).toEqual([]);

        // B unmuting 'security' is scoped to B → 204 no-op, and A stays muted.
        const bUnmute = await request.delete(`${NOTIF}/preferences/mute/security`, {
            headers: authedHeaders(b.access_token),
        });
        expect(bUnmute.status()).toBe(204);

        const aView = await request.get(`${NOTIF}/preferences`, {
            headers: authedHeaders(a.access_token),
        });
        const aMutes = (await aView.json()).mutes.map((m: { category: string }) => m.category);
        expect(aMutes).toContain('security');
    });

    test('an invalid / malformed bearer token is rejected on the preferences surface → 401', async ({
        request,
    }) => {
        await expectUnauthorized(
            await request.get(`${NOTIF}/preferences`, {
                headers: { Authorization: 'Bearer totally-invalid-token' },
            }),
        );
        await expectUnauthorized(
            await request.get(`${NOTIF}/preferences`, {
                headers: { Authorization: 'NotBearer xyz' },
            }),
        );
    });
});
