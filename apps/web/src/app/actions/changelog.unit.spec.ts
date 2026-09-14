import { beforeEach, describe, expect, it, vi } from 'vitest';

const list = vi.fn();
const unreadCount = vi.fn();
const markRead = vi.fn();
const markAllRead = vi.fn();
vi.mock('@/lib/api/changelog', () => ({
    changelogAPI: {
        list: (...args: unknown[]) => list(...args),
        unreadCount: (...args: unknown[]) => unreadCount(...args),
        markRead: (...args: unknown[]) => markRead(...args),
        markAllRead: (...args: unknown[]) => markAllRead(...args),
    },
}));

import {
    getChangelog,
    getChangelogUnreadCount,
    markAllChangelogRead,
    markChangelogRead,
} from './changelog';

/**
 * What's new (AW-14) — the server actions the panel is driven through. None
 * of them may throw: a failing API has to become a state the panel can
 * render (spec FR-46, FR-47, FR-48).
 */
describe('changelog server actions', () => {
    beforeEach(() => {
        list.mockReset();
        unreadCount.mockReset();
        markRead.mockReset();
        markAllRead.mockReset();
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
    });

    it('getChangelog returns the page on success', async () => {
        const data = {
            entries: [],
            nextCursor: null,
            total: 0,
            unreadCount: 0,
            categoriesWithEntries: [],
        };
        list.mockResolvedValue(data);

        await expect(getChangelog({ category: 'costs', limit: 20 })).resolves.toEqual({
            success: true,
            data,
        });
        expect(list).toHaveBeenCalledWith({ category: 'costs', limit: 20, cursor: undefined });
    });

    it('getChangelog drops an unknown category and a malformed cursor instead of sending them', async () => {
        list.mockResolvedValue({});

        await getChangelog({ category: 'billing', cursor: '../etc' });

        expect(list).toHaveBeenCalledWith({
            category: undefined,
            limit: undefined,
            cursor: undefined,
        });
    });

    it('getChangelog returns { success: false, error } when the API fails', async () => {
        list.mockRejectedValue(new Error('API Error: 500'));

        await expect(getChangelog()).resolves.toEqual({ success: false, error: 'API Error: 500' });
    });

    it('getChangelogUnreadCount returns { success: false } when the count is unknown', async () => {
        unreadCount.mockResolvedValue(null);
        await expect(getChangelogUnreadCount()).resolves.toMatchObject({ success: false });

        unreadCount.mockResolvedValue(4);
        await expect(getChangelogUnreadCount()).resolves.toEqual({ success: true, unreadCount: 4 });
    });

    it('markChangelogRead sends only well-formed, de-duplicated slugs, at most 25', async () => {
        markRead.mockResolvedValue({ unreadCount: 3 });
        const many = Array.from({ length: 30 }, (_, index) => `entry-${index}`);

        await expect(
            markChangelogRead(['entry-0', 'entry-0', 'Bad/Slug', ...many]),
        ).resolves.toEqual({ success: true, unreadCount: 3 });

        const sent = markRead.mock.calls[0][0] as string[];
        expect(sent).toHaveLength(25);
        expect(new Set(sent).size).toBe(25);
        expect(sent).not.toContain('Bad/Slug');
    });

    it('markChangelogRead refuses an empty or all-invalid batch without calling the API', async () => {
        await expect(markChangelogRead([])).resolves.toMatchObject({ success: false });
        await expect(markChangelogRead(['NOPE'])).resolves.toMatchObject({ success: false });
        expect(markRead).not.toHaveBeenCalled();
    });

    it('markChangelogRead returns { success: false, error } when the API fails', async () => {
        markRead.mockRejectedValue(new Error('Too Many Requests'));

        await expect(markChangelogRead(['entry-one'])).resolves.toEqual({
            success: false,
            error: 'Too Many Requests',
        });
    });

    it('markAllChangelogRead returns the fresh count, or { success: false, error } on failure', async () => {
        markAllRead.mockResolvedValueOnce({ unreadCount: 0 });
        await expect(markAllChangelogRead()).resolves.toEqual({ success: true, unreadCount: 0 });

        markAllRead.mockRejectedValueOnce(new Error('boom'));
        await expect(markAllChangelogRead()).resolves.toEqual({ success: false, error: 'boom' });
    });
});
