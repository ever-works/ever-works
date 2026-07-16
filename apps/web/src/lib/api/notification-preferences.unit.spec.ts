// EW-664 / EW-679 — regression spec for the notification-preferences API
// wrapper. Pins the endpoint URL shape so the `/api/api/...` double-prefix
// bug can never come back: `serverFetch` / `serverMutation` prepend
// `API_URL` (normalised to end in `/api`), so every endpoint here MUST be
// relative to `/api` — it must NOT start with `/api`.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { serverFetchMock, serverMutationMock } = vi.hoisted(() => ({
    serverFetchMock: vi.fn(),
    serverMutationMock: vi.fn(),
}));

vi.mock('./server-api', () => ({
    serverFetch: serverFetchMock,
    serverMutation: serverMutationMock,
}));

async function importApi() {
    return import('./notification-preferences');
}

beforeEach(() => {
    serverFetchMock.mockReset();
    serverMutationMock.mockReset();
    serverFetchMock.mockResolvedValue({ eventTypes: [] });
    serverMutationMock.mockResolvedValue({});
});
afterEach(() => vi.resetModules());

describe('notificationPreferencesAPI — endpoint URL shape (no /api double-prefix)', () => {
    it('listEventTypes GETs /notifications/event-types', async () => {
        const { notificationPreferencesAPI } = await importApi();
        await notificationPreferencesAPI.listEventTypes();
        expect(serverFetchMock).toHaveBeenCalledWith('/notifications/event-types');
    });

    it('getPreferences GETs /notifications/preferences', async () => {
        const { notificationPreferencesAPI } = await importApi();
        await notificationPreferencesAPI.getPreferences();
        expect(serverFetchMock).toHaveBeenCalledWith('/notifications/preferences');
    });

    it('setEventSubscription PUTs /notifications/preferences/event/:key', async () => {
        const { notificationPreferencesAPI } = await importApi();
        await notificationPreferencesAPI.setEventSubscription('work.completed', ['c1']);
        expect(serverMutationMock).toHaveBeenCalledWith(
            expect.objectContaining({
                method: 'PUT',
                endpoint: '/notifications/preferences/event/work.completed',
                data: { channelIds: ['c1'] },
                wrapInData: false,
            }),
        );
    });

    it('setQuietHours PUTs /notifications/preferences/quiet-hours', async () => {
        const { notificationPreferencesAPI } = await importApi();
        await notificationPreferencesAPI.setQuietHours({
            quietHoursStart: null,
            quietHoursEnd: null,
            timezone: null,
        });
        expect(serverMutationMock).toHaveBeenCalledWith(
            expect.objectContaining({ endpoint: '/notifications/preferences/quiet-hours' }),
        );
    });

    it('muteCategory POSTs /notifications/preferences/mute', async () => {
        const { notificationPreferencesAPI } = await importApi();
        await notificationPreferencesAPI.muteCategory('billing', null);
        expect(serverMutationMock).toHaveBeenCalledWith(
            expect.objectContaining({ endpoint: '/notifications/preferences/mute' }),
        );
    });

    it('unmuteCategory DELETEs /notifications/preferences/mute/:category', async () => {
        const { notificationPreferencesAPI } = await importApi();
        await notificationPreferencesAPI.unmuteCategory('billing');
        expect(serverMutationMock).toHaveBeenCalledWith(
            expect.objectContaining({ endpoint: '/notifications/preferences/mute/billing' }),
        );
    });

    it('NONE of the methods ever passes an endpoint starting with /api', async () => {
        const { notificationPreferencesAPI } = await importApi();
        await Promise.all([
            notificationPreferencesAPI.listEventTypes(),
            notificationPreferencesAPI.getPreferences(),
            notificationPreferencesAPI.setEventSubscription('e', ['c']),
            notificationPreferencesAPI.setQuietHours({
                quietHoursStart: null,
                quietHoursEnd: null,
                timezone: null,
            }),
            notificationPreferencesAPI.muteCategory('c', null),
            notificationPreferencesAPI.unmuteCategory('c'),
        ]);

        const fetchEndpoints = serverFetchMock.mock.calls.map((c) => c[0] as string);
        const mutationEndpoints = serverMutationMock.mock.calls.map(
            (c) => (c[0] as { endpoint: string }).endpoint,
        );
        for (const endpoint of [...fetchEndpoints, ...mutationEndpoints]) {
            expect(endpoint.startsWith('/api')).toBe(false);
            expect(endpoint).not.toContain('/api/');
        }
    });
});
