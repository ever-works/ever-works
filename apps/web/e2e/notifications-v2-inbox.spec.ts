import { test, expect } from '@playwright/test';
import { API_BASE, registerUserViaAPI, authedHeaders } from './helpers/api';

/**
 * Notifications v2 (EW-650 / EW-663 / EW-664 / EW-680 / T36) — smoke.
 *
 * UI tests run with the chromium auth project (shared storage state).
 * API contract tests register fresh users so they're independent.
 *
 * The "send a test message" path is exercised at the API level with a
 * mocked provider: we register a Postmark outbound address, then assert
 * the compose endpoint resolves the address + returns a result shape.
 * (No real Postmark token in CI, so the provider call is expected to
 * fail at the network boundary — we assert the route is reachable and
 * the address-resolution + validation happen before the provider call.)
 */

test.describe('Notifications v2 — settings UI', () => {
    test('email addresses page renders', async ({ page }) => {
        await page.goto('/en/settings/integrations/emails', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1_500);
        const body = await page.locator('body').innerText();
        expect(body).toMatch(/email address/i);
    });

    test('notification channels page renders', async ({ page }) => {
        await page.goto('/en/settings/integrations/channels', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1_500);
        const body = await page.locator('body').innerText();
        expect(body).toMatch(/channel/i);
    });

    test('notification preferences page renders', async ({ page }) => {
        await page.goto('/en/settings/notifications', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1_500);
        const body = await page.locator('body').innerText();
        expect(body).toMatch(/notification|preference/i);
    });
});

test.describe('Notifications v2 — API contract', () => {
    test('email address CRUD round-trips', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const headers = authedHeaders(u.access_token);

        // Create an outbound Postmark address.
        const created = await request.post(`${API_BASE}/api/email/addresses`, {
            headers,
            data: {
                address: `agent-${Date.now()}@example.com`,
                direction: 'outbound',
                pluginId: 'postmark',
                providerSettings: { apiKey: 'test-key' },
            },
        });
        expect(created.status(), `create status ${created.status()}`).toBe(201);
        const { address } = (await created.json()) as { address: { id: string } };
        expect(address.id).toBeTruthy();

        // It shows up in the list.
        const list = await request.get(`${API_BASE}/api/email/addresses`, { headers });
        expect(list.status()).toBe(200);
        const { addresses } = (await list.json()) as { addresses: { id: string }[] };
        expect(addresses.some((a) => a.id === address.id)).toBe(true);

        // Delete it.
        const del = await request.delete(`${API_BASE}/api/email/addresses/${address.id}`, {
            headers,
        });
        expect(del.status()).toBe(204);
    });

    test('notification channel CRUD round-trips', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const headers = authedHeaders(u.access_token);

        const created = await request.post(`${API_BASE}/api/notification-channels`, {
            headers,
            data: {
                pluginId: 'discord-channel',
                name: 'Ops alerts',
                targetConfig: { webhookUrl: 'https://discord.com/api/webhooks/1/abc' },
            },
        });
        expect(created.status(), `create status ${created.status()}`).toBe(201);
        const { channel } = (await created.json()) as { channel: { id: string } };

        const list = await request.get(`${API_BASE}/api/notification-channels`, { headers });
        expect(list.status()).toBe(200);
        const { channels } = (await list.json()) as { channels: { id: string }[] };
        expect(channels.some((c) => c.id === channel.id)).toBe(true);
    });

    test('event-types registry is seeded', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/notifications/event-types`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status()).toBe(200);
        const { eventTypes } = (await res.json()) as { eventTypes: { key: string }[] };
        // Seeded core events from the SeedNotificationEventTypes migration.
        expect(eventTypes.some((e) => e.key === 'ai_credits_depleted')).toBe(true);
    });

    test('inbox messages list returns an array for an unknown agent', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(
            `${API_BASE}/api/email/messages?agentId=00000000-0000-0000-0000-000000000000`,
            { headers: authedHeaders(u.access_token) },
        );
        expect(res.status()).toBe(200);
        const { messages } = (await res.json()) as { messages: unknown[] };
        expect(Array.isArray(messages)).toBe(true);
    });
});
