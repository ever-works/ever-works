import { SubscriptionStatus } from '@src/entities/user-subscription.entity';
import { NotificationService } from '@src/notifications/notification.service';
import type { BillingWebhookEvent } from './billing.provider';
import { BillingService } from './billing.service';
import {
    STRIPE_METADATA_KEYS,
    STRIPE_PURCHASE_KINDS,
    StripeBillingProvider,
} from './stripe-billing.provider';
import { BILLING_TRIAL_ENDING_EVENT, TrialReminderService } from './trial-reminder.service';
import { PlanCreditGrantService } from '../credits/plan-credit-grant.service';
import { CreditsSweepService } from '../credits/credits-sweep.service';

/**
 * Owner rules, 2026-10-09, for the 90-day Cloud trial:
 *  1. one trial per account and per organization (plan-subscription.service.spec covers checkout);
 *  2. a trial runs on FREE-plan credits only: no monthly plan allowance until it converts;
 *  3. a reminder (in-app + email) 7 days and ~3 days before it ends, once each.
 */

const DAY = 24 * 60 * 60 * 1000;
const planMeta = {
    [STRIPE_METADATA_KEYS.kind]: STRIPE_PURCHASE_KINDS.planSubscription,
    [STRIPE_METADATA_KEYS.planCode]: 'standard',
    [STRIPE_METADATA_KEYS.referenceId]: 'u1:standard',
};

