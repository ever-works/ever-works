import {
    BaseUserEvent,
    MemberInvitedEvent,
    UserCreatedEvent,
    UserForgotPasswordEvent,
    UserPasswordChangedEvent,
    UserConfirmedEvent,
    UserNewDeviceLoginEvent,
    UserAccountDeletionEvent,
} from './index';

// Minimal stand-ins for User / Work — the events store them as opaque object refs.
const fakeUser = { id: 'u1', email: 'u@example.com', emailVerified: false } as any;
const fakeUser2 = { id: 'u2', email: 'u2@example.com' } as any;
const fakeWork = { id: 'w1', name: 'My Work', slug: 'my-work' } as any;

describe('events/* event objects', () => {
    describe('event-name registry (wire-format stability — do not change without spec bump)', () => {
        it('pins each event name string', () => {
            expect(MemberInvitedEvent.EVENT_NAME).toBe('work.member_invited');
            expect(UserCreatedEvent.EVENT_NAME).toBe('user.created');
            expect(UserForgotPasswordEvent.EVENT_NAME).toBe('user.forgot_password');
            expect(UserPasswordChangedEvent.EVENT_NAME).toBe('user.password_changed');
            expect(UserConfirmedEvent.EVENT_NAME).toBe('user.confirmed');
            expect(UserNewDeviceLoginEvent.EVENT_NAME).toBe('user.new_device_login');
            expect(UserAccountDeletionEvent.EVENT_NAME).toBe('user.delete_account');
        });

        it('every event-name string is unique', () => {
            const names = [
                MemberInvitedEvent.EVENT_NAME,
                UserCreatedEvent.EVENT_NAME,
                UserForgotPasswordEvent.EVENT_NAME,
                UserPasswordChangedEvent.EVENT_NAME,
                UserConfirmedEvent.EVENT_NAME,
                UserNewDeviceLoginEvent.EVENT_NAME,
                UserAccountDeletionEvent.EVENT_NAME,
            ];
            expect(new Set(names).size).toBe(names.length);
        });
    });

    describe('MemberInvitedEvent', () => {
        it('captures invitee/inviter/work/role/workUrl in order', () => {
            const evt = new MemberInvitedEvent(
                fakeUser,
                fakeUser2,
                fakeWork,
                'admin',
                'https://app/work/m',
            );
            expect(evt.invitee).toBe(fakeUser);
            expect(evt.inviter).toBe(fakeUser2);
            expect(evt.work).toBe(fakeWork);
            expect(evt.role).toBe('admin');
            expect(evt.workUrl).toBe('https://app/work/m');
        });

        it('does NOT extend BaseUserEvent (no public `user` field — uses `invitee`/`inviter`)', () => {
            const evt = new MemberInvitedEvent(fakeUser, fakeUser2, fakeWork, 'admin', '');
            expect(evt instanceof BaseUserEvent).toBe(false);
            expect((evt as any).user).toBeUndefined();
        });
    });

    describe('UserCreatedEvent', () => {
        it('extends BaseUserEvent and exposes user/confirmationToken/confirmationUrl', () => {
            const evt = new UserCreatedEvent(fakeUser, 'tok', 'https://confirm');
            expect(evt instanceof BaseUserEvent).toBe(true);
            expect(evt.user).toBe(fakeUser);
            expect(evt.confirmationToken).toBe('tok');
            expect(evt.confirmationUrl).toBe('https://confirm');
        });
    });

    describe('UserForgotPasswordEvent', () => {
        it('captures user/resetToken/resetUrl and optional expiresIn', () => {
            const evt = new UserForgotPasswordEvent(fakeUser, 'rt', 'https://reset');
            expect(evt.user).toBe(fakeUser);
            expect(evt.resetToken).toBe('rt');
            expect(evt.resetUrl).toBe('https://reset');
            expect(evt.expiresIn).toBeUndefined();

            const evt2 = new UserForgotPasswordEvent(fakeUser, 'rt', 'https://reset', '1 hour');
            expect(evt2.expiresIn).toBe('1 hour');
        });

        it('extends BaseUserEvent', () => {
            const evt = new UserForgotPasswordEvent(fakeUser, 'rt', 'https://reset');
            expect(evt instanceof BaseUserEvent).toBe(true);
        });
    });

    describe('UserPasswordChangedEvent', () => {
        it('captures user/changedAt/ipAddress/location/device + optional browser/secureAccountUrl', () => {
            const at = new Date('2026-05-07T00:00:00.000Z');
            const evt = new UserPasswordChangedEvent(
                fakeUser,
                at,
                '127.0.0.1',
                'Berlin, DE',
                'iPhone',
            );
            expect(evt.user).toBe(fakeUser);
            expect(evt.changedAt).toBe(at);
            expect(evt.ipAddress).toBe('127.0.0.1');
            expect(evt.location).toBe('Berlin, DE');
            expect(evt.device).toBe('iPhone');
            expect(evt.browser).toBeUndefined();
            expect(evt.secureAccountUrl).toBeUndefined();

            const evt2 = new UserPasswordChangedEvent(
                fakeUser,
                at,
                '127.0.0.1',
                'Berlin, DE',
                'iPhone',
                'Safari',
                'https://secure',
            );
            expect(evt2.browser).toBe('Safari');
            expect(evt2.secureAccountUrl).toBe('https://secure');
        });

        it('extends BaseUserEvent', () => {
            const evt = new UserPasswordChangedEvent(fakeUser, new Date(), 'ip', 'loc', 'dev');
            expect(evt instanceof BaseUserEvent).toBe(true);
        });
    });

    describe('UserConfirmedEvent', () => {
        it('captures user, optional dashboardUrl', () => {
            const evt = new UserConfirmedEvent(fakeUser);
            expect(evt.user).toBe(fakeUser);
            expect(evt.dashboardUrl).toBeUndefined();

            const evt2 = new UserConfirmedEvent(fakeUser, 'https://dash');
            expect(evt2.dashboardUrl).toBe('https://dash');
        });

        it('extends BaseUserEvent', () => {
            expect(new UserConfirmedEvent(fakeUser) instanceof BaseUserEvent).toBe(true);
        });
    });

    describe('UserNewDeviceLoginEvent', () => {
        it('captures all 7 required positional args + optional verifyUrl/secureAccountUrl', () => {
            const at = new Date('2026-05-07T13:00:00.000Z');
            const evt = new UserNewDeviceLoginEvent(
                fakeUser,
                at,
                'iPhone',
                'Safari',
                'Berlin',
                '203.0.113.1',
                'vt',
            );
            expect(evt.user).toBe(fakeUser);
            expect(evt.loginTime).toBe(at);
            expect(evt.device).toBe('iPhone');
            expect(evt.browser).toBe('Safari');
            expect(evt.location).toBe('Berlin');
            expect(evt.ipAddress).toBe('203.0.113.1');
            expect(evt.verifyToken).toBe('vt');
            expect(evt.verifyUrl).toBeUndefined();
            expect(evt.secureAccountUrl).toBeUndefined();

            const evt2 = new UserNewDeviceLoginEvent(
                fakeUser,
                at,
                'iPhone',
                'Safari',
                'Berlin',
                '203.0.113.1',
                'vt',
                'https://verify',
                'https://secure',
            );
            expect(evt2.verifyUrl).toBe('https://verify');
            expect(evt2.secureAccountUrl).toBe('https://secure');
        });

        it('extends BaseUserEvent', () => {
            const evt = new UserNewDeviceLoginEvent(
                fakeUser,
                new Date(),
                'd',
                'b',
                'loc',
                'ip',
                'tok',
            );
            expect(evt instanceof BaseUserEvent).toBe(true);
        });
    });

    describe('UserAccountDeletionEvent', () => {
        it('captures user/deleteToken + optional deleteUrl/keepAccountUrl/expiresIn', () => {
            const evt = new UserAccountDeletionEvent(fakeUser, 'dt');
            expect(evt.user).toBe(fakeUser);
            expect(evt.deleteToken).toBe('dt');
            expect(evt.deleteUrl).toBeUndefined();
            expect(evt.keepAccountUrl).toBeUndefined();
            expect(evt.expiresIn).toBeUndefined();

            const evt2 = new UserAccountDeletionEvent(
                fakeUser,
                'dt',
                'https://delete',
                'https://keep',
                '24 hours',
            );
            expect(evt2.deleteUrl).toBe('https://delete');
            expect(evt2.keepAccountUrl).toBe('https://keep');
            expect(evt2.expiresIn).toBe('24 hours');
        });

        it('extends BaseUserEvent', () => {
            const evt = new UserAccountDeletionEvent(fakeUser, 'dt');
            expect(evt instanceof BaseUserEvent).toBe(true);
        });
    });

    describe('BaseUserEvent', () => {
        it('is abstract — direct instantiation is a TypeScript-level constraint; subclasses concrete', () => {
            // Cannot construct directly in TS, but at runtime the class exists.
            expect(typeof BaseUserEvent).toBe('function');
            // Confirm subclasses set the abstract `user` field.
            const evt = new UserCreatedEvent(fakeUser, 'tok', 'url');
            expect((evt as BaseUserEvent).user).toBe(fakeUser);
        });
    });
});
