// Listener-side coverage for `MailService` — pins the contract between every
// `@OnEvent` handler in `mail.service.ts` and the `MailerService.sendMail`
// call (subject text, template name, branding context merge, default-value
// fallbacks, error swallowing). The provider-side already has its own spec
// (`providers/mailer.service.spec.ts`); this file mirrors that for the
// listener layer.

const ORIGINAL_ENV = { ...process.env };

const setBranding = (overrides: Partial<Record<string, string>> = {}) => {
    delete process.env.APP_NAME;
    delete process.env.NEXT_PUBLIC_APP_NAME;
    delete process.env.COMPANY_OWNER;
    delete process.env.NEXT_PUBLIC_COMPANY_OWNER;
    delete process.env.PLATFORM_WEBSITE;
    delete process.env.NEXT_PUBLIC_COMPANY_OWNER_WEBSITE;
    delete process.env.WEB_URL;
    for (const [k, v] of Object.entries(overrides)) {
        if (v === undefined) {
            delete process.env[k];
        } else {
            process.env[k] = v;
        }
    }
};

beforeEach(() => {
    setBranding();
});

afterAll(() => {
    process.env = ORIGINAL_ENV;
});

import { MailService } from './mail.service';
import {
    MemberInvitedEvent,
    UserAccountDeletionEvent,
    UserConfirmedEvent,
    UserCreatedEvent,
    UserForgotPasswordEvent,
    UserNewDeviceLoginEvent,
    UserPasswordChangedEvent,
} from '../events';
import type { MailerService } from './providers/mailer.service';

const fakeUser = (overrides: Record<string, unknown> = {}) =>
    ({
        id: 'user-1',
        email: 'recipient@test.example',
        username: 'alice',
        ...overrides,
    }) as any;