describe('Stripe normalization — trial signals', () => {
    const ENV = ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'] as const;
    const saved: Record<string, string | undefined> = {};
    beforeEach(() => {
        for (const key of ENV) saved[key] = process.env[key];
        process.env.STRIPE_SECRET_KEY = 'sk_test_x';
        process.env.STRIPE_WEBHOOK_SECRET = 'whsec_x';
    });
    afterEach(() => {
        for (const key of ENV) {
            if (saved[key] === undefined) delete process.env[key];
            else process.env[key] = saved[key];
        }
    });

    function providerWith(client: Record<string, unknown>) {
        return new StripeBillingProvider(jest.fn().mockReturnValue(client) as any);
    }
    const parse = (raw: unknown) =>
        providerWith({
            webhooks: { constructEvent: jest.fn().mockReturnValue(raw) },
        }).verifyAndParseWebhook('{}', 'sig');

    it('normalizes customer.subscription.trial_will_end on OUR plan to its own kind with trialEnd', async () => {
        const normalized = await parse({
            id: 'evt_t1',
            type: 'customer.subscription.trial_will_end',
            data: {
                object: {
                    id: 'sub_1',
                    status: 'trialing',
                    customer: 'cus_1',
                    trial_end: 1800000000,
                    cancel_at_period_end: false,
                    metadata: planMeta,
                },
            },
        });
        expect(normalized).toEqual(
            expect.objectContaining({
                kind: 'subscription.trial_will_end',
                subscriptionId: 'sub_1',
                customerId: 'cus_1',
                planCode: 'standard',
                trialEnd: new Date(1800000000 * 1000),
            }),
        );
    });

    it('ignores trial_will_end for a subscription we did not sell, or one no longer trialing', async () => {
        const foreign = await parse({
            id: 'evt_t2',
            type: 'customer.subscription.trial_will_end',
            data: {
                object: { id: 'sub_x', status: 'trialing', trial_end: 1800000000, metadata: {} },
            },
        });
        expect(foreign.kind).toBe('ignored');
        const ended = await parse({
            id: 'evt_t3',
            type: 'customer.subscription.trial_will_end',
            data: {
                object: {
                    id: 'sub_1',
                    status: 'active',
                    trial_end: 1800000000,
                    metadata: planMeta,
                },
            },
        });
        expect(ended.kind).toBe('ignored');
    });

    it('flags a trialing subscription activation as inTrial, an active one as not', async () => {
        const trialing = await parse({
            id: 'evt_a1',
            type: 'customer.subscription.created',
            data: {
                object: { id: 'sub_1', status: 'trialing', customer: 'cus_1', metadata: planMeta },
            },
        });
        expect(trialing).toEqual(
            expect.objectContaining({ kind: 'subscription.activated', inTrial: true }),
        );
        const converted = await parse({
            id: 'evt_a2',
            type: 'customer.subscription.updated',
            data: {
                object: { id: 'sub_1', status: 'active', customer: 'cus_1', metadata: planMeta },
            },
        });
        expect(converted).toEqual(
            expect.objectContaining({ kind: 'subscription.activated', inTrial: false }),
        );
    });

    it('flags a completed checkout that was created with a trial as inTrial', async () => {
        const normalized = await parse({
            id: 'evt_c1',
            type: 'checkout.session.completed',
            data: {
                object: {
                    id: 'cs_1',
                    customer: 'cus_1',
                    subscription: 'sub_1',
                    payment_status: 'no_payment_required',
                    amount_total: 0,
                    metadata: { ...planMeta, [STRIPE_METADATA_KEYS.trialDays]: '90' },
                },
            },
        });
        expect(normalized).toEqual(
            expect.objectContaining({ kind: 'subscription.activated', inTrial: true }),
        );
    });

    it('stamps the trial length on the checkout session AND the subscription metadata', async () => {
        const create = jest.fn().mockResolvedValue({ id: 'cs_1', url: 'https://pay.example/cs_1' });
        const provider = providerWith({
            customers: { create: jest.fn().mockResolvedValue({ id: 'cus_1' }), update: jest.fn() },
            checkout: { sessions: { create } },
        });
        await provider.createPlanCheckoutSession({
            userId: 'u1',
            customerId: 'cus_1',
            plan: {
                code: 'standard',
                label: 'Pro plan',
                priceCents: 4900,
                currency: 'usd',
                interval: 'month',
                mode: 'subscription',
                trialPeriodDays: 90,
            },
            successUrl: 'https://app.test/ok',
            cancelUrl: 'https://app.test/no',
            referenceId: 'u1:standard',
        } as any);
        const params = create.mock.calls[0][0];
        expect(params.metadata[STRIPE_METADATA_KEYS.trialDays]).toBe('90');
        expect(params.subscription_data.metadata[STRIPE_METADATA_KEYS.trialDays]).toBe('90');
        expect(params.subscription_data.trial_period_days).toBe(90);
    });

    it('hasHadPlanSubscription: true only for a plan subscription we sold, in ANY status', async () => {
        const list = jest
            .fn()
            .mockResolvedValueOnce({
                data: [
                    {
                        id: 'sub_payg',
                        metadata: {
                            [STRIPE_METADATA_KEYS.kind]: STRIPE_PURCHASE_KINDS.paygSubscription,
                        },
                    },
                    { id: 'sub_old', status: 'canceled', metadata: planMeta },
                ],
                has_more: false,
            })
            .mockResolvedValueOnce({ data: [{ id: 'sub_payg', metadata: {} }], has_more: false });
        const provider = providerWith({ subscriptions: { list } });

        await expect(provider.hasHadPlanSubscription('cus_1')).resolves.toBe(true);
        expect(list).toHaveBeenCalledWith(
            expect.objectContaining({ customer: 'cus_1', status: 'all', limit: 100 }),
        );
        await expect(provider.hasHadPlanSubscription('cus_2')).resolves.toBe(false);
    });
});

