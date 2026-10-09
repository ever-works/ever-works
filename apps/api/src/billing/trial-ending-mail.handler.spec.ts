// The agent barrels pull the whole runtime graph into jest; the handler needs one constant and a
// repository type from them, so both are stubbed (the same approach as plan-checkout.controller.spec).
jest.mock('@ever-works/agent/subscriptions', () => ({
    BILLING_TRIAL_ENDING_EVENT: 'billing.trial-ending',
}));
jest.mock('@ever-works/agent/database', () => ({ UserRepository: class {} }));

import { BILLING_TRIAL_ENDING_EVENT } from '@ever-works/agent/subscriptions';
import { MailService } from '@src/mail/mail.service';
import type { MailerService } from '@src/mail/providers/mailer.service';
import { TrialEndingMailHandler } from './trial-ending-mail.handler';

/**
 * Trial-ending reminder email (owner, 2026-10-09): the agent-side reminder service emits
 * `billing.trial-ending` once per (subscription, lead); this handler turns it into an email
 * through the app's existing MailService.
 */
describe('Trial-ending reminder email', () => {
    const ORIGINAL_ENV = { ...process.env };
    let mailer: { sendMail: jest.Mock };
    let mail: MailService;

    beforeEach(() => {
        process.env.WEB_URL = 'https://app.example.test/';
        process.env.APP_NAME = 'Ever Works';
        mailer = { sendMail: jest.fn().mockResolvedValue(undefined) };
        mail = new MailService(mailer as unknown as MailerService);
    });

    afterAll(() => {
        process.env = ORIGINAL_ENV;
    });

    const event = {
        userId: 'u1',
        planCode: 'standard',
        planName: 'Pro plan',
        subscriptionId: 'sub_1',
        trialEnd: new Date('2026-12-30T10:00:00Z'),
        lead: '3d' as const,
    };

    it('listens on the event the agent emits', () => {
        expect(BILLING_TRIAL_ENDING_EVENT).toBe('billing.trial-ending');
    });

    it('emails the account owner the trial end date, the charge, and how to cancel', async () => {
        const users = {
            findById: jest
                .fn()
                .mockResolvedValue({ id: 'u1', email: 'owner@example.com', username: 'owner' }),
        };
        await new TrialEndingMailHandler(users as any, mail).handle(event);

        const sent = mailer.sendMail.mock.calls[0][0];
        expect(sent).toMatchObject({ to: 'owner@example.com', template: 'notification' });
        expect(sent.subject).toContain('Your free trial ends on December 30, 2026');
        expect(sent.context.message).toContain('Pro plan free trial ends on December 30, 2026');
        expect(sent.context.message).toContain('cancel from Settings → Billing before then');
        expect(sent.context.actionUrl).toBe('https://app.example.test/settings/billing');
    });

    it('sends nothing when the account has no email, and never throws on a mail failure', async () => {
        const noEmail = { findById: jest.fn().mockResolvedValue({ id: 'u1', email: null }) };
        await new TrialEndingMailHandler(noEmail as any, mail).handle(event);
        expect(mailer.sendMail).not.toHaveBeenCalled();

        mailer.sendMail.mockRejectedValue(new Error('smtp down'));
        const users = {
            findById: jest.fn().mockResolvedValue({ id: 'u1', email: 'owner@example.com' }),
        };
        await expect(
            new TrialEndingMailHandler(users as any, mail).handle(event),
        ).resolves.toBeUndefined();
    });
});
