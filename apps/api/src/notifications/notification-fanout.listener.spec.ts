jest.mock('@ever-works/agent/notifications', () => ({
    ...jest.requireActual('../../../../packages/agent/src/notifications/core-event-catalogue'),
    NOTIFICATION_FANOUT_EVENT: 'notifications-v2.fanout-requested',
    UserNotificationSubscriptionService: class {},
}));
jest.mock('@ever-works/agent/facades', () => ({
    NotificationChannelFacadeService: class {},
}));

import { NotificationFanoutListener, shouldSkipBuiltInEmail } from './notification-fanout.listener';

/**
 * Attention controls (AW-13) — what the fan-out hands to the channel facade:
 * the structured content the email target renders, and never the email
 * target when that would repeat an email the owner already has.
 */
describe('NotificationFanoutListener', () => {
    let send: jest.Mock;
    let resolvePlan: jest.Mock;
    let listener: NotificationFanoutListener;

    const payload = {
        userId: 'user-1',
        eventKey: 'agent_run_escalated',
        title: 'Agent needs a decision',
        message: 'Checks stayed red.',
        actionUrl: '/tasks/t-1',
        actionLabel: 'Review',
        urgent: true,
    };

    beforeEach(() => {
        send = jest.fn(async (_u, _e, _p, resolve) => {
            const targets = await resolve('user-1', payload.eventKey);
            return targets.map((t: { channelId: string }) => ({
                channelId: t.channelId,
                status: 'delivered',
            }));
        });
        resolvePlan = jest
            .fn()
            .mockResolvedValue({ immediate: ['in-app', 'email', 'ch-1'], deferred: [] });
        listener = new NotificationFanoutListener({ send } as never, { resolvePlan } as never);
        jest.spyOn(
            (listener as unknown as { logger: { log: () => void } }).logger,
            'log',
        ).mockImplementation(() => undefined);
    });

    async function targetsFor(p: typeof payload & { deduplicated?: boolean }) {
        await listener.handleFanout(p);
        const resolver = send.mock.calls.at(-1)[3];
        return resolver(p.userId, p.eventKey);
    }

    it('passes the title, message and action to the facade as structured content', async () => {
        await listener.handleFanout(payload);
        expect(send.mock.calls[0][2]).toMatchObject({
            text: 'Agent needs a decision: Checks stayed red.',
            eventType: 'agent_run_escalated',
            content: {
                title: 'Agent needs a decision',
                message: 'Checks stayed red.',
                actionUrl: '/tasks/t-1',
                actionLabel: 'Review',
            },
        });
    });

    it('fans out to email and chat channels, never to the in-app sentinel', async () => {
        await expect(targetsFor(payload)).resolves.toEqual([
            { channelId: 'email' },
            { channelId: 'ch-1' },
        ]);
    });

    it('keeps quiet-hours deferral for email', async () => {
        resolvePlan.mockResolvedValue({
            immediate: ['in-app'],
            deferred: ['email'],
            deferUntil: '2026-09-15T07:00:00.000Z',
        });
        await expect(targetsFor({ ...payload, eventKey: 'generation_error' })).resolves.toEqual([
            { channelId: 'email', deferUntil: '2026-09-15T07:00:00.000Z' },
        ]);
    });

    it('does not email again about a still-open, deduplicated notification, but still reaches chat', async () => {
        await expect(targetsFor({ ...payload, deduplicated: true })).resolves.toEqual([
            { channelId: 'ch-1' },
        ]);
    });

    it.each(['budget_threshold_warning', 'budget_threshold_reached'])(
        'never emails %s here — its email is sent by the budget alert handler',
        async (eventKey) => {
            await expect(targetsFor({ ...payload, eventKey })).resolves.toEqual([
                { channelId: 'ch-1' },
            ]);
        },
    );

    it('swallows a resolver failure: nothing is delivered and nothing is thrown at the producer', async () => {
        resolvePlan.mockRejectedValue(new Error('db'));
        await expect(targetsFor(payload)).resolves.toEqual([]);
    });

    it('decides the email skip from the catalogue and the dedup flag only', () => {
        expect(shouldSkipBuiltInEmail('agent_run_escalated')).toBe(false);
        expect(shouldSkipBuiltInEmail('agent_run_escalated', { deduplicated: false })).toBe(false);
        expect(shouldSkipBuiltInEmail('agent_run_escalated', { deduplicated: true })).toBe(true);
        expect(shouldSkipBuiltInEmail('budget_threshold_reached')).toBe(true);
        expect(shouldSkipBuiltInEmail('plugin:unknown')).toBe(false);
    });
});
