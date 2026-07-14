// EW-663 / EW-679 — regression spec for the notification-channels API
// wrapper. Guards the endpoint URL shape against the `/api/api/...`
// double-prefix bug: `serverFetch` / `serverMutation` prepend `API_URL`
// (normalised to end in `/api`), so endpoints must NOT start with `/api`.

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
    return import('./notification-channels');
}

beforeEach(() => {
    serverFetchMock.mockReset();
    serverMutationMock.mockReset();
    serverFetchMock.mockResolvedValue({ channels: [] });
    serverMutationMock.mockResolvedValue({ channel: {} });
});
afterEach(() => vi.resetModules());

describe('notificationChannelsAPI — endpoint URL shape (no /api double-prefix)', () => {
    it('list GETs /notification-channels', async () => {
        const { notificationChannelsAPI } = await importApi();
        await notificationChannelsAPI.list();
        expect(serverFetchMock).toHaveBeenCalledWith('/notification-channels');
    });

    it('create POSTs /notification-channels', async () => {
        const { notificationChannelsAPI } = await importApi();
        await notificationChannelsAPI.create({ pluginId: 'p', name: 'n', targetConfig: {} });
        expect(serverMutationMock).toHaveBeenCalledWith(
            expect.objectContaining({ method: 'POST', endpoint: '/notification-channels' }),
        );
    });

    it('update PATCHes /notification-channels/:id', async () => {
        const { notificationChannelsAPI } = await importApi();
        await notificationChannelsAPI.update('ch-1', { name: 'n2' });
        expect(serverMutationMock).toHaveBeenCalledWith(
            expect.objectContaining({ method: 'PATCH', endpoint: '/notification-channels/ch-1' }),
        );
    });

    it('remove DELETEs /notification-channels/:id', async () => {
        const { notificationChannelsAPI } = await importApi();
        await notificationChannelsAPI.remove('ch-1');
        expect(serverMutationMock).toHaveBeenCalledWith(
            expect.objectContaining({ method: 'DELETE', endpoint: '/notification-channels/ch-1' }),
        );
    });

    it('sendTest POSTs /notification-channels/:id/test', async () => {
        const { notificationChannelsAPI } = await importApi();
        await notificationChannelsAPI.sendTest('ch-1');
        expect(serverMutationMock).toHaveBeenCalledWith(
            expect.objectContaining({ endpoint: '/notification-channels/ch-1/test' }),
        );
    });

    it('NONE of the methods ever passes an endpoint starting with /api', async () => {
        const { notificationChannelsAPI } = await importApi();
        await Promise.all([
            notificationChannelsAPI.list(),
            notificationChannelsAPI.create({ pluginId: 'p', name: 'n', targetConfig: {} }),
            notificationChannelsAPI.update('id', { name: 'n' }),
            notificationChannelsAPI.remove('id'),
            notificationChannelsAPI.sendTest('id'),
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
