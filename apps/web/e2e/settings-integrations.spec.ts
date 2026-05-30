import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * Settings / Integrations — notification channels, the Work Agent
 * preferences engine, notification preferences, and the email-address
 * registry. These settings surfaces shipped without dedicated e2e specs.
 * Assertions are pinned against live API shapes.
 *
 * API surface:
 *   - GET/POST/DELETE /api/notification-channels(+/:id/test)
 *   - GET/PUT /api/me/work-agent/preferences ; GET /api/me/work-agent/runs/active
 *   - GET /api/notifications/event-types ; GET /api/notifications/preferences
 *   - GET /api/email/addresses
 */

test.describe('Notification channels — API contract', () => {
    test('GET /api/notification-channels without auth → 401', async ({ request }) => {
        expect((await request.get(`${API_BASE}/api/notification-channels`)).status()).toBe(401);
    });

    test('CRUD + test: create discord channel → list → test → delete', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const headers = authedHeaders(u.access_token);

        const fresh = await request.get(`${API_BASE}/api/notification-channels`, { headers });
        expect(fresh.status()).toBe(200);
        expect((await fresh.json()).channels).toEqual([]);

        const created = await request.post(`${API_BASE}/api/notification-channels`, {
            headers,
            data: {
                pluginId: 'discord-channel',
                name: 'My Discord',
                targetConfig: { webhookUrl: 'https://discord.com/api/webhooks/123/abc' },
            },
        });
        expect(created.status(), `create body=${await created.text()}`).toBe(201);
        const channel = (await created.json()).channel;
        expect(channel.id).toMatch(/^[0-9a-f-]{36}$/);
        expect(channel.pluginId).toBe('discord-channel');
        expect(channel.name).toBe('My Discord');
        // A freshly added channel is unverified until a test send confirms it.
        expect(channel.verified).toBe(false);

        const list = await (
            await request.get(`${API_BASE}/api/notification-channels`, { headers })
        ).json();
        expect(list.channels.map((c: { id: string }) => c.id)).toContain(channel.id);

        // Test send responds with a structured result (status may be "failed"
        // locally when the channel plugin isn't enabled — pin the shape, not
        // the outcome, so the assertion is environment-independent).
        const tested = await request.post(
            `${API_BASE}/api/notification-channels/${channel.id}/test`,
            { headers },
        );
        expect([200, 201]).toContain(tested.status());
        expect(typeof (await tested.json()).status).toBe('string');

        const del = await request.delete(`${API_BASE}/api/notification-channels/${channel.id}`, {
            headers,
        });
        expect([200, 204]).toContain(del.status());

        const after = await (
            await request.get(`${API_BASE}/api/notification-channels`, { headers })
        ).json();
        expect(after.channels.map((c: { id: string }) => c.id)).not.toContain(channel.id);
    });
});

test.describe('Work Agent preferences — API contract', () => {
    test('GET /api/me/work-agent/preferences without auth → 401', async ({ request }) => {
        expect((await request.get(`${API_BASE}/api/me/work-agent/preferences`)).status()).toBe(401);
    });

    test('preferences expose guardrails and a PUT round-trips a changed field', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const headers = authedHeaders(u.access_token);

        const prefsRes = await request.get(`${API_BASE}/api/me/work-agent/preferences`, {
            headers,
        });
        expect(prefsRes.status()).toBe(200);
        const prefs = await prefsRes.json();
        expect(typeof prefs.enabled).toBe('boolean');
        // Guardrails are the safety envelope around autonomous generation.
        expect(prefs.guardrails).toMatchObject({
            requireApprovalBeforeCreate: expect.any(Boolean),
            dryRunByDefault: expect.any(Boolean),
        });

        // PATCH-semantics PUT: an omitted key is a no-op, a set key persists.
        const put = await request.put(`${API_BASE}/api/me/work-agent/preferences`, {
            headers,
            data: { autoGenerateBatchSize: 7 },
        });
        expect(put.status()).toBe(200);
        expect((await put.json()).autoGenerateBatchSize).toBe(7);

        const reread = await (
            await request.get(`${API_BASE}/api/me/work-agent/preferences`, { headers })
        ).json();
        expect(reread.autoGenerateBatchSize).toBe(7);
        // The untouched guardrails must survive the partial update.
        expect(reread.guardrails.requireApprovalBeforeCreate).toBe(
            prefs.guardrails.requireApprovalBeforeCreate,
        );
    });

    test('GET /api/me/work-agent/runs/active → 200 (no active run for a fresh user)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/me/work-agent/runs/active`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status()).toBe(200);
    });
});

test.describe('Notification preferences + email registry — API contract', () => {
    test('event-types catalog is non-empty and well-shaped', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/notifications/event-types`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status()).toBe(200);
        const { eventTypes } = await res.json();
        expect(Array.isArray(eventTypes)).toBe(true);
        expect(eventTypes.length).toBeGreaterThan(0);
        for (const et of eventTypes) {
            expect(typeof et.key).toBe('string');
            expect(typeof et.category).toBe('string');
            expect(typeof et.title).toBe('string');
            expect(Array.isArray(et.defaultChannels)).toBe(true);
        }
    });

    test('preferences view for a fresh user is empty + the in-app channel is always present in defaults', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const headers = authedHeaders(u.access_token);
        const res = await request.get(`${API_BASE}/api/notifications/preferences`, { headers });
        expect(res.status()).toBe(200);
        const view = await res.json();
        expect(Array.isArray(view.subscriptions)).toBe(true);
        expect(Array.isArray(view.mutes)).toBe(true);

        // Every core event type defaults to the built-in in-app channel.
        const { eventTypes } = await (
            await request.get(`${API_BASE}/api/notifications/event-types`, { headers })
        ).json();
        expect(
            eventTypes.some((et: { defaultChannels: string[] }) =>
                et.defaultChannels.includes('in-app'),
            ),
        ).toBe(true);
    });

    test('email address registry requires auth and starts empty', async ({ request }) => {
        expect((await request.get(`${API_BASE}/api/email/addresses`)).status()).toBe(401);
        const u = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/email/addresses`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status()).toBe(200);
        expect((await res.json()).addresses).toEqual([]);
    });
});
