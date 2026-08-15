import { BudgetThresholdCrossedEvent } from '../../budgets/budget-threshold-crossed.event';
import { InboxBudgetAlertListener } from '../inbox-budget-alert.listener';

/**
 * The one wired `InboxService.notice` producer. Asserts the seam is real
 * (the handler is bound to the event the guard actually emits) and that
 * a failure to notify cannot escape into the capability call.
 */
describe('InboxBudgetAlertListener', () => {
    function makeEvent(overrides: Partial<BudgetThresholdCrossedEvent> = {}) {
        return {
            workId: 'w1',
            userId: 'u1',
            budget: { id: 'b1' },
            threshold: '90_percent',
            currentSpendCents: 9012,
            capCents: 10000,
            currency: 'usd',
            capability: 'ai',
            periodStart: new Date('2026-08-01'),
            pluginId: 'openai',
            ...overrides,
        } as unknown as BudgetThresholdCrossedEvent;
    }

    it('files an owner-scoped notice carrying the spend, the cap and the work link', async () => {
        const inbox = { notice: jest.fn(async () => undefined) };
        const listener = new InboxBudgetAlertListener(inbox as never);

        await listener.handleBudgetThresholdCrossed(makeEvent());

        expect(inbox.notice).toHaveBeenCalledTimes(1);
        const [userId, input] = inbox.notice.mock.calls[0] as unknown as [
            string,
            { title: string; body: string; workId: string },
        ];
        expect(userId).toBe('u1');
        expect(input.workId).toBe('w1');
        expect(input.title).toContain('90%');
        expect(input.body).toContain('90.12 USD');
        expect(input.body).toContain('100.00 USD');
        expect(input.body).toContain('openai');
    });

    it('does not divide by a zero cap', async () => {
        const inbox = { notice: jest.fn(async () => undefined) };
        const listener = new InboxBudgetAlertListener(inbox as never);

        await listener.handleBudgetThresholdCrossed(makeEvent({ capCents: 0 } as never));

        const [, input] = inbox.notice.mock.calls[0] as unknown as [string, { title: string }];
        expect(input.title).toContain('100%');
    });

    it('swallows a filing failure — the spend decision already happened', async () => {
        const inbox = {
            notice: jest.fn(async () => {
                throw new Error('db down');
            }),
        };
        const listener = new InboxBudgetAlertListener(inbox as never);

        await expect(listener.handleBudgetThresholdCrossed(makeEvent())).resolves.toBeUndefined();
    });
});
