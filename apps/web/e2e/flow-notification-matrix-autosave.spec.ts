import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';
import { loadSeededTestUser } from './helpers/seeded-test-user';

/**
 * Notification matrix (AW-13) — Settings -> Notifications saves as you go.
 *
 * Contracts exercised (apps/api/src/notifications/notification-matrix.controller.ts
 * and the existing notification-preferences.controller.ts, both on
 * `api/notifications`, AuthSessionGuard):
 *
 *   GET  /matrix        -> 200 NotificationMatrixDto (events, columns, quiet hours,
 *                          mutes, email availability, limits). Cache-Control: private, no-store.
 *   POST /matrix/reset  -> 200 { changed } — drops the caller's stored choices.
 *   PUT  /matrix/event/:key { channelIds } -> 200 — the per-switch write the page uses; stores
 *                          the choice with the matrix marker. `email` is a built-in target,
 *                          `[]` is an explicit "nothing".
 *   PUT  /preferences/event/:key { channelIds } -> 200 — the pre-existing per-event write (API
 *                          callers, chat assistant). Unchanged meaning: an empty list follows the
 *                          defaults and the notification keeps reaching the bell.
 *   PUT  /preferences/quiet-hours { ..., urgentBypassesQuietHours? } -> 200 — the opt-in to let
 *                          every urgent event through quiet hours; omitted keeps what is stored.
 *
 * API flows run on FRESH registered users. The UI flow drives the seeded
 * (storageState) user and restores its choices in `finally`, so sibling specs
 * that read the seeded settings page see it unchanged.
 */

const TIMEOUT = 20_000;

interface MatrixEvent {
    key: string;
    group: string;
    urgent: boolean;
    inAppLocked: boolean;
    selectedTargets: string[];
    defaultTargets: string[];
    explicit: boolean;
}

interface Matrix {
    events: MatrixEvent[];
    columns: Array<{ id: string; kind: string }>;
    limits: { maxTargets: number; maxColumns: number };
    quietHours: {
        start: string | null;
        end: string | null;
        timezone: string | null;
        urgentBypassesQuietHours?: boolean;
    };
}

async function getMatrix(request: APIRequestContext, token: string): Promise<Matrix> {
    const res = await request.get(`${API_BASE}/api/notifications/matrix`, {
        headers: authedHeaders(token),
        timeout: TIMEOUT,
    });
    expect(res.status()).toBe(200);
    expect(res.headers()['cache-control']).toContain('no-store');
    return (await res.json()) as Matrix;
}

/** The per-switch write the matrix page uses. */
function saveMatrixRow(
    request: APIRequestContext,
    token: string,
    key: string,
    channelIds: string[],
) {
    return request.put(`${API_BASE}/api/notifications/matrix/event/${key}`, {
        headers: authedHeaders(token),
        data: { channelIds },
        timeout: TIMEOUT,
    });
}

/** The pre-existing per-event write (API callers, chat assistant). */
function savePerEventPreference(
    request: APIRequestContext,
    token: string,
    key: string,
    channelIds: string[],
) {
    return request.put(`${API_BASE}/api/notifications/preferences/event/${key}`, {
        headers: authedHeaders(token),
        data: { channelIds },
        timeout: TIMEOUT,
    });
}

function eventOf(matrix: Matrix, key: string): MatrixEvent {
    const found = matrix.events.find((e) => e.key === key);
    expect(found, `matrix has ${key}`).toBeTruthy();
    return found!;
}

