import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
    redirectMock,
    revalidatePathMock,
    getAuthFromCookieMock,
    setEventSubscriptionMock,
    setMatrixEventTargetsMock,
    resetMatrixMock,
    getMatrixMock,
    setQuietHoursMock,
    unmuteCategoryMock,
} = vi.hoisted(() => ({
    redirectMock: vi.fn((_path: string) => {
        throw new Error('__REDIRECT__');
    }),
    revalidatePathMock: vi.fn(),
    getAuthFromCookieMock: vi.fn(),
    setEventSubscriptionMock: vi.fn(),
    setMatrixEventTargetsMock: vi.fn(),
    resetMatrixMock: vi.fn(),
    getMatrixMock: vi.fn(),
    setQuietHoursMock: vi.fn(),
    unmuteCategoryMock: vi.fn(),
}));

vi.mock('next/cache', () => ({ revalidatePath: revalidatePathMock }));
vi.mock('next/navigation', () => ({ redirect: redirectMock }));
vi.mock('@/lib/auth', () => ({ getAuthFromCookie: getAuthFromCookieMock }));
vi.mock('@/lib/constants', () => ({ ROUTES: { AUTH_LOGIN: '/login' } }));
vi.mock('@/lib/api/notification-preferences', () => ({
    notificationPreferencesAPI: {
        setEventSubscription: setEventSubscriptionMock,
        setMatrixEventTargets: setMatrixEventTargetsMock,
        resetMatrix: resetMatrixMock,
        getMatrix: getMatrixMock,
        setQuietHours: setQuietHoursMock,
        unmuteCategory: unmuteCategoryMock,
    },
}));

import {
    loadNotificationMatrix,
    resetNotificationMatrix,
    setNotificationEventTargets,
    setNotificationQuietHours,
    unmuteNotificationCategory,
} from './notification-preferences';

/**
 * AW-13 — server actions behind the notification matrix. They gate on the
 * session before proxying anything, forward exactly what the page chose, and
 * turn a failure into a result the row can show instead of a thrown error.
 */
describe('notification matrix server actions', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        getAuthFromCookieMock.mockResolvedValue({ id: 'user-1' });
        setEventSubscriptionMock.mockImplementation(async (key: string, ids: string[]) => ({
            subscription: { eventTypeKey: key, channelIds: ids },
        }));
        setMatrixEventTargetsMock.mockImplementation(async (key: string, ids: string[]) => ({
            subscription: { eventTypeKey: key, channelIds: ids, origin: 'matrix' },
        }));
        resetMatrixMock.mockResolvedValue({ changed: 4 });
        getMatrixMock.mockResolvedValue({ events: [], columns: [] });
        setQuietHoursMock.mockResolvedValue({ preference: {} });
        unmuteCategoryMock.mockResolvedValue(undefined);
    });

    it.each([
        ['setNotificationEventTargets', () => setNotificationEventTargets('generation_error', [])],
        ['resetNotificationMatrix', () => resetNotificationMatrix()],
        ['loadNotificationMatrix', () => loadNotificationMatrix()],
        [
            'setNotificationQuietHours',
            () =>
                setNotificationQuietHours({
                    quietHoursStart: null,
                    quietHoursEnd: null,
                    timezone: null,
                }),
        ],
        ['unmuteNotificationCategory', () => unmuteNotificationCategory('agent')],
    ])(
        '%s redirects an unauthenticated caller to login and proxies nothing',
        async (_name, call) => {
            getAuthFromCookieMock.mockResolvedValue(null);
            await expect(call()).rejects.toThrow('__REDIRECT__');
            expect(redirectMock).toHaveBeenCalledWith('/login');
            expect(setEventSubscriptionMock).not.toHaveBeenCalled();
            expect(setMatrixEventTargetsMock).not.toHaveBeenCalled();
            expect(resetMatrixMock).not.toHaveBeenCalled();
            expect(getMatrixMock).not.toHaveBeenCalled();
            expect(setQuietHoursMock).not.toHaveBeenCalled();
            expect(unmuteCategoryMock).not.toHaveBeenCalled();
        },
    );

    it('forwards exactly the target list it was given, an empty one included, through the matrix write', async () => {
        await expect(
            setNotificationEventTargets('agent_run_escalated', ['email', 'ch-1']),
        ).resolves.toEqual({
            success: true,
            data: { targetIds: ['email', 'ch-1'] },
        });
        expect(setMatrixEventTargetsMock).toHaveBeenCalledWith('agent_run_escalated', [
            'email',
            'ch-1',
        ]);

        await setNotificationEventTargets('generation_error', []);
        expect(setMatrixEventTargetsMock).toHaveBeenLastCalledWith('generation_error', []);
        expect(revalidatePathMock).toHaveBeenCalledWith('/', 'layout');
        // Never through the generic per-event write, which stores no matrix marker.
        expect(setEventSubscriptionMock).not.toHaveBeenCalled();
    });

    it('returns the API message when a save is refused', async () => {
        setMatrixEventTargetsMock.mockRejectedValue(
            new Error('Unknown or unauthorized notification channel: ch-gone'),
        );
        await expect(setNotificationEventTargets('generation_error', ['ch-gone'])).resolves.toEqual(
            {
                success: false,
                error: 'Unknown or unauthorized notification channel: ch-gone',
            },
        );
    });

    it('resets in one call and reports the count', async () => {
        await expect(resetNotificationMatrix()).resolves.toEqual({
            success: true,
            data: { changed: 4 },
        });
        expect(resetMatrixMock).toHaveBeenCalledTimes(1);
        expect(resetMatrixMock).toHaveBeenCalledWith(undefined);
    });

    it('loads the matrix, and reports a load failure without throwing', async () => {
        await expect(loadNotificationMatrix()).resolves.toMatchObject({ success: true });
        getMatrixMock.mockRejectedValue(new Error('down'));
        await expect(loadNotificationMatrix()).resolves.toEqual({ success: false, error: 'down' });
    });

    it('forwards quiet hours and unmutes through the existing preference endpoints', async () => {
        await setNotificationQuietHours({
            quietHoursStart: '22:00',
            quietHoursEnd: '07:00',
            timezone: 'UTC',
        });
        expect(setQuietHoursMock).toHaveBeenCalledWith({
            quietHoursStart: '22:00',
            quietHoursEnd: '07:00',
            timezone: 'UTC',
        });
        await expect(unmuteNotificationCategory('agent')).resolves.toEqual({ success: true });
        expect(unmuteCategoryMock).toHaveBeenCalledWith('agent');
    });

    it('forwards the urgent quiet-hours opt-in when it is named', async () => {
        await expect(
            setNotificationQuietHours({
                quietHoursStart: '22:00:00',
                quietHoursEnd: '07:00:00',
                timezone: 'UTC',
                urgentBypassesQuietHours: true,
            }),
        ).resolves.toEqual({ success: true });
        expect(setQuietHoursMock).toHaveBeenCalledWith({
            quietHoursStart: '22:00:00',
            quietHoursEnd: '07:00:00',
            timezone: 'UTC',
            urgentBypassesQuietHours: true,
        });
    });
});
