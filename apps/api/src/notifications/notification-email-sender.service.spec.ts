jest.mock('@ever-works/agent/database', () => ({
    NotificationEventTypeRepository: class {},
    UserRepository: class {},
}));
jest.mock('@src/mail/mail.service', () => ({ MailService: class {} }));

import { NotificationEmailSenderService } from './notification-email-sender.service';

describe('NotificationEmailSenderService', () => {
    const ORIGINAL_PROVIDER = process.env.MAILER_PROVIDER;
    let users: { findById: jest.Mock };
    let mail: { sendNotificationEmail: jest.Mock };
    let eventTypes: { findByKey: jest.Mock };
    let service: NotificationEmailSenderService;

    const input = {
        userId: 'user-1',
        eventKey: 'agent_run_escalated',
        title: 'Agent needs a decision',
        message: 'Checks stayed red after three attempts.',
        actionUrl: '/tasks/t-1',
        actionLabel: 'Review',
    };

    beforeEach(() => {
        process.env.MAILER_PROVIDER = 'smtp';
        users = {
            findById: jest.fn().mockResolvedValue({
                id: 'user-1',
                email: 'owner@example.com',
                emailVerified: true,
                username: 'owner',
            }),
        };
        mail = { sendNotificationEmail: jest.fn().mockResolvedValue(true) };
        eventTypes = {
            findByKey: jest.fn().mockResolvedValue({ title: 'Agent needs a decision' }),
        };
        service = new NotificationEmailSenderService(
            users as never,
            mail as never,
            eventTypes as never,
        );
    });

    afterAll(() => {
        if (ORIGINAL_PROVIDER === undefined) delete process.env.MAILER_PROVIDER;
        else process.env.MAILER_PROVIDER = ORIGINAL_PROVIDER;
    });

    it('emails the account address with the deep link, the matrix link and the event the reason names', async () => {
        await expect(service.deliver(input)).resolves.toEqual({ status: 'delivered' });
        expect(mail.sendNotificationEmail).toHaveBeenCalledWith('owner@example.com', 'owner', {
            title: 'Agent needs a decision',
            message: 'Checks stayed red after three attempts.',
            eventTitle: 'Agent needs a decision',
            actionUrl: '/tasks/t-1',
            actionLabel: 'Review',
            settingsPath: '/settings/notifications',
        });
    });

    it('names the matrix row by its registry title even when the notification title differs', async () => {
        eventTypes.findByKey.mockResolvedValue({ title: 'Approval requested' });
        await service.deliver({
            ...input,
            eventKey: 'inbox_approval_requested',
            title: 'Deploy to prod?',
        });
        expect(mail.sendNotificationEmail.mock.calls[0][2].eventTitle).toBe('Approval requested');
    });

    it('reports not-configured, and looks nothing up, when the deployment has no mail transport', async () => {
        delete process.env.MAILER_PROVIDER;
        await expect(service.deliver(input)).resolves.toEqual({
            status: 'not-configured',
            error: 'not-configured',
        });
        expect(users.findById).not.toHaveBeenCalled();
        expect(mail.sendNotificationEmail).not.toHaveBeenCalled();
    });

    it('refuses an unverified address', async () => {
        users.findById.mockResolvedValue({
            id: 'user-1',
            email: 'owner@example.com',
            emailVerified: false,
        });
        await expect(service.deliver(input)).resolves.toEqual({
            status: 'failed',
            error: 'address-unverified',
        });
        expect(mail.sendNotificationEmail).not.toHaveBeenCalled();
    });

    it('refuses an account without an address, or a missing account', async () => {
        users.findById.mockResolvedValue({ id: 'user-1', email: null, emailVerified: false });
        await expect(service.deliver(input)).resolves.toMatchObject({ error: 'no-address' });
        users.findById.mockResolvedValue(null);
        await expect(service.deliver(input)).resolves.toMatchObject({ error: 'no-address' });
    });

    it('lets a transport error propagate so the delivery is retried', async () => {
        mail.sendNotificationEmail.mockRejectedValue(new Error('SMTP 421'));
        await expect(service.deliver(input)).rejects.toThrow('SMTP 421');
    });

    it('never logs the recipient address', async () => {
        const logger = (
            service as unknown as { logger: Record<string, (...args: unknown[]) => void> }
        ).logger;
        const spies = ['log', 'warn', 'error', 'debug', 'verbose'].map((level) => {
            const spy = jest.fn();
            logger[level] = spy;
            return spy;
        });
        await service.deliver(input);
        for (const spy of spies) {
            for (const call of spy.mock.calls) {
                expect(JSON.stringify(call)).not.toContain('owner@example.com');
            }
        }
    });

    it.each([
        [{ email: 'a@b.c', emailVerified: true }, 'smtp', 'available'],
        [{ email: 'a@b.c', emailVerified: false }, 'smtp', 'unverified'],
        [null, 'smtp', 'unverified'],
        [{ email: 'a@b.c', emailVerified: true }, undefined, 'not-configured'],
    ] as const)(
        'reports availability for %j with provider %s as %s',
        (user, provider, expected) => {
            if (provider) process.env.MAILER_PROVIDER = provider;
            else delete process.env.MAILER_PROVIDER;
            expect(service.availabilityFor(user)).toBe(expected);
        },
    );
});
