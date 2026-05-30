import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * Notifications v2 — preference engine: per-event channel subscriptions,
 * channel disable, category mutes, and quiet hours. These persistence
 * round-trips had no dedicated coverage. Pinned to live API shapes.
 *
 * API surface:
 *   - PUT  /api/notifications/preferences/event/:eventKey  { channelIds }
 *   - GET  /api/notifications/preferences                  { subscriptions, preference, mutes }
 *   - PATCH /api/notification-channels/:id                 { disabled }
 *   - POST/DELETE /api/notifications/preferences/mute      { category }
 *   - PUT  /api/notifications/preferences/quiet-hours      { start, end, timezone }
 */

async function setup(request: import('@playwright/test').APIRequestContext) {
    const u = await registerUserViaAPI(request);
    const headers = authedHeaders(u.access_token);
    const channel = (
        await (
            await request.post(`${API_BASE}/api/notification-channels`, {
                headers,
                data: {
                    pluginId: 'discord-channel',
                    name: 'D',
                    targetConfig: { webhookUrl: 'https://discord.com/api/webhooks/1/a' },
                },
            })
        ).json()
    ).channel;
    const eventTypes = (
        await (await request.get(`${API_BASE}/api/notifications/event-types`, { headers })).json()
    ).eventTypes;
    return { headers, channel, eventTypes };
}

test.describe('Notifications v2 — preferences', () => {
    test('GET /api/notifications/preferences without auth → 401', async ({ request }) => {
        expect((await request.get(`${API_BASE}/api/notifications/preferences`)).status()).toBe(401);
    });

    test('subscribe an event to a channel round-trips into the preferences view', async ({
        request,
    }) => {
        const { headers, channel, eventTypes } = await setup(request);
        const eventKey = eventTypes[0].key;

        const put = await request.put(
            `${API_BASE}/api/notifications/preferences/event/${eventKey}`,
            {
                headers,
                data: { channelIds: [channel.id] },
            },
        );
        expect(put.status(), `subscribe body=${await put.text()}`).toBe(200);
        const sub = (await put.json()).subscription;
        expect(sub.eventTypeKey).toBe(eventKey);
        expect(sub.channelIds).toContain(channel.id);

        const view = await (
            await request.get(`${API_BASE}/api/notifications/preferences`, { headers })
        ).json();
        const found = view.subscriptions.find(
            (s: { eventTypeKey: string }) => s.eventTypeKey === eventKey,
        );
        expect(found).toBeTruthy();
        expect(found.channelIds).toContain(channel.id);
    });

    test('disabling a channel stamps disabledAt', async ({ request }) => {
        const { headers, channel } = await setup(request);
        const res = await request.patch(`${API_BASE}/api/notification-channels/${channel.id}`, {
            headers,
            data: { disabled: true },
        });
        expect(res.status()).toBe(200);
        const updated = (await res.json()).channel;
        expect(updated.id).toBe(channel.id);
        expect(updated.disabledAt).not.toBeNull();
    });

    test('muting a category appears in the preferences view, and unmuting clears it', async ({
        request,
    }) => {
        const { headers, eventTypes } = await setup(request);
        const category = eventTypes[0].category;

        const muted = await request.post(`${API_BASE}/api/notifications/preferences/mute`, {
            headers,
            data: { category },
        });
        expect(muted.status()).toBe(201);
        expect((await muted.json()).mute.category).toBe(category);

        const afterMute = await (
            await request.get(`${API_BASE}/api/notifications/preferences`, { headers })
        ).json();
        expect(afterMute.mutes.some((m: { category: string }) => m.category === category)).toBe(
            true,
        );

        const unmute = await request.delete(
            `${API_BASE}/api/notifications/preferences/mute/${category}`,
            { headers },
        );
        expect([200, 204]).toContain(unmute.status());

        const afterUnmute = await (
            await request.get(`${API_BASE}/api/notifications/preferences`, { headers })
        ).json();
        expect(afterUnmute.mutes.some((m: { category: string }) => m.category === category)).toBe(
            false,
        );
    });

    test('quiet hours persist into the preference record', async ({ request }) => {
        const { headers } = await setup(request);
        const put = await request.put(`${API_BASE}/api/notifications/preferences/quiet-hours`, {
            headers,
            data: { quietHoursStart: '22:00', quietHoursEnd: '07:00', timezone: 'UTC' },
        });
        expect(put.status()).toBe(200);
        expect((await put.json()).preference).toMatchObject({
            quietHoursStart: '22:00',
            quietHoursEnd: '07:00',
            timezone: 'UTC',
        });

        const view = await (
            await request.get(`${API_BASE}/api/notifications/preferences`, { headers })
        ).json();
        expect(view.preference).toMatchObject({ quietHoursStart: '22:00', quietHoursEnd: '07:00' });
    });
});
