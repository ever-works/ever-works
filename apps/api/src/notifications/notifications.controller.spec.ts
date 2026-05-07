jest.mock('@ever-works/agent/notifications', () => ({}));
jest.mock('@ever-works/agent/entities', () => ({
    NotificationCategory: {
        AI_CREDITS: 'ai_credits',
        SUBSCRIPTION: 'subscription',
        GENERATION: 'generation',
        SYSTEM: 'system',
        SECURITY: 'security',
    },
}));
// Stub the auth barrel so its transitive @ever-works/agent/database
// imports are not pulled into this controller test.
jest.mock('../auth', () => ({
    CurrentUser: () => () => undefined,
    AuthSessionGuard: class AuthSessionGuard {},
}));

import { NotificationsController } from './notifications.controller';
import type { NotificationService } from '@ever-works/agent/notifications';
import type { AuthenticatedUser } from '../auth/types/auth.types';

describe('NotificationsController', () => {
    let service: jest.Mocked<
        Pick<
            NotificationService,
            | 'getNotifications'
            | 'getUnreadCount'
            | 'getPersistentNotifications'
            | 'markAsRead'
            | 'markAllAsRead'
            | 'dismiss'
        >
    >;
    let controller: NotificationsController;

    const auth = {
        userId: 'user-1',
        email: 'u@e.test',
        username: 'u',
        provider: 'local',
        emailVerified: true,
        isActive: true,
        avatar: null,
        iat: 0,
        iss: '',
        aud: '',
    } as AuthenticatedUser;

    beforeEach(() => {
        service = {
            getNotifications: jest.fn(),
            getUnreadCount: jest.fn(),
            getPersistentNotifications: jest.fn(),
            markAsRead: jest.fn(),
            markAllAsRead: jest.fn(),
            dismiss: jest.fn(),
        } as any;
        controller = new NotificationsController(service as unknown as NotificationService);
    });

    describe('getNotifications', () => {
        it('passes parsed query params + caps limit at 100', async () => {
            const list = [{ id: 'n1' }, { id: 'n2' }];
            service.getNotifications.mockResolvedValue(list as any);

            const result = await controller.getNotifications(auth, true, 250, 5, 'system');

            expect(service.getNotifications).toHaveBeenCalledWith('user-1', {
                unreadOnly: true,
                limit: 100, // capped
                offset: 5,
                category: 'system',
            });
            expect(result).toEqual({ notifications: list });
        });

        it('passes through limit when below cap and forwards undefined category', async () => {
            service.getNotifications.mockResolvedValue([] as any);

            await controller.getNotifications(auth, false, 25, 0, undefined);

            expect(service.getNotifications).toHaveBeenCalledWith('user-1', {
                unreadOnly: false,
                limit: 25,
                offset: 0,
                category: undefined,
            });
        });

        it('treats limit equal to cap (100) as 100', async () => {
            service.getNotifications.mockResolvedValue([] as any);

            await controller.getNotifications(auth, false, 100, 0, undefined);

            expect(service.getNotifications).toHaveBeenCalledWith(
                'user-1',
                expect.objectContaining({ limit: 100 }),
            );
        });
    });

    describe('getUnreadCount', () => {
        it('returns count from service', async () => {
            service.getUnreadCount.mockResolvedValue(7);

            const result = await controller.getUnreadCount(auth);

            expect(service.getUnreadCount).toHaveBeenCalledWith('user-1');
            expect(result).toEqual({ count: 7 });
        });
    });

    describe('getPersistentNotifications', () => {
        it('returns persistent notifications wrapped in object', async () => {
            const list = [{ id: 'p1' }];
            service.getPersistentNotifications.mockResolvedValue(list as any);

            const result = await controller.getPersistentNotifications(auth);

            expect(service.getPersistentNotifications).toHaveBeenCalledWith('user-1');
            expect(result).toEqual({ notifications: list });
        });
    });

    describe('markAsRead', () => {
        it('forwards id+userId and returns success', async () => {
            service.markAsRead.mockResolvedValue(undefined as any);

            const result = await controller.markAsRead(auth, 'notif-77');

            expect(service.markAsRead).toHaveBeenCalledWith('user-1', 'notif-77');
            expect(result).toEqual({ success: true });
        });

        it('propagates service errors', async () => {
            service.markAsRead.mockRejectedValue(new Error('not found'));

            await expect(controller.markAsRead(auth, 'x')).rejects.toThrow('not found');
        });
    });

    describe('markAllAsRead', () => {
        it('returns success', async () => {
            service.markAllAsRead.mockResolvedValue(undefined as any);

            const result = await controller.markAllAsRead(auth);

            expect(service.markAllAsRead).toHaveBeenCalledWith('user-1');
            expect(result).toEqual({ success: true });
        });
    });

    describe('dismiss', () => {
        it('forwards id+userId and returns success', async () => {
            service.dismiss.mockResolvedValue(undefined as any);

            const result = await controller.dismiss(auth, 'notif-9');

            expect(service.dismiss).toHaveBeenCalledWith('user-1', 'notif-9');
            expect(result).toEqual({ success: true });
        });

        it('propagates service errors (e.g. cannot dismiss persistent)', async () => {
            service.dismiss.mockRejectedValue(new Error('cannot dismiss persistent'));

            await expect(controller.dismiss(auth, 'p1')).rejects.toThrow(
                'cannot dismiss persistent',
            );
        });
    });
});
