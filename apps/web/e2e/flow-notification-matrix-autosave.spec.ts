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
 *   PUT  /preferences/event/:key { channelIds } -> 200 — the per-switch write the page uses;
 *                          `email` is a built-in target, `[]` is an explicit "nothing".
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

        const emailOn = await request.put(
            `${API_BASE}/api/notifications/preferences/event/generation_error`,
            {
                headers: authedHeaders(token),
                data: { channelIds: ['in-app', 'email'] },
                timeout: TIMEOUT,
            },
        );
        expect(emailOn.status()).toBe(200);

        const nothing = await request.put(
            `${API_BASE}/api/notifications/preferences/event/agent_run_escalated`,
            { headers: authedHeaders(token), data: { channelIds: [] }, timeout: TIMEOUT },
        );
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

        const saved = await request.put(
            `${API_BASE}/api/notifications/preferences/event/schedule_paused`,
            {
                headers: authedHeaders(owner.access_token),
                data: { channelIds: ['email'] },
                timeout: TIMEOUT,
            },
        );
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