describe('PlanCreditGrantService — no plan allowance during a trial', () => {
    function harness(profile: Record<string, unknown> | null) {
        const creditLedgerService = {
            hasEntry: jest.fn().mockResolvedValue(false),
            record: jest.fn(async (opts: any) => ({ id: 'entry-1', ...opts })),
        };
        const userSubscriptionRepository = {
            findActiveByUser: jest.fn().mockResolvedValue({
                id: 'row-1',
                userId: 'u1',
                status: SubscriptionStatus.ACTIVE,
                providerSubscriptionId: 'sub_1',
                createdAt: new Date('2026-10-01T00:00:00Z'),
                plan: {
                    code: 'standard',
                    displayName: 'Pro',
                    hosting: 'cloud',
                    monthlyCredits: 3000,
                },
            }),
        };
        const billingProfileRepository = { findByUserId: jest.fn().mockResolvedValue(profile) };
        const service = new (PlanCreditGrantService as any)(
            creditLedgerService,
            userSubscriptionRepository,
            billingProfileRepository,
        ) as PlanCreditGrantService;
        return { service, creditLedgerService };
    }

    it('grants nothing while the provider says the subscription is trialing', async () => {
        const { service, creditLedgerService } = harness({
            subscriptionStatus: 'trialing',
            providerSubscriptionId: 'sub_1',
        });
        await expect(service.grantCurrentAllowance('u1')).resolves.toBe('not-eligible');
        expect(creditLedgerService.record).not.toHaveBeenCalled();
    });

    it('grants the full allowance once the trial converted (status active)', async () => {
        const { service, creditLedgerService } = harness({
            subscriptionStatus: 'active',
            providerSubscriptionId: 'sub_1',
        });
        await expect(service.grantCurrentAllowance('u1')).resolves.toBe('granted');
        expect(creditLedgerService.record).toHaveBeenCalledWith(
            expect.objectContaining({ amountCredits: 3000 }),
        );
    });

    it('is not blocked by a trialing profile that tracks a DIFFERENT subscription', async () => {
        const { service } = harness({
            subscriptionStatus: 'trialing',
            providerSubscriptionId: 'sub_other',
        });
        await expect(service.grantCurrentAllowance('u1')).resolves.toBe('granted');
    });
});

