import { MailService, toWebAppLink } from './mail.service';
import type { MailerService } from './providers/mailer.service';

/**
 * Attention controls (AW-13) — the notification email behind the matrix's
 * built-in email target. It must link only back into the product, carry the
 * "you get this because" line's event, and fail loudly so delivery retries.
 */
describe('MailService.sendNotificationEmail', () => {
    const ORIGINAL_ENV = { ...process.env };
    let mailer: { sendMail: jest.Mock };
    let service: MailService;

    beforeEach(() => {
        process.env.WEB_URL = 'https://app.example.test/';
        process.env.APP_NAME = 'Ever Works';
        mailer = { sendMail: jest.fn().mockResolvedValue(undefined) };
        service = new MailService(mailer as unknown as MailerService);
    });

    afterAll(() => {
        process.env = ORIGINAL_ENV;
    });

    const context = {
        title: 'Agent needs a decision',
        message: 'Checks stayed red.',
        eventTitle: 'Agent needs a decision',
        actionUrl: '/tasks/t-1',
        actionLabel: 'Review',
        settingsPath: '/settings/notifications',
    };

    it('renders the notification template with absolute in-product links', async () => {
        await expect(
            service.sendNotificationEmail('owner@example.com', 'owner', context),
        ).resolves.toBe(true);
        const sent = mailer.sendMail.mock.calls[0][0];
        expect(sent).toMatchObject({
            to: 'owner@example.com',
            template: 'notification',
        });
        expect(sent.subject).toContain('Agent needs a decision');
        expect(sent.context).toMatchObject({
            title: 'Agent needs a decision',
            message: 'Checks stayed red.',
            eventTitle: 'Agent needs a decision',
            actionUrl: 'https://app.example.test/tasks/t-1',
            actionLabel: 'Review',
            settingsUrl: 'https://app.example.test/settings/notifications',
        });
    });

    it('carries every field the strict template reads, even without an action', async () => {
        await service.sendNotificationEmail('owner@example.com', 'owner', {
            ...context,
            actionUrl: null,
            actionLabel: null,
        });
        const ctx = mailer.sendMail.mock.calls[0][0].context;
        for (const key of [
            'appName',
            'companyOwner',
            'currentYear',
            'title',
            'message',
            'eventTitle',
            'actionUrl',
            'actionLabel',
            'settingsUrl',
        ]) {
            expect(ctx).toHaveProperty(key);
        }
        expect(ctx.actionUrl).toBeNull();
    });

    it('sends nothing to an account without an address', async () => {
        await expect(service.sendNotificationEmail(null, 'owner', context)).resolves.toBe(false);
        expect(mailer.sendMail).not.toHaveBeenCalled();
    });

    it('throws a transport failure so the delivery task can retry it', async () => {
        mailer.sendMail.mockRejectedValue(new Error('SMTP 421'));
        await expect(
            service.sendNotificationEmail('owner@example.com', 'owner', context),
        ).rejects.toThrow('SMTP 421');
    });
});

describe('toWebAppLink', () => {
    it('joins a relative in-app path onto the web origin', () => {
        expect(toWebAppLink('https://app.example.test/', '/inbox?id=1')).toBe(
            'https://app.example.test/inbox?id=1',
        );
    });

    it.each([
        'https://evil.example/x',
        '//evil.example/x',
        '/\\evil.example',
        'javascript:alert(1)',
        '',
    ])('refuses %j so an email never links outside the product', (path) => {
        expect(toWebAppLink('https://app.example.test', path)).toBeNull();
    });

    it('returns null for a missing path', () => {
        expect(toWebAppLink('https://app.example.test', undefined)).toBeNull();
        expect(toWebAppLink('https://app.example.test', null)).toBeNull();
    });
});
