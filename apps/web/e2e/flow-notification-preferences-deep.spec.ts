import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * Notification PREFERENCES — VALIDATION & ERROR-CONTRACT deep coverage.
 *
 * The two existing preference specs nail the HAPPY-PATH persistence + the
 * channel ownership gate. This file targets the surface they DON'T touch: the
 * INPUT-VALIDATION contracts on the preferences sub-routes (quiet-hours time /
 * timezone format gates, mute-category enum gate, unmute path-param pipe gate),
 * the date/seconds coercion edges, the empty-body-clears semantics, and the
 * isolation of these PREFERENCE/MUTE rows across users + the anon boundary.
 *
 * NON-DUPLICATION — already covered elsewhere, NOT repeated here:
 *   - notifications-preferences.spec.ts          one happy subscribe; one happy
 *                                                mute+unmute; one happy quiet-hours
 *                                                round-trip; GET prefs auth gate.
 *   - flow-notifications-preferences.spec.ts     whole-registry per-event matrix;
 *                                                three-state delivery; subscription
 *                                                dedup + channel ownership/foreign-id
 *                                                gate; quiet-hours overwrite +
 *                                                ALL-NULL clear; mute upsert-dedup +
 *                                                idempotent unmute; settings UI.
 *   - flow-notifications-cross-user.spec.ts      cross-user CHANNEL + SUBSCRIPTION
 *                                                isolation; anon 401 on GET routes.
 *   - flow-notifications-per-event.spec.ts       producer side (task_assigned rows),
 *                                                registry-gated subscribe 400s.
 * This file is the VALIDATION / NEGATIVE-CONTRACT + PREFERENCE-record-isolation gap:
 *   1. quiet-hours TIME format gate — HH:mm and HH:mm:ss accepted; out-of-range
 *      (25:00, :99 seconds), garbage, and non-string types each 400 with the
 *      class-validator "must be in HH:mm format" message.
 *   2. quiet-hours TIMEZONE allowlist gate — a bogus zone 400s ("valid IANA
 *      timezone"); the V8-omitted UTC/GMT aliases are explicitly accepted.
 *   3. quiet-hours PARTIAL + EMPTY-BODY semantics — a start-only write nulls the
 *      untouched fields, and an empty {} body CLEARS a previously-set window
 *      (absent === null overwrite), distinct from the explicit all-null clear.
 *   4. mute CATEGORY enum gate — POST mute with an unknown category, the plural
 *      event-type label 'agents', or a MISSING category each 400 with the exact
 *      7-value enum message; mutedUntil coercion on write (past stored verbatim,
 *      garbage → Invalid Date echoed as null) vs the read's ACTIVE-mute filter
 *      (`mutedUntil IS NULL OR > now`): a past AND a garbage→Invalid-Date mute are
 *      both filtered out of the view; explicit-null + future mutes are returned.
 *   5. unmute PATH-PARAM pipe gate — DELETE mute/:category with a non-enum value
 *      400s via ParseEnumPipe with its OWN distinct message ("enum string is
 *      expected"), separate from the body-DTO message in (4).
 *   6. PREFERENCE-record + MUTE isolation across users + anon — one user's
 *      quiet-hours/mutes never surface in another's preferences view, and the
 *      mute / unmute / quiet-hours WRITE routes are all hard-401 for anon.
 *
 * PROBED, TRUTHFUL contracts (curl against http://127.0.0.1:3100 with throwaway
 * registered users BEFORE writing any assertion; cross-checked against
 * apps/api/src/notifications/notification-preferences.controller.ts):
 *
 *   PUT /api/notifications/preferences/quiet-hours (QuietHoursBody DTO):
 *     - quietHoursStart/End: @Matches(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/) —
 *       '22:00' OK, '22:30:45' OK; '25:00' / 'notatime' / '22:30:99' → 400
 *       message ["quietHoursStart must be in HH:mm format"]. A NUMBER value adds
 *       "...must be a string". Each field @IsOptional → {} body is 200.
 *     - timezone: @IsIn(VALID_TIMEZONES) where the set is
 *       Intl.supportedValuesOf('timeZone') ∪ {UTC, GMT}. 'Mars/Phobos' → 400
 *       ["timezone must be a valid IANA timezone identifier"]; 'UTC' & 'GMT' 200.
 *     - service writes ABSENT fields as null → an empty {} body after a set
 *       window returns { quietHoursStart:null, quietHoursEnd:null, timezone:null }
 *       (the row is kept, the window cleared).
 *   POST /api/notifications/preferences/mute (MuteBody DTO):
 *     - category: @IsEnum(NotificationCategory). Valid = ai_credits | subscription
 *       | generation | system | security | agent | task. Unknown / 'agents'
 *       (plural label) / MISSING → 400 message
 *       ["category must be one of: ai_credits, subscription, generation, system,
 *        security, agent, task"].
 *     - mutedUntil: @IsOptional @IsString, then `body.mutedUntil ? new
 *       Date(body.mutedUntil) : null` in the controller. A PAST ISO is stored
 *       verbatim (no write-time future-check). A non-date string is truthy →
 *       new Date('garbage') = Invalid Date, which serializes as null in the POST
 *       echo. Success status is 201.
 *     - GET /preferences returns only ACTIVE mutes via the repository's
 *       findActiveByUser = WHERE mutedUntil IS NULL OR mutedUntil > now. So an
 *       EXPIRED (past) mute AND a garbage→Invalid-Date mute are BOTH filtered out
 *       of the view (Invalid Date is neither NULL nor > now); only an explicit
 *       null (indefinite) or a future-dated mute is returned.
 *   DELETE /api/notifications/preferences/mute/:category:
 *     - @Param('category', new ParseEnumPipe(NotificationCategory)). A non-enum
 *       value → 400 { message:'Validation failed (enum string is expected)' } —
 *       a DIFFERENT message than the MuteBody enum gate. A valid enum → 204.
 *   GET /api/notifications/preferences → { subscriptions[], preference|null,
 *     mutes[] }; user-scoped on auth.userId (one user's prefs never bleed).
 *   ALL routes (mute POST, unmute DELETE, quiet-hours PUT) → 401 without a bearer.
 *
 * ENVIRONMENT NOTES (CI-faithful):
 *   - Full isolation: every test registers its OWN fresh user(s) via
 *     registerUserViaAPI (unique email per call); no module-scope await / no
 *     seeded user is touched. Unique suffixes come from the per-test title /
 *     an in-test counter, never a module-scope clock.
 *   - Pure API-contract assertions (no UI nav) — validation is environment-
 *     independent (no LLM / mail / Redis required). Keyless-CI safe.
 */

const TIMEOUT = 20_000;

interface PreferencesView {
    subscriptions: Array<{ eventTypeKey: string; channelIds: string[] }>;
    preference: {
        quietHoursStart: string | null;
        quietHoursEnd: string | null;
        timezone: string | null;
    } | null;
    mutes: Array<{ category: string; mutedUntil: string | null }>;
}

function uniqueEmail(tag: string): string {
    // Suffix derived from the tag + a process-local counter, NOT a module clock.
    counter += 1;
    return `np-deep-${tag}-${counter}-${Math.random().toString(36).slice(2, 8)}@test.local`;
}
let counter = 0;

async function freshUser(request: APIRequestContext, tag: string) {
    const u = await registerUserViaAPI(request, { email: uniqueEmail(tag) });
    return { token: u.access_token, headers: authedHeaders(u.access_token), id: u.user.id };
}

async function getPreferences(request: APIRequestContext, token: string): Promise<PreferencesView> {
    const res = await request.get(`${API_BASE}/api/notifications/preferences`, {
        headers: authedHeaders(token),
        timeout: TIMEOUT,
    });
    expect(res.status(), `prefs body=${await res.text().catch(() => '')}`).toBe(200);
    return (await res.json()) as PreferencesView;
}

function putQuietHours(
    request: APIRequestContext,
    headers: Record<string, string>,
    data: Record<string, unknown>,
) {
    return request.put(`${API_BASE}/api/notifications/preferences/quiet-hours`, {
        headers,
        data,
        timeout: TIMEOUT,
    });
}

function postMute(
    request: APIRequestContext,
    headers: Record<string, string>,
    data: Record<string, unknown>,
) {
    return request.post(`${API_BASE}/api/notifications/preferences/mute`, {
        headers,
        data,
        timeout: TIMEOUT,
    });
}

function deleteMute(request: APIRequestContext, headers: Record<string, string>, category: string) {
    return request.delete(`${API_BASE}/api/notifications/preferences/mute/${category}`, {
        headers,
        timeout: TIMEOUT,
    });
}

const MUTE_ENUM_MESSAGE =
    'category must be one of: ai_credits, subscription, generation, system, security, agent, task';

test.describe('Notification preferences — validation & error contracts (deep)', () => {
    // ----------------------------------------------------------------------- //
    //  Quiet-hours TIME format gate                                           //
    // ----------------------------------------------------------------------- //

    test('quiet-hours accepts HH:mm and the full HH:mm:ss seconds form and stores them verbatim', async ({
        request,
    }) => {
        const { token, headers } = await freshUser(request, 'qh-ok');

        const hhmm = await putQuietHours(request, headers, {
            quietHoursStart: '22:00',
            quietHoursEnd: '07:00',
            timezone: 'UTC',
        });
        expect(hhmm.status(), `hhmm body=${await hhmm.text().catch(() => '')}`).toBe(200);
        expect((await hhmm.json()).preference).toMatchObject({
            quietHoursStart: '22:00',
            quietHoursEnd: '07:00',
            timezone: 'UTC',
        });

        // The HH:mm:ss form is also accepted (callers commonly send the SQL TIME
        // shape) and stored byte-for-byte — the optional `(:[0-5]\d)?` group.
        const hhmmss = await putQuietHours(request, headers, {
            quietHoursStart: '22:30:45',
            quietHoursEnd: '07:00:00',
            timezone: 'UTC',
        });
        expect(hhmmss.status()).toBe(200);
        expect((await hhmmss.json()).preference).toMatchObject({
            quietHoursStart: '22:30:45',
            quietHoursEnd: '07:00:00',
        });

        // Persists into the preferences read.
        const view = await getPreferences(request, token);
        expect(view.preference).toMatchObject({
            quietHoursStart: '22:30:45',
            quietHoursEnd: '07:00:00',
            timezone: 'UTC',
        });
    });

    test('quiet-hours rejects out-of-range / malformed / non-string times with the HH:mm format error and never persists', async ({
        request,
    }) => {
        const { token, headers } = await freshUser(request, 'qh-bad');

        // Hour > 23.
        const overHour = await putQuietHours(request, headers, {
            quietHoursStart: '25:00',
            quietHoursEnd: '07:00',
            timezone: 'UTC',
        });
        expect(overHour.status()).toBe(400);
        expect((await overHour.json()).message).toContain(
            'quietHoursStart must be in HH:mm format',
        );

        // Free-text garbage.
        const garbage = await putQuietHours(request, headers, {
            quietHoursStart: 'notatime',
            quietHoursEnd: '07:00',
            timezone: 'UTC',
        });
        expect(garbage.status()).toBe(400);

        // Seconds out of range (the optional seconds group is still range-checked).
        const badSeconds = await putQuietHours(request, headers, {
            quietHoursStart: '22:30:99',
            quietHoursEnd: '07:00',
            timezone: 'UTC',
        });
        expect(badSeconds.status()).toBe(400);
        expect((await badSeconds.json()).message).toContain(
            'quietHoursStart must be in HH:mm format',
        );

        // A NUMBER (not a string) trips BOTH @Matches and @IsString.
        const numeric = await putQuietHours(request, headers, { quietHoursStart: 2200 });
        expect(numeric.status()).toBe(400);
        const numMsg = (await numeric.json()).message as string[];
        expect(numMsg).toEqual(
            expect.arrayContaining([
                'quietHoursStart must be in HH:mm format',
                'quietHoursStart must be a string',
            ]),
        );

        // None of the rejected writes created a preference row.
        expect((await getPreferences(request, token)).preference).toBeNull();
    });

    // ----------------------------------------------------------------------- //
    //  Quiet-hours TIMEZONE allowlist gate                                     //
    // ----------------------------------------------------------------------- //

    test('quiet-hours rejects a non-IANA timezone but accepts the V8-omitted UTC and GMT aliases', async ({
        request,
    }) => {
        const { token, headers } = await freshUser(request, 'qh-tz');

        const bogus = await putQuietHours(request, headers, {
            quietHoursStart: '22:00',
            quietHoursEnd: '07:00',
            timezone: 'Mars/Phobos',
        });
        expect(bogus.status()).toBe(400);
        expect((await bogus.json()).message).toContain(
            'timezone must be a valid IANA timezone identifier',
        );
        // The rejected timezone write left no row behind.
        expect((await getPreferences(request, token)).preference).toBeNull();

        // UTC and GMT are NOT in Intl.supportedValuesOf('timeZone') (a V8 quirk)
        // but are explicitly allowlisted in the controller — both must 200.
        for (const tz of ['UTC', 'GMT']) {
            const ok = await putQuietHours(request, headers, {
                quietHoursStart: '00:00',
                quietHoursEnd: '06:00',
                timezone: tz,
            });
            expect(ok.status(), `tz=${tz} body=${await ok.text().catch(() => '')}`).toBe(200);
            expect((await ok.json()).preference.timezone).toBe(tz);
        }

        // A real canonical IANA zone is also fine (sanity on the positive set).
        const real = await putQuietHours(request, headers, {
            quietHoursStart: '01:00',
            quietHoursEnd: '05:00',
            timezone: 'America/New_York',
        });
        expect(real.status()).toBe(200);
        expect((await real.json()).preference.timezone).toBe('America/New_York');
    });

    // ----------------------------------------------------------------------- //
    //  Quiet-hours PARTIAL + EMPTY-BODY semantics                              //
    // ----------------------------------------------------------------------- //

    test('a start-only quiet-hours write nulls the untouched fields (each field independently optional)', async ({
        request,
    }) => {
        const { token, headers } = await freshUser(request, 'qh-partial');

        const partial = await putQuietHours(request, headers, { quietHoursStart: '23:15' });
        expect(partial.status(), `partial body=${await partial.text().catch(() => '')}`).toBe(200);
        const pref = (await partial.json()).preference;
        expect(pref.quietHoursStart).toBe('23:15');
        // End + timezone were absent in the body → written as null (not preserved
        // from any default), proving each field is independently set.
        expect(pref.quietHoursEnd).toBeNull();
        expect(pref.timezone).toBeNull();

        const view = await getPreferences(request, token);
        expect(view.preference).toMatchObject({
            quietHoursStart: '23:15',
            quietHoursEnd: null,
            timezone: null,
        });
    });

    test('an empty {} quiet-hours body CLEARS a previously-set window (absent === null overwrite), keeping the row', async ({
        request,
    }) => {
        const { token, headers } = await freshUser(request, 'qh-empty');

        // First establish a full window.
        const set = await putQuietHours(request, headers, {
            quietHoursStart: '21:00',
            quietHoursEnd: '06:00',
            timezone: 'UTC',
        });
        expect(set.status()).toBe(200);
        expect((await set.json()).preference.quietHoursStart).toBe('21:00');

        // An empty body is accepted (all fields @IsOptional) and — because the
        // service writes ABSENT fields as null — it CLEARS the window. This is a
        // distinct contract from the explicit all-null clear (each field present
        // and null): here NO field is present at all, yet the window is wiped.
        const empty = await putQuietHours(request, headers, {});
        expect(empty.status(), `empty body=${await empty.text().catch(() => '')}`).toBe(200);
        const cleared = (await empty.json()).preference;
        expect(cleared.quietHoursStart).toBeNull();
        expect(cleared.quietHoursEnd).toBeNull();
        expect(cleared.timezone).toBeNull();

        // The preference ROW is kept (not null) — only the window was cleared.
        const view = await getPreferences(request, token);
        expect(view.preference).not.toBeNull();
        expect(view.preference!.quietHoursStart).toBeNull();
    });

    // ----------------------------------------------------------------------- //
    //  Mute CATEGORY enum gate + mutedUntil coercion                           //
    // ----------------------------------------------------------------------- //

    test('mute rejects an unknown category, the plural event-type label "agents", and a missing category — each with the exact 7-value enum message', async ({
        request,
    }) => {
        const { token, headers } = await freshUser(request, 'mute-enum');

        // A totally unknown category.
        const unknown = await postMute(request, headers, { category: 'not_a_category' });
        expect(unknown.status()).toBe(400);
        expect((await unknown.json()).message).toContain(MUTE_ENUM_MESSAGE);

        // The event-type CATEGORY label is the PLURAL 'agents' (on
        // agent_run_finished), but the mute enum member is the SINGULAR 'agent'.
        // Passing the registry label is therefore a 400 — a classic mismatch trap.
        const plural = await postMute(request, headers, { category: 'agents' });
        expect(plural.status()).toBe(400);
        expect((await plural.json()).message).toContain(MUTE_ENUM_MESSAGE);

        // A MISSING category fails the same @IsEnum guard (no @IsOptional).
        const missing = await postMute(request, headers, {});
        expect(missing.status()).toBe(400);
        expect((await missing.json()).message).toContain(MUTE_ENUM_MESSAGE);

        // No mute row was created by any rejected write.
        expect((await getPreferences(request, token)).mutes).toEqual([]);

        // The SINGULAR enum member 'agent' is accepted (positive control).
        const ok = await postMute(request, headers, { category: 'agent' });
        expect(ok.status()).toBe(201);
        expect((await ok.json()).mute).toEqual({ category: 'agent', mutedUntil: null });
        expect((await getPreferences(request, token)).mutes.map((m) => m.category)).toContain(
            'agent',
        );
    });

    test('mute coerces mutedUntil on WRITE (past verbatim, garbage → Invalid Date echoed null), but the view returns only ACTIVE mutes — past + garbage filtered out, explicit-null + future kept', async ({
        request,
    }) => {
        const { token, headers } = await freshUser(request, 'mute-until');

        // A PAST timestamp is accepted verbatim on the WRITE — the API does NOT
        // reject already-expired mutes at write time (it's a resolution-time
        // concern). The POST echoes the raw stored value back.
        const pastIso = '2020-01-01T00:00:00.000Z';
        const past = await postMute(request, headers, {
            category: 'subscription',
            mutedUntil: pastIso,
        });
        expect(past.status()).toBe(201);
        expect((await past.json()).mute).toEqual({
            category: 'subscription',
            mutedUntil: pastIso,
        });

        // An unparseable mutedUntil string passes @IsString but the controller's
        // `body.mutedUntil ? new Date(body.mutedUntil) : null` yields an Invalid
        // Date (truthy string → new Date('garbage')) — never a 400. The POST echo
        // serializes that Invalid Date as null.
        const garbage = await postMute(request, headers, {
            category: 'system',
            mutedUntil: 'garbage-not-a-date',
        });
        expect(garbage.status()).toBe(201);
        expect((await garbage.json()).mute).toEqual({ category: 'system', mutedUntil: null });

        // An EXPLICIT null is the true indefinite mute (stored as SQL NULL).
        const indefinite = await postMute(request, headers, {
            category: 'agent',
            mutedUntil: null,
        });
        expect(indefinite.status()).toBe(201);
        expect((await indefinite.json()).mute).toEqual({ category: 'agent', mutedUntil: null });

        // A FUTURE expiry — an active, time-boxed mute.
        const futureIso = new Date(Date.now() + 2 * 24 * 3600 * 1000).toISOString();
        const future = await postMute(request, headers, {
            category: 'generation',
            mutedUntil: futureIso,
        });
        expect(future.status()).toBe(201);

        // The PREFERENCES VIEW returns only ACTIVE mutes — the repository gates on
        // `mutedUntil IS NULL OR mutedUntil > now` (findActiveByUser). So:
        //   - 'subscription' (PAST)  → FILTERED OUT (expired; the read gates where
        //                               the write does not).
        //   - 'system' (garbage→Invalid Date) → ALSO filtered out: an Invalid Date
        //                               is neither NULL nor > now, so it fails BOTH
        //                               active branches even though its POST echoed
        //                               null. (Coercion-of-garbage ≠ a real null.)
        //   - 'agent' (explicit null) → ACTIVE (true indefinite mute).
        //   - 'generation' (future)  → ACTIVE.
        const view = await getPreferences(request, token);
        const cats = view.mutes.map((m) => m.category);
        expect(cats, 'expired past mute is filtered out of the view').not.toContain('subscription');
        expect(cats, 'garbage→Invalid-Date mute is not an active mute').not.toContain('system');
        expect(cats, 'explicit-null is a true indefinite active mute').toContain('agent');
        expect(cats, 'future-dated mute is active').toContain('generation');

        const agentMute = view.mutes.find((m) => m.category === 'agent');
        const gen = view.mutes.find((m) => m.category === 'generation');
        expect(agentMute!.mutedUntil).toBeNull(); // indefinite
        expect(gen!.mutedUntil).toBeTruthy(); // future expiry retained
        expect(new Date(gen!.mutedUntil as string).getTime()).toBeGreaterThan(Date.now());
    });

    // ----------------------------------------------------------------------- //
    //  Unmute PATH-PARAM pipe gate (distinct from the body enum gate)          //
    // ----------------------------------------------------------------------- //

    test('unmute path-param is guarded by ParseEnumPipe with its OWN message; a valid enum returns 204 even when never muted', async ({
        request,
    }) => {
        const { token, headers } = await freshUser(request, 'unmute-pipe');

        // A non-enum path param is rejected by ParseEnumPipe — a DIFFERENT,
        // pipe-specific message than the MuteBody @IsEnum gate.
        const bad = await deleteMute(request, headers, 'not_a_category');
        expect(bad.status()).toBe(400);
        const badBody = await bad.json();
        expect(badBody.message).toBe('Validation failed (enum string is expected)');
        // Explicitly NOT the body-DTO enum message — the two gates are distinct.
        expect(badBody.message).not.toContain(MUTE_ENUM_MESSAGE);

        // A VALID enum value that was never muted still returns 204 (idempotent
        // delete — no row to remove, but a well-formed request).
        const neverMuted = await deleteMute(request, headers, 'security');
        expect(neverMuted.status()).toBe(204);

        // Full unmute lifecycle on a real mute: mute → unmute (204) → re-unmute
        // (still 204, idempotent), and the row is gone from the read.
        expect((await postMute(request, headers, { category: 'generation' })).status()).toBe(201);
        expect((await getPreferences(request, token)).mutes.map((m) => m.category)).toContain(
            'generation',
        );

        const first = await deleteMute(request, headers, 'generation');
        expect(first.status()).toBe(204);
        const again = await deleteMute(request, headers, 'generation');
        expect(again.status()).toBe(204);

        expect((await getPreferences(request, token)).mutes.map((m) => m.category)).not.toContain(
            'generation',
        );
    });

    // ----------------------------------------------------------------------- //
    //  PREFERENCE-record + MUTE isolation across users                         //
    // ----------------------------------------------------------------------- //

    test('one user’s quiet-hours window + category mutes never surface in another user’s preferences view', async ({
        request,
    }) => {
        const alice = await freshUser(request, 'iso-alice');
        const bob = await freshUser(request, 'iso-bob');

        // Alice sets a distinctive window + two mutes.
        expect(
            (
                await putQuietHours(request, alice.headers, {
                    quietHoursStart: '03:33',
                    quietHoursEnd: '04:44',
                    timezone: 'UTC',
                })
            ).status(),
        ).toBe(200);
        expect((await postMute(request, alice.headers, { category: 'ai_credits' })).status()).toBe(
            201,
        );
        expect((await postMute(request, alice.headers, { category: 'task' })).status()).toBe(201);

        // Alice's own view reflects all of it.
        const aliceView = await getPreferences(request, alice.token);
        expect(aliceView.preference).toMatchObject({
            quietHoursStart: '03:33',
            quietHoursEnd: '04:44',
        });
        expect(aliceView.mutes.map((m) => m.category).sort()).toEqual(['ai_credits', 'task']);

        // Bob — a brand-new, untouched user — sees a fully clean preferences view.
        // NONE of Alice's window or mutes bled across the user boundary.
        const bobView = await getPreferences(request, bob.token);
        expect(bobView.preference).toBeNull();
        expect(bobView.mutes).toEqual([]);
        expect(bobView.subscriptions).toEqual([]);

        // Bob muting his OWN 'ai_credits' is independent: it creates exactly one
        // row in his view and does not touch Alice's (still distinct objects).
        expect((await postMute(request, bob.headers, { category: 'ai_credits' })).status()).toBe(
            201,
        );
        const bobAfter = await getPreferences(request, bob.token);
        expect(bobAfter.mutes.map((m) => m.category)).toEqual(['ai_credits']);
        expect(bobAfter.preference).toBeNull(); // Bob never set a window.

        // Alice is wholly unaffected by Bob's mutation.
        const aliceAfter = await getPreferences(request, alice.token);
        expect(aliceAfter.preference).toMatchObject({ quietHoursStart: '03:33' });
        expect(aliceAfter.mutes.map((m) => m.category).sort()).toEqual(['ai_credits', 'task']);
    });

    // ----------------------------------------------------------------------- //
    //  Anonymous boundary on the WRITE routes                                  //
    // ----------------------------------------------------------------------- //

    test('mute, unmute, and quiet-hours WRITE routes are hard-401 for an anonymous caller (no validation reached)', async ({
        browser,
    }) => {
        // Empty storageState so the seeded auth cookie is NOT inherited.
        const anonCtx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
        const anon = anonCtx.request;
        try {
            // Even a WELL-FORMED body is 401 — auth runs before validation, so the
            // anon caller never learns whether the payload was valid.
            const mute = await anon.post(`${API_BASE}/api/notifications/preferences/mute`, {
                data: { category: 'system' },
            });
            expect(mute.status(), 'anon mute').toBe(401);

            // A MALFORMED body is ALSO 401 (not 400) — the guard short-circuits
            // before the ValidationPipe, so anon gets no validation feedback.
            const muteBad = await anon.post(`${API_BASE}/api/notifications/preferences/mute`, {
                data: { category: 'not_a_category' },
            });
            expect(muteBad.status(), 'anon mute (bad body)').toBe(401);

            const unmute = await anon.delete(
                `${API_BASE}/api/notifications/preferences/mute/system`,
            );
            expect(unmute.status(), 'anon unmute').toBe(401);

            const quiet = await anon.put(`${API_BASE}/api/notifications/preferences/quiet-hours`, {
                data: { quietHoursStart: '22:00', quietHoursEnd: '07:00', timezone: 'UTC' },
            });
            expect(quiet.status(), 'anon quiet-hours').toBe(401);

            // event-types catalogue is equally gated (no anonymous registry read).
            const events = await anon.get(`${API_BASE}/api/notifications/event-types`);
            expect(events.status(), 'anon event-types').toBe(401);
        } finally {
            await anonCtx.close();
        }
    });

    // ----------------------------------------------------------------------- //
    //  event-types catalogue shape + deterministic ordering                    //
    // ----------------------------------------------------------------------- //

    test('event-types catalogue returns the core registry sorted by (category, key) with the full per-entry shape', async ({
        request,
    }) => {
        const { token } = await freshUser(request, 'catalogue');
        const res = await request.get(`${API_BASE}/api/notifications/event-types`, {
            headers: authedHeaders(token),
            timeout: TIMEOUT,
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

        // Every core key is present (plugin-contributed events may ALSO appear —
        // assert membership, never an exact count).
        const keys = eventTypes.map((e) => e.key);
        const CORE = [
            'agent_run_finished',
            'ai_credits_depleted',
            'ai_provider_error',
            'generation_error',
            'schedule_paused',
            'work_generation_finished',
            'git_auth_expired',
            'mission_blocked',
        ];
        for (const k of CORE) expect(keys, `registry missing ${k}`).toContain(k);

        // Deterministic (category, key) ordering — assert it holds across the
        // whole returned array (each entry >= its predecessor by the tuple).
        const tuples = eventTypes.map((e) => `${e.category} ${e.key}`);
        const sorted = [...tuples].sort();
        expect(tuples).toEqual(sorted);

        // Per-entry shape on a representative core event (source/pluginId carried).
        const byKey = new Map(eventTypes.map((e) => [e.key, e]));
        const agent = byKey.get('agent_run_finished')!;
        expect(agent.category).toBe('agents');
        expect(agent.urgent).toBe(false);
        expect(agent.defaultChannels).toContain('in-app');
        expect(agent.source).toBe('core');
        expect(agent.pluginId).toBeNull();
        expect(typeof agent.title).toBe('string');
        expect(agent.title.length).toBeGreaterThan(0);
        expect(typeof agent.description).toBe('string');

        // The urgent flag is set correctly on the two urgent core producers.
        expect(byKey.get('ai_credits_depleted')!.urgent).toBe(true);
        expect(byKey.get('git_auth_expired')!.urgent).toBe(true);
    });

    test('a fresh user’s preferences view is the empty triple { subscriptions:[], preference:null, mutes:[] }', async ({
        request,
    }) => {
        const { token } = await freshUser(request, 'fresh');
        const view = await getPreferences(request, token);
        expect(view.subscriptions).toEqual([]);
        expect(view.preference).toBeNull();
        expect(view.mutes).toEqual([]);
    });

    test('GET /preferences and GET /event-types both 401 for an anonymous caller', async ({
        browser,
    }) => {
        const anonCtx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
        const anon = anonCtx.request;
        try {
            expect((await anon.get(`${API_BASE}/api/notifications/preferences`)).status()).toBe(
                401,
            );
            expect((await anon.get(`${API_BASE}/api/notifications/event-types`)).status()).toBe(
                401,
            );
        } finally {
            await anonCtx.close();
        }
    });
});
