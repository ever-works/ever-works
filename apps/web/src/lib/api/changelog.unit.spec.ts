import { beforeEach, describe, expect, it, vi } from 'vitest';

const serverFetch = vi.fn();
const serverMutation = vi.fn();
vi.mock('./server-api', () => ({
    serverFetch: (...args: unknown[]) => serverFetch(...args),
    serverMutation: (...args: unknown[]) => serverMutation(...args),
}));

/**
 * What's new (AW-14) — the server-side client. The one behaviour that the
 * whole dashboard shell depends on is that the unread count can never throw:
 * any failure is `null`, which renders as "no badge" (spec FR-47, S-11).
 */
describe('changelogAPI', () => {
    beforeEach(() => {
        vi.resetModules();
        serverFetch.mockReset();
        serverMutation.mockReset();
    });

    async function load() {
        return (await import('./changelog')).changelogAPI;
    }

    it('unreadCount returns the count from GET /changelog/unread-count', async () => {
        serverFetch.mockResolvedValue({ count: 3 });
        const api = await load();

        await expect(api.unreadCount()).resolves.toBe(3);
        expect(serverFetch).toHaveBeenCalledWith('/changelog/unread-count');
    });

    it.each([
        ['a rejected request', () => serverFetch.mockRejectedValue(new Error('500'))],
        ['an empty body', () => serverFetch.mockResolvedValue(undefined)],
        ['a malformed body', () => serverFetch.mockResolvedValue({ count: 'three' })],
    ])('S-11: unreadCount resolves to null — never throws — for %s', async (_label, arrange) => {
        arrange();
        const api = await load();

        await expect(api.unreadCount()).resolves.toBeNull();
    });

    it('list forwards only the parameters that were given', async () => {
        serverFetch.mockResolvedValue({});
        const api = await load();

        await api.list();
        await api.list({ category: 'costs', limit: 20, cursor: 'stop-the-whole-fleet' });

        expect(serverFetch).toHaveBeenNthCalledWith(1, '/changelog');
        expect(serverFetch).toHaveBeenNthCalledWith(
            2,
            '/changelog?category=costs&limit=20&cursor=stop-the-whole-fleet',
        );
    });

    it('markRead and markAllRead post to their endpoints', async () => {
        serverMutation.mockResolvedValue({ unreadCount: 0 });
        const api = await load();

        await api.markRead(['stop-the-whole-fleet']);
        await api.markAllRead();

        expect(serverMutation).toHaveBeenNthCalledWith(1, {
            endpoint: '/changelog/read',
            method: 'POST',
            data: { slugs: ['stop-the-whole-fleet'] },
            wrapInData: false,
        });
        expect(serverMutation).toHaveBeenNthCalledWith(2, {
            endpoint: '/changelog/read-all',
            method: 'POST',
            data: {},
            wrapInData: false,
        });
    });
});