describe('MailService (listener layer)', () => {
    let mailer: { sendMail: jest.Mock };
    let service: MailService;
    let errorSpy: jest.SpyInstance;

    beforeEach(() => {
        mailer = { sendMail: jest.fn().mockResolvedValue(undefined) };
        service = new MailService(mailer as unknown as MailerService);
        errorSpy = jest.spyOn((service as any).logger, 'error').mockImplementation(() => undefined);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    describe('getBrandingContext (private — exercised through every handler)', () => {
        it('merges appName / companyOwner / platformWebsite / currentYear from config + env', async () => {
            setBranding({
                APP_NAME: 'CustomApp',
                COMPANY_OWNER: 'Custom Co.',
                PLATFORM_WEBSITE: 'https://custom.test',
            });
            const event = new UserCreatedEvent(
                fakeUser(),
                'tok',
                'https://app.test/confirm?token=tok',
            );

            await service.sendSignupConfirmation(event);

            const ctx = mailer.sendMail.mock.calls[0][0].context;
            expect(ctx.appName).toBe('CustomApp');
            expect(ctx.companyOwner).toBe('Custom Co.');
            expect(ctx.platformWebsite).toBe('https://custom.test');
            expect(ctx.currentYear).toBe(new Date().getFullYear());
        });

        it('defaults appName/owner/website when env is unset', async () => {
            setBranding();
            await service.sendSignupConfirmation(
                new UserCreatedEvent(fakeUser(), 'tok', 'https://app.test/confirm'),
            );
            const ctx = mailer.sendMail.mock.calls[0][0].context;
            expect(ctx.appName).toBe('Ever Works');
            expect(ctx.companyOwner).toBe('Ever Co.');
            expect(ctx.platformWebsite).toBe('https://ever.works');
        });

        it('NEXT_PUBLIC_* fallback chain is honoured for branding fields', async () => {
            setBranding({
                NEXT_PUBLIC_APP_NAME: 'NextApp',
                NEXT_PUBLIC_COMPANY_OWNER: 'Next Co.',
                NEXT_PUBLIC_COMPANY_OWNER_WEBSITE: 'https://next.test',
            });
            await service.sendSignupConfirmation(
                new UserCreatedEvent(fakeUser(), 'tok', 'https://app.test/confirm'),
            );
            const ctx = mailer.sendMail.mock.calls[0][0].context;
            expect(ctx.appName).toBe('NextApp');
            expect(ctx.companyOwner).toBe('Next Co.');
            expect(ctx.platformWebsite).toBe('https://next.test');
        });
    });

    describe('sendSignupConfirmation (UserCreatedEvent)', () => {
        it('sends confirm email with subject derived from appName and full template context', async () => {
            setBranding({ APP_NAME: 'EW' });
            const event = new UserCreatedEvent(
                fakeUser({ username: 'bob', email: 'bob@x.test' }),
                'token-abc',
                'https://app.test/confirm?token=token-abc',
            );

            await service.sendSignupConfirmation(event);

            expect(mailer.sendMail).toHaveBeenCalledTimes(1);
            const args = mailer.sendMail.mock.calls[0][0];
            expect(args.to).toBe('bob@x.test');
            expect(args.subject).toBe('Confirm your EW account');
            expect(args.template).toBe('signup-confirmation');
            expect(args.context).toEqual(
                expect.objectContaining({
                    firstName: 'bob',
                    confirmationUrl: 'https://app.test/confirm?token=token-abc',
                    confirmationToken: 'token-abc',
                }),
            );
            expect(errorSpy).not.toHaveBeenCalled();
        });

        it('logs error and SWALLOWS rejection when mailer fails', async () => {
            const boom = new Error('smtp down');
            mailer.sendMail.mockRejectedValueOnce(boom);
            const event = new UserCreatedEvent(
                fakeUser({ email: 'bob@x.test' }),
                'tok',
                'https://app.test/confirm',
            );

            await expect(service.sendSignupConfirmation(event)).resolves.toBeUndefined();
            expect(errorSpy).toHaveBeenCalledWith(
                'Failed to send signup confirmation to bob@x.test',
                boom.stack,
            );
        });

        it('uses String(error) when reject value lacks a stack', async () => {
            mailer.sendMail.mockRejectedValueOnce('no-stack');
            const event = new UserCreatedEvent(
                fakeUser({ email: 'bob@x.test' }),
                'tok',
                'https://app.test/confirm',
            );
            await service.sendSignupConfirmation(event);
            expect(errorSpy).toHaveBeenCalledWith(
                'Failed to send signup confirmation to bob@x.test',
                'no-stack',
            );
        });
    });

    describe('sendForgotPassword (UserForgotPasswordEvent)', () => {
        it('sends reset email with default expiresIn=1 hour when omitted', async () => {
            const event = new UserForgotPasswordEvent(
                fakeUser({ username: 'carol', email: 'carol@x.test' }),
                'reset-tok',
                'https://app.test/reset?token=reset-tok',
            );
            await service.sendForgotPassword(event);

            const args = mailer.sendMail.mock.calls[0][0];
            expect(args.to).toBe('carol@x.test');
            expect(args.subject).toBe('Reset your Ever Works password');
            expect(args.template).toBe('forgot-password');
            expect(args.context).toEqual(
                expect.objectContaining({
                    firstName: 'carol',
                    resetUrl: 'https://app.test/reset?token=reset-tok',
                    resetToken: 'reset-tok',
                    expiresIn: '1 hour',
                }),
            );
        });

        it('forwards explicit expiresIn override verbatim', async () => {
            const event = new UserForgotPasswordEvent(
                fakeUser(),
                'tok',
                'https://app.test/reset',
                '15 minutes',
            );
            await service.sendForgotPassword(event);
            expect(mailer.sendMail.mock.calls[0][0].context.expiresIn).toBe('15 minutes');
        });

        it('logs error and swallows rejection without leaking the exception', async () => {
            const boom = new Error('boom');
            mailer.sendMail.mockRejectedValueOnce(boom);
            const event = new UserForgotPasswordEvent(
                fakeUser({ email: 'c@x.test' }),
                'tok',
                'https://app.test/reset',
            );
            await expect(service.sendForgotPassword(event)).resolves.toBeUndefined();
            expect(errorSpy).toHaveBeenCalledWith(
                'Failed to send forgot-password email to c@x.test',
                boom.stack,
            );
        });
    });

    describe('sendPasswordChanged (UserPasswordChangedEvent)', () => {
        it('formats changedAt via Intl.DateTimeFormat and forwards device/browser context', async () => {
            const changedAt = new Date('2026-05-08T13:24:00Z');
            const event = new UserPasswordChangedEvent(
                fakeUser({ username: 'dave', email: 'dave@x.test' }),
                changedAt,
                '203.0.113.5',
                'Berlin, DE',
                'iPhone',
                'Safari',
                'https://app.test/secure',
            );

            await service.sendPasswordChanged(event);

            const args = mailer.sendMail.mock.calls[0][0];
            expect(args.to).toBe('dave@x.test');
            expect(args.subject).toBe('Your Ever Works password has been changed');
            expect(args.template).toBe('password-changed');
            expect(args.context).toEqual(
                expect.objectContaining({
                    firstName: 'dave',
                    ipAddress: '203.0.113.5',
                    location: 'Berlin, DE',
                    device: 'iPhone',
                    browser: 'Safari',
                    secureAccountUrl: 'https://app.test/secure',
                }),
            );
            // formatDateTime invokes Intl.DateTimeFormat('en-US', …) — assert the
            // shape of the result rather than the wall-clock value (timezone
            // depends on the runner). All tokens come from
            // {year:'numeric', month:'long', day:'numeric', hour:'2-digit',
            //  minute:'2-digit', timeZoneName:'short'}.
            const changedFormatted: string = args.context.changedAt;
            expect(typeof changedFormatted).toBe('string');
            expect(changedFormatted).toMatch(/2026/);
            expect(changedFormatted).toMatch(/May/);
        });

        it('logs error and swallows on mailer rejection', async () => {
            mailer.sendMail.mockRejectedValueOnce(new Error('x'));
            const event = new UserPasswordChangedEvent(
                fakeUser({ email: 'd@x.test' }),
                new Date(),
                '0.0.0.0',
                'unknown',
                'unknown',
            );
            await expect(service.sendPasswordChanged(event)).resolves.toBeUndefined();
            expect(errorSpy).toHaveBeenCalledWith(
                expect.stringContaining('Failed to send password-changed email to d@x.test'),
                expect.anything(),
            );
        });
    });

    describe('sendWelcomeEmail (UserConfirmedEvent)', () => {
        it('uses provided dashboardUrl verbatim when supplied', async () => {
            const event = new UserConfirmedEvent(
                fakeUser({ username: 'eve', email: 'eve@x.test' }),
                'https://app.test/dashboard',
            );
            await service.sendWelcomeEmail(event);

            expect(mailer.sendMail).toHaveBeenCalledWith(
                expect.objectContaining({
                    to: 'eve@x.test',
                    subject: 'Welcome to Ever Works!',
                    template: 'welcome',
                    context: expect.objectContaining({
                        firstName: 'eve',
                        dashboardUrl: 'https://app.test/dashboard',
                    }),
                }),
            );
        });

        it('falls back to <webAppUrl>/works/new when dashboardUrl is omitted (uses WEB_URL env)', async () => {
            setBranding({ WEB_URL: 'https://staging.test' });
            const event = new UserConfirmedEvent(fakeUser({ email: 'eve@x.test' }));
            await service.sendWelcomeEmail(event);
            expect(mailer.sendMail.mock.calls[0][0].context.dashboardUrl).toBe(
                'https://staging.test/works/new',
            );
        });

        it('falls back to localhost dashboard when WEB_URL is unset', async () => {
            setBranding();
            await service.sendWelcomeEmail(new UserConfirmedEvent(fakeUser()));
            expect(mailer.sendMail.mock.calls[0][0].context.dashboardUrl).toBe(
                'http://localhost:3000/works/new',
            );
        });

        it('logs error and swallows on mailer rejection', async () => {
            mailer.sendMail.mockRejectedValueOnce(new Error('boom'));
            await expect(
                service.sendWelcomeEmail(new UserConfirmedEvent(fakeUser({ email: 'e@x.test' }))),
            ).resolves.toBeUndefined();
            expect(errorSpy).toHaveBeenCalled();
        });
    });

    describe('sendNewDeviceAlert (UserNewDeviceLoginEvent)', () => {
        it('forwards every device/browser/location/IP/url field to the template context', async () => {
            const loginTime = new Date('2026-05-08T08:00:00Z');
            const event = new UserNewDeviceLoginEvent(
                fakeUser({ username: 'frank', email: 'frank@x.test' }),
                loginTime,
                'MacBook',
                'Firefox',
                'Tokyo, JP',
                '198.51.100.7',
                'verify-tok',
                'https://app.test/verify?t=verify-tok',
                'https://app.test/secure',
            );

            await service.sendNewDeviceAlert(event);

            const args = mailer.sendMail.mock.calls[0][0];
            expect(args.subject).toBe('New login to your Ever Works account');
            expect(args.template).toBe('new-device-login');
            expect(args.context).toEqual(
                expect.objectContaining({
                    firstName: 'frank',
                    device: 'MacBook',
                    browser: 'Firefox',
                    location: 'Tokyo, JP',
                    ipAddress: '198.51.100.7',
                    verifyUrl: 'https://app.test/verify?t=verify-tok',
                    verifyToken: 'verify-tok',
                    secureAccountUrl: 'https://app.test/secure',
                }),
            );
            expect(typeof args.context.loginTime).toBe('string');
            expect(args.context.loginTime).toMatch(/2026/);
        });

        it('passes through undefined optional verifyUrl/secureAccountUrl', async () => {
            const event = new UserNewDeviceLoginEvent(
                fakeUser(),
                new Date(),
                'd',
                'b',
                'l',
                'ip',
                'tok',
            );
            await service.sendNewDeviceAlert(event);
            const ctx = mailer.sendMail.mock.calls[0][0].context;
            expect(ctx).toHaveProperty('verifyUrl', undefined);
            expect(ctx).toHaveProperty('secureAccountUrl', undefined);
        });

        it('logs error and swallows on mailer rejection', async () => {
            mailer.sendMail.mockRejectedValueOnce(new Error('boom'));
            await expect(
                service.sendNewDeviceAlert(
                    new UserNewDeviceLoginEvent(
                        fakeUser({ email: 'f@x.test' }),
                        new Date(),
                        'd',
                        'b',
                        'l',
                        'ip',
                        'tok',
                    ),
                ),
            ).resolves.toBeUndefined();
            expect(errorSpy).toHaveBeenCalledWith(
                expect.stringContaining('Failed to send new-device-login email to f@x.test'),
                expect.anything(),
            );
        });
    });

    describe('sendAccountDeletionConfirmation (UserAccountDeletionEvent)', () => {
        it('sends with default expiresIn=24 hours when omitted', async () => {
            const event = new UserAccountDeletionEvent(
                fakeUser({ username: 'gina', email: 'gina@x.test' }),
                'del-tok',
                'https://app.test/delete?t=del-tok',
                'https://app.test/keep',
            );
            await service.sendAccountDeletionConfirmation(event);
            const args = mailer.sendMail.mock.calls[0][0];
            expect(args.subject).toBe('Confirm account deletion');
            expect(args.template).toBe('account-deletion');
            expect(args.context).toEqual(
                expect.objectContaining({
                    firstName: 'gina',
                    deleteUrl: 'https://app.test/delete?t=del-tok',
                    deleteToken: 'del-tok',
                    keepAccountUrl: 'https://app.test/keep',
                    expiresIn: '24 hours',
                }),
            );
        });

        it('forwards explicit expiresIn override (e.g. 1 hour)', async () => {
            const event = new UserAccountDeletionEvent(
                fakeUser(),
                'tok',
                'https://app.test/delete',
                'https://app.test/keep',
                '1 hour',
            );
            await service.sendAccountDeletionConfirmation(event);
            expect(mailer.sendMail.mock.calls[0][0].context.expiresIn).toBe('1 hour');
        });

        it('passes through undefined deleteUrl/keepAccountUrl when omitted', async () => {
            const event = new UserAccountDeletionEvent(fakeUser(), 'tok');
            await service.sendAccountDeletionConfirmation(event);
            const ctx = mailer.sendMail.mock.calls[0][0].context;
            expect(ctx).toHaveProperty('deleteUrl', undefined);
            expect(ctx).toHaveProperty('keepAccountUrl', undefined);
        });

        it('logs error and swallows on mailer rejection', async () => {
            mailer.sendMail.mockRejectedValueOnce(new Error('boom'));
            await expect(
                service.sendAccountDeletionConfirmation(
                    new UserAccountDeletionEvent(fakeUser({ email: 'g@x.test' }), 'tok'),
                ),
            ).resolves.toBeUndefined();
            expect(errorSpy).toHaveBeenCalledWith(
                expect.stringContaining('Failed to send account-deletion email to g@x.test'),
                expect.anything(),
            );
        });
    });

    describe('sendMemberInvitation (MemberInvitedEvent)', () => {
        it('formats role name (capitalise first / lowercase rest) and forwards work/url context', async () => {
            const invitee = fakeUser({ id: 'i1', username: 'henry', email: 'henry@x.test' });
            const inviter = fakeUser({ id: 'r1', username: 'irene', email: 'irene@x.test' });
            const work = { id: 'w1', name: 'My Catalog', slug: 'my-catalog' } as any;
            const event = new MemberInvitedEvent(
                invitee,
                inviter,
                work,
                'EDITOR',
                'https://app.test/works/w1/members?token=invite',
            );

            await service.sendMemberInvitation(event);

            expect(mailer.sendMail).toHaveBeenCalledWith(
                expect.objectContaining({
                    to: 'henry@x.test',
                    subject: "You've been invited to collaborate on My Catalog",
                    template: 'member-invitation',
                    context: expect.objectContaining({
                        inviteeName: 'henry',
                        inviterName: 'irene',
                        workName: 'My Catalog',
                        roleName: 'Editor',
                        workUrl: 'https://app.test/works/w1/members?token=invite',
                    }),
                }),
            );
        });

        it('lowercases mid-word characters of the role string', async () => {
            const event = new MemberInvitedEvent(
                fakeUser({ email: 'h@x.test' }),
                fakeUser(),
                { name: 'Catalog' } as any,
                'mAnAgEr',
                'https://app.test/x',
            );
            await service.sendMemberInvitation(event);
            expect(mailer.sendMail.mock.calls[0][0].context.roleName).toBe('Manager');
        });

        it('renders single-letter role correctly (no out-of-bounds)', async () => {
            const event = new MemberInvitedEvent(
                fakeUser({ email: 'h@x.test' }),
                fakeUser(),
                { name: 'X' } as any,
                'a',
                'https://app.test/x',
            );
            await service.sendMemberInvitation(event);
            expect(mailer.sendMail.mock.calls[0][0].context.roleName).toBe('A');
        });

        it('renders empty-string role as empty (no crash on charAt(0))', async () => {
            const event = new MemberInvitedEvent(
                fakeUser({ email: 'h@x.test' }),
                fakeUser(),
                { name: 'X' } as any,
                '',
                'https://app.test/x',
            );
            await service.sendMemberInvitation(event);
            expect(mailer.sendMail.mock.calls[0][0].context.roleName).toBe('');
        });

        it('logs error against invitee email when mailer rejects', async () => {
            mailer.sendMail.mockRejectedValueOnce(new Error('boom'));
            const event = new MemberInvitedEvent(
                fakeUser({ email: 'invitee@x.test' }),
                fakeUser({ email: 'inviter@x.test' }),
                { name: 'X' } as any,
                'viewer',
                'https://app.test/x',
            );
            await expect(service.sendMemberInvitation(event)).resolves.toBeUndefined();
            // Logged against the INVITEE's email (the recipient), NOT the
            // inviter's — pinned because a future refactor that "improves"
            // logging by using the inviter would silently lose the routing
            // signal that ops engineers grep for.
            expect(errorSpy).toHaveBeenCalledWith(
                'Failed to send member-invitation email to invitee@x.test',
                expect.anything(),
            );
        });
    });

    describe('formatDateTime (private — exercised through changedAt / loginTime fields)', () => {
        it('produces a string containing year + long month for a Date input', async () => {
            const event = new UserPasswordChangedEvent(
                fakeUser(),
                new Date('2026-12-25T15:00:00Z'),
                '0',
                'NYC',
                'Pixel',
            );
            await service.sendPasswordChanged(event);
            const formatted = mailer.sendMail.mock.calls[0][0].context.changedAt;
            expect(formatted).toMatch(/2026/);
            // Long month name (en-US) — December always present regardless of TZ.
            expect(formatted).toMatch(/December/);
        });
    });
});