test.describe('Notification matrix — autosave, explicit nothing, reset', () => {
    test('the matrix is one authenticated read with every core event grouped and the built-in columns first', async ({
        request,
    }) => {
        const unauth = await request.get(`${API_BASE}/api/notifications/matrix`, {
            timeout: TIMEOUT,
        });
        expect(unauth.status()).toBe(401);

        const user = await registerUserViaAPI(request);
        const matrix = await getMatrix(request, user.access_token);

        expect(matrix.events.length).toBeGreaterThanOrEqual(23);
        expect(matrix.columns.slice(0, 2).map((c) => c.id)).toEqual(['in-app', 'email']);
        expect(matrix.limits).toEqual({ maxTargets: 20, maxColumns: 6 });

        expect(eventOf(matrix, 'agent_run_escalated')).toMatchObject({
            group: 'needsYou',
            urgent: true,
            explicit: false,
            selectedTargets: ['in-app', 'email'],
        });
        expect(eventOf(matrix, 'agent_run_finished').group).toBe('routine');
        expect(eventOf(matrix, 'digest_ready').group).toBe('digest');
        // Every event still reaches the bell by default.
        for (const event of matrix.events) {
            expect(event.selectedTargets, `${event.key} keeps in-app by default`).toContain(
                'in-app',
            );
        }
    });

    test('a saved choice survives a re-read; an explicit "nothing" stays nothing; reset restores the defaults', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        const emailOn = await saveMatrixRow(request, token, 'generation_error', [
            'in-app',
            'email',
        ]);
        expect(emailOn.status()).toBe(200);
        expect((await emailOn.json()).subscription).toMatchObject({
            eventTypeKey: 'generation_error',
            channelIds: ['in-app', 'email'],
            origin: 'matrix',
        });

        const nothing = await saveMatrixRow(request, token, 'agent_run_escalated', []);
        expect(nothing.status()).toBe(200);

        const afterSave = await getMatrix(request, token);
        expect(eventOf(afterSave, 'generation_error')).toMatchObject({
            explicit: true,
            selectedTargets: ['in-app', 'email'],
        });
        // The explicit "nothing" does not fall back to the shipped defaults.
        expect(eventOf(afterSave, 'agent_run_escalated')).toMatchObject({
            explicit: true,
            selectedTargets: [],
        });

        const reset = await request.post(`${API_BASE}/api/notifications/matrix/reset`, {
            headers: authedHeaders(token),
            data: {},
            timeout: TIMEOUT,
        });
        expect(reset.status()).toBe(200);
        expect((await reset.json()).changed).toBe(2);

        const afterReset = await getMatrix(request, token);
        expect(eventOf(afterReset, 'generation_error')).toMatchObject({
            explicit: false,
            selectedTargets: ['in-app'],
        });
        expect(eventOf(afterReset, 'agent_run_escalated')).toMatchObject({
            explicit: false,
            selectedTargets: ['in-app', 'email'],
        });
    });

    test('reset is scoped to the caller: another user’s choices are untouched', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const other = await registerUserViaAPI(request);

        const saved = await saveMatrixRow(request, owner.access_token, 'schedule_paused', [
            'email',
        ]);
        expect(saved.status()).toBe(200);

        const otherReset = await request.post(`${API_BASE}/api/notifications/matrix/reset`, {
            headers: authedHeaders(other.access_token),
            data: { eventKeys: ['schedule_paused'] },
            timeout: TIMEOUT,
        });
        expect(otherReset.status()).toBe(200);
        expect((await otherReset.json()).changed).toBe(0);

        expect(
            eventOf(await getMatrix(request, owner.access_token), 'schedule_paused'),
        ).toMatchObject({
            explicit: true,
            selectedTargets: ['email'],
        });
    });

    test('a choice written through the per-event preferences API keeps its original meaning: an empty one follows the defaults, and in-app stays on', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        const empty = await savePerEventPreference(request, token, 'agent_run_escalated', []);
        expect(empty.status()).toBe(200);
        const emptyRow = (await empty.json()).subscription;
        expect(emptyRow.channelIds).toEqual([]);
        expect(emptyRow.origin ?? null).toBeNull();

        const withoutInApp = await savePerEventPreference(request, token, 'generation_error', [
            'email',
        ]);
        expect(withoutInApp.status()).toBe(200);

        const matrix = await getMatrix(request, token);
        // Stored, so a reset still counts it — but it behaves as before.
        expect(eventOf(matrix, 'agent_run_escalated')).toMatchObject({
            explicit: true,
            selectedTargets: ['in-app', 'email'],
        });
        expect(eventOf(matrix, 'generation_error')).toMatchObject({
            explicit: true,
            selectedTargets: ['in-app', 'email'],
        });

        // The same list saved from the matrix is taken literally…
        expect((await saveMatrixRow(request, token, 'generation_error', ['email'])).status()).toBe(
            200,
        );
        expect(
            eventOf(await getMatrix(request, token), 'generation_error').selectedTargets,
        ).toEqual(['email']);

        // …and a later write through the per-event API replaces the marker too.
        expect(
            (await savePerEventPreference(request, token, 'generation_error', ['email'])).status(),
        ).toBe(200);
        expect(
            eventOf(await getMatrix(request, token), 'generation_error').selectedTargets,
        ).toEqual(['in-app', 'email']);
    });

    test('the matrix row write is authenticated and validated like the per-event write', async ({
        request,
    }) => {
        const unauth = await request.put(
            `${API_BASE}/api/notifications/matrix/event/generation_error`,
            { data: { channelIds: [] }, timeout: TIMEOUT },
        );
        expect(unauth.status()).toBe(401);

        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const bogus = '00000000-0000-4000-8000-000000000000';

        const foreign = await saveMatrixRow(request, token, 'generation_error', [bogus]);
        expect(foreign.status()).toBe(400);
        expect((await foreign.json()).message).toBe(
            `Unknown or unauthorized notification channel: ${bogus}`,
        );

        const unknownEvent = await saveMatrixRow(request, token, 'totally_made_up_event', []);
        expect(unknownEvent.status()).toBe(400);
        expect((await unknownEvent.json()).message).toBe(
            'Unknown notification event type: totally_made_up_event',
        );

        const notAList = await request.put(
            `${API_BASE}/api/notifications/matrix/event/generation_error`,
            { headers: authedHeaders(token), data: { channelIds: 'email' }, timeout: TIMEOUT },
        );
        expect(notAList.status()).toBe(400);

        // Nothing was stored by the refused writes.
        expect(eventOf(await getMatrix(request, token), 'generation_error').explicit).toBe(false);
    });

    test('quiet hours: letting every urgent event through is an opt-in, off by default, kept across window changes', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const QH = `${API_BASE}/api/notifications/preferences/quiet-hours`;

        expect((await getMatrix(request, token)).quietHours.urgentBypassesQuietHours).toBe(false);

        const window = await request.put(QH, {
            headers: authedHeaders(token),
            data: { quietHoursStart: '22:00', quietHoursEnd: '07:00', timezone: 'UTC' },
            timeout: TIMEOUT,
        });
        expect(window.status()).toBe(200);
        expect((await window.json()).preference.urgentBypassesQuietHours).toBe(false);

        const optIn = await request.put(QH, {
            headers: authedHeaders(token),
            data: {
                quietHoursStart: '22:00',
                quietHoursEnd: '07:00',
                timezone: 'UTC',
                urgentBypassesQuietHours: true,
            },
            timeout: TIMEOUT,
        });
        expect(optIn.status()).toBe(200);
        expect((await getMatrix(request, token)).quietHours).toMatchObject({
            start: '22:00',
            end: '07:00',
            urgentBypassesQuietHours: true,
        });

        // A caller that only knows about the window never flips the opt-in.
        const moved = await request.put(QH, {
            headers: authedHeaders(token),
            data: { quietHoursStart: '23:00', quietHoursEnd: '06:00', timezone: 'UTC' },
            timeout: TIMEOUT,
        });
        expect(moved.status()).toBe(200);
        expect((await moved.json()).preference).toMatchObject({
            quietHoursStart: '23:00',
            urgentBypassesQuietHours: true,
        });

        const invalid = await request.put(QH, {
            headers: authedHeaders(token),
            data: { urgentBypassesQuietHours: 'yes' },
            timeout: TIMEOUT,
        });
        expect(invalid.status()).toBe(400);
    });

    test('toggling a switch on the page saves without a Save button and survives a reload', async ({
        page,
        request,
        baseURL,
    }) => {
        const seeded = loadSeededTestUser();
        const login = await request.post(`${API_BASE}/api/auth/login`, {
            data: { email: seeded.email, password: seeded.password },
            timeout: TIMEOUT,
        });
        expect(login.status()).toBe(200);
        const { access_token: token } = await login.json();
        const origin = baseURL ?? 'http://localhost:3000';

        // Start from the recommended defaults for the row this test drives.
        await request.post(`${API_BASE}/api/notifications/matrix/reset`, {
            headers: authedHeaders(token),
            data: { eventKeys: ['schedule_paused'] },
            timeout: TIMEOUT,
        });

        try {
            await page.context().addCookies([
                { name: 'sidebar-collapsed', value: '0', url: origin },
                { name: 'chat-panel-open', value: '0', url: origin },
            ]);
            await page.goto(`${origin}/settings/notifications`, { waitUntil: 'domcontentloaded' });
            await expect(
                page.getByRole('heading', { name: 'Notification Preferences', level: 1 }),
            ).toBeVisible({
                timeout: 30_000,
            });

            const inApp = page.getByRole('checkbox', { name: 'Schedule paused → In-app' });
            await expect(inApp).toBeVisible({ timeout: 30_000 });
            await expect(inApp).toHaveAttribute('aria-checked', 'true');
            // No Save button anywhere on the matrix.
            await expect(page.getByRole('button', { name: /^save$/i })).toHaveCount(0);

            const saved = page.waitForResponse(
                (res) =>
                    res.request().method() === 'POST' &&
                    res.url().includes('/settings/notifications') &&
                    res.status() === 200,
                { timeout: TIMEOUT },
            );
            await inApp.click();
            await expect(inApp).toHaveAttribute('aria-checked', 'false');
            await saved;
            await expect(page.getByText('Saved').first()).toBeVisible({ timeout: TIMEOUT });

            await expect
                .poll(
                    async () =>
                        eventOf(await getMatrix(request, token), 'schedule_paused').selectedTargets,
                    {
                        timeout: TIMEOUT,
                    },
                )
                .toEqual([]);

            await page.reload({ waitUntil: 'domcontentloaded' });
            await expect(
                page.getByRole('checkbox', { name: 'Schedule paused → In-app' }),
            ).toHaveAttribute('aria-checked', 'false', { timeout: 30_000 });
        } finally {
            await request
                .post(`${API_BASE}/api/notifications/matrix/reset`, {
                    headers: authedHeaders(token),
                    data: { eventKeys: ['schedule_paused'] },
                    timeout: TIMEOUT,
                })
                .catch(() => undefined);
        }
    });
});