describe('TrialReminderService', () => {
    it('emits on the event name the API mail handler listens on', () => {
        expect(BILLING_TRIAL_ENDING_EVENT).toBe('billing.trial-ending');
    });

    function harness(opts: { created?: boolean; profiles?: any[] } = {}) {
        const notificationService = {
            notifyTrialEnding: jest.fn().mockResolvedValue(opts.created ?? true),
        };
        const eventEmitter = { emit: jest.fn() };
        const billingProfileRepository = {
            findTrialsEndingBetween: jest.fn().mockResolvedValue(opts.profiles ?? []),
        };
        const userSubscriptionRepository = {
            findByProviderSubscriptionId: jest.fn().mockResolvedValue({ planCode: 'standard' }),
        };
        const planRepository = {
            findByCode: jest.fn().mockResolvedValue({ code: 'standard', displayName: 'Pro' }),
        };
        const service = new TrialReminderService(
            billingProfileRepository as any,
            userSubscriptionRepository as any,
            planRepository as any,
            notificationService as any,
            eventEmitter as any,
        );
        return { service, notificationService, eventEmitter, billingProfileRepository };
    }
    const trialEnd = new Date('2026-12-30T10:00:00Z');

    it('writes the in-app reminder and emits the email event once', async () => {
        const { service, notificationService, eventEmitter } = harness();
        await expect(
            service.remind({
                userId: 'u1',
                subscriptionId: 'sub_1',
                planCode: 'standard',
                trialEnd,
                lead: '3d',
            }),
        ).resolves.toBe(true);
        expect(notificationService.notifyTrialEnding).toHaveBeenCalledWith(
            expect.objectContaining({ subscriptionId: 'sub_1', lead: '3d', planName: 'Pro plan' }),
        );
        expect(eventEmitter.emit).toHaveBeenCalledWith(
            BILLING_TRIAL_ENDING_EVENT,
            expect.objectContaining({ userId: 'u1', lead: '3d', trialEnd, planName: 'Pro plan' }),
        );
    });

    it('NotificationService: a dismissed reminder does not re-arm (once per subscription and lead, ever)', async () => {
        const repository = {
            findByDeduplicationKey: jest.fn().mockResolvedValue({ id: 'n1', isDismissed: true }),
            create: jest.fn(),
        };
        const notifications = new NotificationService(repository as any);
        await expect(
            notifications.notifyTrialEnding({
                userId: 'u1',
                subscriptionId: 'sub_1',
                lead: '7d',
                planName: 'Pro plan',
                trialEnd,
            }),
        ).resolves.toBe(false);
        expect(repository.create).not.toHaveBeenCalled();
    });

    it('sends no second email when the reminder row already exists (webhook re-delivery)', async () => {
        const { service, eventEmitter } = harness({ created: false });
        await expect(
            service.remind({
                userId: 'u1',
                subscriptionId: 'sub_1',
                planCode: 'standard',
                trialEnd,
                lead: '3d',
            }),
        ).resolves.toBe(false);
        expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('sends nothing for a trial already set to cancel (no charge is coming)', async () => {
        const { service, notificationService, eventEmitter } = harness();
        await service.remind({
            userId: 'u1',
            subscriptionId: 'sub_1',
            planCode: 'standard',
            trialEnd,
            lead: '7d',
            cancelAtPeriodEnd: true,
        });
        expect(notificationService.notifyTrialEnding).not.toHaveBeenCalled();
        expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('sweeps trials ending 3-7 days out (so a failed reminder is retried) and reminds each with lead 7d', async () => {
        const now = new Date('2026-12-23T00:05:00Z');
        const { service, billingProfileRepository, eventEmitter } = harness({
            profiles: [
                {
                    userId: 'u1',
                    providerSubscriptionId: 'sub_1',
                    currentPeriodEnd: trialEnd,
                    cancelAtPeriodEnd: false,
                },
            ],
        });
        const summary = await service.sweepSevenDayReminders(now);
        expect(billingProfileRepository.findTrialsEndingBetween).toHaveBeenCalledWith(
            new Date(now.getTime() + 3 * DAY),
            new Date(now.getTime() + 7 * DAY),
            500,
            0,
        );
        expect(summary).toEqual({ scanned: 1, reminded: 1, alreadyReminded: 0, failed: 0 });
        expect(eventEmitter.emit).toHaveBeenCalledWith(
            BILLING_TRIAL_ENDING_EVENT,
            expect.objectContaining({ lead: '7d', subscriptionId: 'sub_1' }),
        );
    });

    it('runs as the 4th pass of the daily credits sweep', async () => {
        const trialReminderService = {
            sweepSevenDayReminders: jest
                .fn()
                .mockResolvedValue({ scanned: 2, reminded: 1, alreadyReminded: 1, failed: 0 }),
        };
        const sweep = new CreditsSweepService(
            {
                expireDueCredits: jest.fn().mockResolvedValue({ users: 0, buckets: 0, credits: 0 }),
                dispatchDailyGrants: jest.fn().mockResolvedValue({}),
            } as any,
            { dispatchPlanGrants: jest.fn().mockResolvedValue({}) } as any,
            trialReminderService as any,
        );
        const summary = await sweep.runDailySweep(new Date('2026-12-23T00:05:00Z'));
        expect(summary.trialReminders).toEqual({
            scanned: 2,
            reminded: 1,
            alreadyReminded: 1,
            failed: 0,
        });
    });
});

describe('BillingService — trial_will_end webhook', () => {
    function build(remind: jest.Mock) {
        const provider = {
            getProviderId: jest.fn().mockReturnValue('stripe'),
            verifyAndParseWebhook: jest.fn(),
        };
        const profiles = {
            findByCustomerId: jest
                .fn()
                .mockResolvedValue({ userId: 'u1', providerCustomerId: 'cus_1' }),
            findByUserId: jest.fn().mockResolvedValue(null),
        };
        const service = new BillingService(
            provider as any,
            profiles as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            undefined,
            undefined,
            { remind } as any,
        );
        return { service, provider };
    }
    const evt: BillingWebhookEvent = {
        id: 'evt_t1',
        kind: 'subscription.trial_will_end',
        customerId: 'cus_1',
        referenceId: null,
        packId: null,
        amountCents: null,
        currency: null,
        paymentId: null,
        providerType: 'customer.subscription.trial_will_end',
        subscriptionId: 'sub_1',
        planCode: 'standard',
        trialEnd: new Date('2026-12-30T10:00:00Z'),
        cancelAtPeriodEnd: false,
    };

    it('routes the provider notice to the 3-day reminder for the attributed owner', async () => {
        const remind = jest.fn().mockResolvedValue(true);
        const { service, provider } = build(remind);
        provider.verifyAndParseWebhook.mockResolvedValue(evt);

        const outcome = await service.handleWebhook('{}', 'sig');

        expect(remind).toHaveBeenCalledWith(
            expect.objectContaining({ userId: 'u1', subscriptionId: 'sub_1', lead: '3d' }),
        );
        expect(outcome.action).toBe('trial-reminder-sent');
    });

    it('acknowledges a re-delivery as idempotent', async () => {
        const remind = jest.fn().mockResolvedValue(false);
        const { service, provider } = build(remind);
        provider.verifyAndParseWebhook.mockResolvedValue(evt);
        await expect(service.handleWebhook('{}', 'sig')).resolves.toEqual(
            expect.objectContaining({ action: 'trial-reminder-idempotent' }),
        );
    });
});

describe('Trial end on the subscription row: gates and anchors the plan allowance', () => {
    const trialEnd = new Date('2026-12-30T00:00:00Z');
    function harness(row: Record<string, unknown>) {
        const creditLedgerService = {
            hasEntry: jest.fn().mockResolvedValue(false),
            record: jest.fn(async (opts: any) => ({ id: 'entry-1', ...opts })),
        };
        const userSubscriptionRepository = {
            findActiveByUser: jest.fn().mockResolvedValue({
                id: 'row-1',
                userId: 'u1',
                status: SubscriptionStatus.ACTIVE,
                providerSubscriptionId: 'sub_1',
                createdAt: new Date('2026-10-01T00:00:00Z'),
                plan: {
                    code: 'standard',
                    displayName: 'Pro',
                    hosting: 'cloud',
                    monthlyCredits: 3000,
                },
                ...row,
            }),
        };
        const service = new (PlanCreditGrantService as any)(
            creditLedgerService,
            userSubscriptionRepository,
            { findByUserId: jest.fn().mockResolvedValue(null) },
        ) as PlanCreditGrantService;
        return { service, creditLedgerService };
    }

    it('grants nothing before trialEndsAt even with no profile status (return route raced the webhook)', async () => {
        const { service, creditLedgerService } = harness({ trialEndsAt: trialEnd });
        await expect(
            service.grantCurrentAllowance('u1', new Date('2026-11-15T00:00:00Z')),
        ).resolves.toBe('not-eligible');
        expect(creditLedgerService.record).not.toHaveBeenCalled();
    });

    it('anchors the first paid allowance month on the trial end, so it lasts a full month', async () => {
        const { service, creditLedgerService } = harness({ trialEndsAt: trialEnd });
        await expect(
            service.grantCurrentAllowance('u1', new Date('2026-12-30T00:05:00Z')),
        ).resolves.toBe('granted');
        expect(creditLedgerService.record).toHaveBeenCalledWith(
            expect.objectContaining({
                amountCredits: 3000,
                expiresAt: new Date('2027-01-30T00:00:00Z'),
            }),
        );
    });

    it('keeps the createdAt anchor for a subscription that never trialled', async () => {
        const { service, creditLedgerService } = harness({ trialEndsAt: null });
        await service.grantCurrentAllowance('u1', new Date('2026-10-10T00:00:00Z'));
        expect(creditLedgerService.record).toHaveBeenCalledWith(
            expect.objectContaining({ expiresAt: new Date('2026-11-01T00:00:00Z') }),
        );
    });
});

describe('Out-of-order Stripe events cannot hold back the paid allowance', () => {
    it('ignores a stale trialing profile once the row says the trial has ended', async () => {
        const creditLedgerService = {
            hasEntry: jest.fn().mockResolvedValue(false),
            record: jest.fn(async (opts: any) => ({ id: 'entry-1', ...opts })),
        };
        const service = new (PlanCreditGrantService as any)(
            creditLedgerService,
            {
                findActiveByUser: jest.fn().mockResolvedValue({
                    id: 'row-1',
                    userId: 'u1',
                    status: SubscriptionStatus.ACTIVE,
                    providerSubscriptionId: 'sub_1',
                    createdAt: new Date('2026-10-01T00:00:00Z'),
                    trialEndsAt: new Date('2026-12-30T00:00:00Z'),
                    plan: {
                        code: 'standard',
                        displayName: 'Pro',
                        hosting: 'cloud',
                        monthlyCredits: 3000,
                    },
                }),
            },
            {
                findByUserId: jest.fn().mockResolvedValue({
                    subscriptionStatus: 'trialing',
                    providerSubscriptionId: 'sub_1',
                }),
            },
        ) as PlanCreditGrantService;
        await expect(
            service.grantCurrentAllowance('u1', new Date('2027-01-05T00:00:00Z')),
        ).resolves.toBe('granted');
    });
});
