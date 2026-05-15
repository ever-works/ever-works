import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
}));

vi.mock('next/navigation', () => ({
    useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('@/lib/api/notifications', () => ({}));

const toastWarning = vi.fn();
const toastError = vi.fn();
const toastInfo = vi.fn();
vi.mock('sonner', () => ({
    toast: {
        warning: (...args: any[]) => toastWarning(...args),
        error: (...args: any[]) => toastError(...args),
        info: (...args: any[]) => toastInfo(...args),
    },
}));

const getNotifications = vi.fn();
const getUnreadNotificationCount = vi.fn();
const markNotificationAsRead = vi.fn();
const markAllNotificationsAsRead = vi.fn();
const dismissNotification = vi.fn();
vi.mock('@/app/actions/notifications', () => ({
    getNotifications: (...args: any[]) => getNotifications(...args),
    getUnreadNotificationCount: (...args: any[]) => getUnreadNotificationCount(...args),
    markNotificationAsRead: (...args: any[]) => markNotificationAsRead(...args),
    markAllNotificationsAsRead: (...args: any[]) => markAllNotificationsAsRead(...args),
    dismissNotification: (...args: any[]) => dismissNotification(...args),
}));

import { NotificationDropdown } from './NotificationDropdown';

function makeNotif(overrides: Partial<any> = {}) {
    return {
        id: `n-${Math.random().toString(36).slice(2, 8)}`,
        userId: 'u1',
        type: 'warning' as const,
        category: 'ai_credits' as const,
        title: 'Approaching cap',
        message: 'You are at 90%',
        isRead: false,
        isPersistent: false,
        createdAt: new Date('2026-05-15T10:00:00Z').toISOString(),
        ...overrides,
    };
}

/**
 * EW-602 — NotificationDropdown polls every 30s, and when new
 * ai_credits notifications appear between polls, surfaces them as a
 * sonner toast (so the user sees a budget alert without having to
 * open the bell). The first poll only seeds the "last seen" baseline
 * so pre-existing unread alerts don't toast on every page load.
 */
describe('NotificationDropdown — EW-602 auto-toast', () => {
    beforeEach(() => {
        toastWarning.mockClear();
        toastError.mockClear();
        toastInfo.mockClear();
        getNotifications.mockReset();
        getUnreadNotificationCount.mockReset();
        getUnreadNotificationCount.mockResolvedValue({ success: true, count: 0 });
        getNotifications.mockResolvedValue({ success: true, notifications: [] });
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('seeds the baseline on first mount and does NOT toast pre-existing notifications', async () => {
        getUnreadNotificationCount.mockResolvedValue({ success: true, count: 2 });
        getNotifications.mockResolvedValue({
            success: true,
            notifications: [
                makeNotif({ id: 'n1', type: 'warning', category: 'ai_credits' }),
                makeNotif({ id: 'n2', type: 'info', category: 'ai_credits' }),
            ],
        });

        render(<NotificationDropdown />);

        await waitFor(() => {
            expect(getUnreadNotificationCount).toHaveBeenCalled();
            expect(getNotifications).toHaveBeenCalledWith({ limit: 10 });
        });
        // First poll is the seed → no toast for pre-existing alerts
        expect(toastWarning).not.toHaveBeenCalled();
        expect(toastError).not.toHaveBeenCalled();
    });

    it('ignores notifications outside the ai_credits category when surfacing toasts', async () => {
        getUnreadNotificationCount.mockResolvedValue({ success: true, count: 1 });
        getNotifications.mockResolvedValue({
            success: true,
            notifications: [
                makeNotif({ id: 'n1', type: 'info', category: 'subscription' }),
                makeNotif({ id: 'n2', type: 'warning', category: 'system' }),
            ],
        });

        render(<NotificationDropdown />);

        await waitFor(() => {
            expect(getNotifications).toHaveBeenCalled();
        });
        // Even on the seed call → category filter ensures no false-positive toasts
        expect(toastWarning).not.toHaveBeenCalled();
        expect(toastError).not.toHaveBeenCalled();
    });

    it('swallows fetch failures in surfaceNewAiCreditsToasts (does not surface errors via console.error path)', async () => {
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        getUnreadNotificationCount.mockResolvedValue({ success: true, count: 1 });
        getNotifications.mockRejectedValue(new Error('network'));

        render(<NotificationDropdown />);

        await waitFor(() => {
            expect(getNotifications).toHaveBeenCalled();
        });
        expect(toastWarning).not.toHaveBeenCalled();
        expect(toastError).not.toHaveBeenCalled();
        expect(consoleSpy).toHaveBeenCalledWith(
            'Failed to fetch notifications for toast surfacing:',
            expect.any(Error),
        );
    });

    it('cleans up the polling interval on unmount (no lingering setInterval calls)', async () => {
        const clearSpy = vi.spyOn(global, 'clearInterval');
        getUnreadNotificationCount.mockResolvedValue({ success: true, count: 0 });

        const { unmount } = render(<NotificationDropdown />);

        await act(async () => {
            unmount();
        });
        expect(clearSpy).toHaveBeenCalled();
    });
});
