import { CreditMeterEventStatus } from '@src/entities/credit-meter-event.entity';
import {
    BillingProviderNotConfiguredError,
    type BillingWebhookEvent,
    type MeterEventOutcome,
} from './billing.provider';
import {
    PAYG_MIN_MONTHLY_CAP_CREDITS,
    PaygCapOutOfRangeError,
    PaygPaymentMethodRequiredError,
    PaygService,
} from './payg.service';

/**
 * Pay-as-you-go on the provider's usage meter (billing spec §3.5). These
 * tests pin the money-shaped rules: enabling needs a card, disabling
 * stops overflow BEFORE the provider call, overflow never exceeds the
 * monthly headroom, the meter row is written before the send and survives
 * a send failure as `pending`, notifications fire once per threshold per
 * cycle, and a failed arrears invoice suspends overflow.
 */
const NOW = new Date('2026-09-10T12:00:00.000Z');
const PERIOD_START = new Date('2026-09-01T00:00:00.000Z');
const PERIOD_END = new Date('2026-10-01T00:00:00.000Z');

function profile(overrides: Record<string, unknown> = {}) {
    return {
        userId: 'u1',
        provider: 'stripe',
        providerCustomerId: 'cus_1',
        defaultPaymentMethodRef: 'pm_1',
        organizationId: null,
        tenantId: null,
        paygEnabled: true,
        paygSubscriptionId: 'sub_payg',
        paygSubscriptionItemId: 'si_1',
        paygStatus: 'active',
        paygPeriodStart: PERIOD_START,
        paygPeriodEnd: PERIOD_END,
        paygMonthlyCapCredits: 1000,
        paygCapNotifiedPercent: 0,
        ...overrides,
    } as any;
}

function snapshot(overrides: Record<string, unknown> = {}) {
    return {
        subscriptionId: 'sub_payg',
        status: 'active',
        cancelAtPeriodEnd: false,
        currentPeriodEnd: PERIOD_END,
        canceledAt: null,
        currentPeriodStart: PERIOD_START,
        subscriptionItemId: 'si_1',
        ...overrides,
    } as any;
}

function makeHarness(options: { profile?: any; used?: number; configured?: boolean } = {}) {
    let stored = options.profile === undefined ? profile() : options.profile;
    const billingProvider = {
        isConfigured: jest.fn(() => options.configured ?? true),
        getProviderId: jest.fn(() => 'stripe'),
        createMeteredSubscription: jest.fn(async () => snapshot()),
        cancelMeteredSubscriptionNow: jest.fn(async () => snapshot({ status: 'canceled' })),
        retrieveSubscriptionSnapshot: jest.fn(async () => snapshot()),
        reportMeterEvent: jest.fn<Promise<MeterEventOutcome>, [unknown]>(async () => ({
            status: 'accepted',
        })),
    };
    const billingProfileRepository = {
        findByUserId: jest.fn(async () => stored),
        findByCustomerId: jest.fn(async () => stored),
        findByPaygSubscriptionId: jest.fn(async () => stored),
        updatePayg: jest.fn(async (_userId: string, patch: Record<string, unknown>) => {
            stored = stored ? { ...stored, ...patch } : stored;
            return stored;
        }),
    };
    const events: any[] = [];
    const creditMeterEventRepository = {
        insertIdempotent: jest.fn(async (write: any) => {
            const existing = events.find((e) => e.identifier === write.identifier);
            if (existing) return { status: 'idempotent', event: existing };
            const event = {
                id: `evt-${events.length + 1}`,
                status: CreditMeterEventStatus.PENDING,
                attempts: 0,
                createdAt: NOW,
                ...write,
            };
            events.push(event);
            return { status: 'created', event };
        }),
        sumCreditsForPeriod: jest.fn(async () => options.used ?? 0),
        findUnsent: jest.fn(async () => []),
        markSent: jest.fn(async (id: string) => {
            const e = events.find((x) => x.id === id);
            if (e) e.status = CreditMeterEventStatus.SENT;
        }),
        recordAttempt: jest.fn(async () => undefined),
        findForUserInPeriod: jest.fn(async () => []),
    } as any;
    creditMeterEventRepository.reserveIdempotentWithinCap = jest.fn(async (reservation: any) => {
        const used = await creditMeterEventRepository.sumCreditsForPeriod();
        const billed = Math.min(
            reservation.requestedCredits,
            Math.max(0, reservation.capCredits - used),
        );
        if (billed <= 0) {
            return {
                status: 'cap-exhausted',
                event: null,
                billedCredits: 0,
                writtenOffCredits: reservation.requestedCredits,
                usedCreditsAfter: used,
            };
        }
        const inserted = await creditMeterEventRepository.insertIdempotent({
            ...reservation.write,
            credits: billed,
            writtenOffCredits: reservation.requestedCredits - billed,
        });
        return {
            ...inserted,
            usedCreditsAfter: used + (inserted.status === 'created' ? billed : 0),
        };
    });
    const notificationService = {
        notifyPaygCapThreshold: jest.fn(async () => undefined),
        notifyPaygPastDue: jest.fn(async () => undefined),
        clearByDeduplicationKey: jest.fn(async () => undefined),
    };
    const service = new PaygService(
        billingProvider as any,
        billingProfileRepository as any,
        creditMeterEventRepository as any,
        notificationService as any,
    );
    return {
        service,
        billingProvider,
        billingProfileRepository,
        creditMeterEventRepository,
        notificationService,
        events,
        stored: () => stored,
    };
}

describe('PaygService.enable', () => {
    it('refuses without a stored payment method (409 at the boundary) and without a provider (503)', async () => {
        const noCard = makeHarness({
            profile: profile({ defaultPaymentMethodRef: null, paygSubscriptionId: null }),
        });
        await expect(noCard.service.enable('u1', {}, NOW)).rejects.toBeInstanceOf(
            PaygPaymentMethodRequiredError,
        );
        expect(noCard.billingProvider.createMeteredSubscription).not.toHaveBeenCalled();

        const off = makeHarness({ configured: false });
        await expect(off.service.enable('u1', {}, NOW)).rejects.toBeInstanceOf(
            BillingProviderNotConfiguredError,
        );
    });

    it('creates the usage subscription from the catalog price and persists its period + cap', async () => {
        const h = makeHarness({
            profile: profile({
                paygEnabled: false,
                paygSubscriptionId: null,
                paygStatus: null,
                paygPeriodStart: null,
                paygPeriodEnd: null,
                paygMonthlyCapCredits: null,
            }),
        });

        const state = await h.service.enable('u1', { monthlyCapCredits: 2500 }, NOW);

        expect(h.billingProvider.createMeteredSubscription).toHaveBeenCalledWith(
            expect.objectContaining({
                userId: 'u1',
                customerId: 'cus_1',
                paymentMethodRef: 'pm_1',
                lookupKey: 'ever_works_payg_credits_monthly',
                invoiceThresholdCents: 5000,
                referenceId: 'u1:payg',
            }),
        );
        expect(h.billingProfileRepository.updatePayg).toHaveBeenCalledWith(
            'u1',
            expect.objectContaining({
                paygEnabled: true,
                paygSubscriptionId: 'sub_payg',
                paygSubscriptionItemId: 'si_1',
                paygStatus: 'active',
                paygPeriodStart: PERIOD_START,
                paygPeriodEnd: PERIOD_END,
                paygMonthlyCapCredits: 2500,
                paygCapNotifiedPercent: 0,
            }),
        );
        expect(state.enabled).toBe(true);
        expect(state.monthlyCapCredits).toBe(2500);
        expect(state.subscriptionStatus).toBe('active');
    });

    it('is idempotent: a live usage subscription is re-read, not re-created', async () => {
        const h = makeHarness();
        await h.service.enable('u1', {}, NOW);
        expect(h.billingProvider.retrieveSubscriptionSnapshot).toHaveBeenCalledWith('sub_payg');
        expect(h.billingProvider.createMeteredSubscription).not.toHaveBeenCalled();
    });

    it('does not create a duplicate when re-reading an existing live subscription fails', async () => {
        const h = makeHarness();
        h.billingProvider.retrieveSubscriptionSnapshot.mockRejectedValueOnce(
            new Error('provider timeout'),
        );

        await expect(h.service.enable('u1', {}, NOW)).rejects.toThrow('provider timeout');
        expect(h.billingProvider.createMeteredSubscription).not.toHaveBeenCalled();
    });

    it('re-creates when the previous usage subscription is canceled', async () => {
        const h = makeHarness({ profile: profile({ paygStatus: 'canceled' }) });
        await h.service.enable('u1', {}, NOW);
        expect(h.billingProvider.createMeteredSubscription).toHaveBeenCalledWith(
            expect.objectContaining({
                idempotencyKey: 'payg-enable:u1:cus_1:after:sub_payg',
            }),
        );
    });

    it('rejects a cap outside the catalog/deployment bounds', async () => {
        const h = makeHarness();
        await expect(h.service.enable('u1', { monthlyCapCredits: 10 }, NOW)).rejects.toBeInstanceOf(
            PaygCapOutOfRangeError,
        );
        await expect(h.service.updateCap('u1', 10_000_000, NOW)).rejects.toBeInstanceOf(
            PaygCapOutOfRangeError,
        );
        await expect(
            h.service.updateCap('u1', PAYG_MIN_MONTHLY_CAP_CREDITS, NOW),
        ).resolves.toMatchObject({
            monthlyCapCredits: PAYG_MIN_MONTHLY_CAP_CREDITS,
        });
    });

    it('never exposes an operator maximum below the supported minimum', async () => {
        const previous = process.env.PAYG_MAX_MONTHLY_CAP_CREDITS;
        process.env.PAYG_MAX_MONTHLY_CAP_CREDITS = '100';
        try {
            const state = await makeHarness().service.getState('u1', NOW);
            expect(state.maxMonthlyCapCredits).toBe(PAYG_MIN_MONTHLY_CAP_CREDITS);
            expect(state.monthlyCapCredits).toBe(PAYG_MIN_MONTHLY_CAP_CREDITS);
        } finally {
            if (previous === undefined) delete process.env.PAYG_MAX_MONTHLY_CAP_CREDITS;
            else process.env.PAYG_MAX_MONTHLY_CAP_CREDITS = previous;
        }
    });
});

describe('PaygService.disable', () => {
    it('clears the flag BEFORE cancelling at the provider, and cancels immediately with invoice_now', async () => {
        const h = makeHarness();
        const order: string[] = [];
        h.billingProfileRepository.updatePayg.mockImplementation(async (_u: string, patch: any) => {
            order.push(`update:${JSON.stringify(patch)}`);
            return profile({ ...patch });
        });
        h.billingProvider.cancelMeteredSubscriptionNow.mockImplementation(async () => {
            order.push('cancel');
            return snapshot({ status: 'canceled' });
        });

        await h.service.disable('u1', NOW);

        expect(order[0]).toBe('update:{"paygEnabled":false}');
        expect(order[1]).toBe('cancel');
        expect(h.billingProvider.cancelMeteredSubscriptionNow).toHaveBeenCalledWith({
            subscriptionId: 'sub_payg',
        });
    });

    it('does not call the provider when there is nothing live to cancel', async () => {
        const h = makeHarness({ profile: profile({ paygStatus: 'canceled' }) });
        await h.service.disable('u1', NOW);
        expect(h.billingProvider.cancelMeteredSubscriptionNow).not.toHaveBeenCalled();
    });
});

describe('PaygService.recordOverflow', () => {
    it('meters the remainder up to the cap headroom, writes the row first, then sends', async () => {
        const h = makeHarness({ used: 700 }); // cap 1000 → headroom 300

        const outcome = await h.service.recordOverflow({
            userId: 'u1',
            runId: 'run-1',
            remainderCredits: 500,
            costCentsRef: 370,
            now: NOW,
        });

        expect(outcome).toEqual({
            status: 'metered',
            billedCredits: 300,
            writtenOffCredits: 200,
            sent: true,
            capReached: true,
        });
        expect(h.creditMeterEventRepository.insertIdempotent).toHaveBeenCalledWith(
            expect.objectContaining({
                userId: 'u1',
                runId: 'run-1',
                identifier: 'run:run-1',
                credits: 300,
                writtenOffCredits: 200,
                costCentsRef: 370,
                periodStart: PERIOD_START,
                periodEnd: PERIOD_END,
            }),
        );
        expect(h.billingProvider.reportMeterEvent).toHaveBeenCalledWith(
            expect.objectContaining({
                eventName: 'ever_works_credits',
                customerId: 'cus_1',
                value: 300,
                identifier: 'run:run-1',
            }),
        );
        expect(h.creditMeterEventRepository.markSent).toHaveBeenCalled();
        // 700 + 300 = 1000 → 100% → one notification at 100.
        expect(h.notificationService.notifyPaygCapThreshold).toHaveBeenCalledWith(
            expect.objectContaining({ percent: 100, usedCredits: 1000, capCredits: 1000 }),
        );
    });

    it('is idempotent on run id — a second settlement of the same run meters nothing new', async () => {
        const h = makeHarness({ used: 0 });
        await h.service.recordOverflow({
            userId: 'u1',
            runId: 'run-1',
            remainderCredits: 50,
            now: NOW,
        });
        const again = await h.service.recordOverflow({
            userId: 'u1',
            runId: 'run-1',
            remainderCredits: 50,
            now: NOW,
        });
        expect(again.status).toBe('metered');
        expect(h.billingProvider.reportMeterEvent).toHaveBeenCalledTimes(1);
        expect(h.events).toHaveLength(1);
    });

    it('leaves the row pending when the provider refuses — the flush cron retries it', async () => {
        const h = makeHarness({ used: 0 });
        h.billingProvider.reportMeterEvent.mockResolvedValueOnce({
            status: 'failed',
            failureCode: 'api_connection_error',
            terminal: false,
        });

        const outcome = await h.service.recordOverflow({
            userId: 'u1',
            runId: 'run-2',
            remainderCredits: 40,
            now: NOW,
        });

        expect(outcome).toMatchObject({ status: 'metered', billedCredits: 40, sent: false });
        expect(h.creditMeterEventRepository.recordAttempt).toHaveBeenCalledWith(
            'evt-1',
            'api_connection_error',
            false,
        );
        expect(h.creditMeterEventRepository.markSent).not.toHaveBeenCalled();
    });

    it.each([
        ['disabled', profile({ paygEnabled: false })],
        ['past due', profile({ paygStatus: 'past_due' })],
        ['no subscription', profile({ paygSubscriptionId: null })],
        ['no profile', null],
    ])(
        'is not eligible when %s — everything is written off, nothing metered',
        async (_label, p) => {
            const h = makeHarness({ profile: p });
            const outcome = await h.service.recordOverflow({
                userId: 'u1',
                runId: 'run-3',
                remainderCredits: 77,
                now: NOW,
            });
            expect(outcome).toEqual({
                status: 'not-eligible',
                billedCredits: 0,
                writtenOffCredits: 77,
            });
            expect(h.creditMeterEventRepository.insertIdempotent).not.toHaveBeenCalled();
        },
    );

    it('at an exhausted cap meters nothing and writes everything off', async () => {
        const h = makeHarness({ used: 1000 });
        const outcome = await h.service.recordOverflow({
            userId: 'u1',
            runId: 'run-4',
            remainderCredits: 10,
            now: NOW,
        });
        expect(outcome).toEqual({
            status: 'cap-exhausted',
            billedCredits: 0,
            writtenOffCredits: 10,
        });
    });

    it('notifies at 80% once, then at 100% once — never twice for the same threshold', async () => {
        const h = makeHarness({ used: 790 });
        await h.service.recordOverflow({
            userId: 'u1',
            runId: 'run-5',
            remainderCredits: 20,
            now: NOW,
        }); // → 810 (81%)
        expect(h.notificationService.notifyPaygCapThreshold).toHaveBeenCalledTimes(1);
        expect(h.notificationService.notifyPaygCapThreshold).toHaveBeenCalledWith(
            expect.objectContaining({ percent: 80 }),
        );
        // The latch is now 80; another crossing at 85% must not re-notify.
        h.creditMeterEventRepository.sumCreditsForPeriod.mockResolvedValue(840);
        await h.service.recordOverflow({
            userId: 'u1',
            runId: 'run-6',
            remainderCredits: 10,
            now: NOW,
        });
        expect(h.notificationService.notifyPaygCapThreshold).toHaveBeenCalledTimes(1);
    });

    it('refreshes a stale period from the provider before measuring the cap', async () => {
        const h = makeHarness({
            profile: profile({ paygPeriodEnd: new Date('2026-09-05T00:00:00.000Z') }),
            used: 0,
        });
        await h.service.recordOverflow({
            userId: 'u1',
            runId: 'run-7',
            remainderCredits: 5,
            now: NOW,
        });
        expect(h.billingProvider.retrieveSubscriptionSnapshot).toHaveBeenCalledWith('sub_payg');
        expect(h.billingProfileRepository.updatePayg).toHaveBeenCalledWith(
            'u1',
            expect.objectContaining({ paygPeriodStart: PERIOD_START, paygPeriodEnd: PERIOD_END }),
        );
    });
});

describe('PaygService.headroom', () => {
    it('is cap minus cycle usage when eligible, else 0', async () => {
        expect(await makeHarness({ used: 250 }).service.headroom('u1', NOW)).toBe(750);
        expect(
            await makeHarness({
                used: 250,
                profile: profile({ paygEnabled: false }),
            }).service.headroom('u1', NOW),
        ).toBe(0);
        expect(await makeHarness({ used: 2000 }).service.headroom('u1', NOW)).toBe(0);
    });
});

describe('PaygService.flushPending', () => {
    it('resends fresh rows but stops before Stripe idempotency expires, preventing a late retry from double-billing', async () => {
        const h = makeHarness();
        const fresh = {
            id: 'e1',
            userId: 'u1',
            identifier: 'run:a',
            credits: 10,
            createdAt: new Date(NOW.getTime() - 5 * 60_000),
        };
        const outsideSafeRetryWindow = {
            id: 'e2',
            userId: 'u1',
            identifier: 'run:b',
            credits: 10,
            // Stripe retains request idempotency / meter-identifier
            // de-duplication for 24h. Past that point the platform cannot
            // distinguish "accepted, local mark failed" from "never sent",
            // so automatic retry must stop before it can double-charge.
            createdAt: new Date(NOW.getTime() - 25 * 60 * 60_000),
        };
        h.creditMeterEventRepository.findUnsent.mockResolvedValue([fresh, outsideSafeRetryWindow]);

        const summary = await h.service.flushPending(100, NOW);

        expect(summary).toEqual({ scanned: 2, sent: 1, retried: 0, failed: 1 });
        expect(h.billingProvider.reportMeterEvent).toHaveBeenCalledTimes(1);
        expect(h.billingProvider.reportMeterEvent).toHaveBeenCalledWith(
            expect.objectContaining({ identifier: 'run:a', timestamp: fresh.createdAt }),
        );
        expect(h.creditMeterEventRepository.markSent).toHaveBeenCalledWith('e1', NOW);
        expect(h.creditMeterEventRepository.recordAttempt).toHaveBeenCalledWith(
            'e2',
            expect.stringContaining('idempotency'),
            true,
        );
    });

    it('does nothing when the provider is not configured', async () => {
        const h = makeHarness({ configured: false });
        expect(await h.service.flushPending(100, NOW)).toEqual({
            scanned: 0,
            sent: 0,
            retried: 0,
            failed: 0,
        });
        expect(h.creditMeterEventRepository.findUnsent).not.toHaveBeenCalled();
    });
});

describe('PaygService webhooks', () => {
    const event = (overrides: Partial<BillingWebhookEvent> = {}): BillingWebhookEvent =>
        ({
            id: 'evt_1',
            kind: 'payg.updated',
            customerId: 'cus_1',
            referenceId: 'u1:payg',
            packId: null,
            amountCents: null,
            currency: 'usd',
            paymentId: null,
            providerType: 'customer.subscription.updated',
            subscriptionId: 'sub_payg',
            subscription: snapshot(),
            ...overrides,
        }) as BillingWebhookEvent;

    it('reconciles the usage subscription snapshot onto the profile and resets the latch on a period roll', async () => {
        const h = makeHarness({ profile: profile({ paygCapNotifiedPercent: 100 }) });
        const rolled = snapshot({
            currentPeriodStart: new Date('2026-10-01T00:00:00.000Z'),
            currentPeriodEnd: new Date('2026-11-01T00:00:00.000Z'),
        });

        await expect(h.service.applyWebhook(event({ subscription: rolled }))).resolves.toBe(
            'payg-reconciled',
        );

        expect(h.billingProfileRepository.updatePayg).toHaveBeenCalledWith(
            'u1',
            expect.objectContaining({
                paygStatus: 'active',
                paygPeriodStart: rolled.currentPeriodStart,
                paygPeriodEnd: rolled.currentPeriodEnd,
                paygCapNotifiedPercent: 0,
            }),
        );
    });

    it('a provider-side cancel turns the feature off', async () => {
        const h = makeHarness();
        await h.service.applyWebhook(event({ subscription: snapshot({ status: 'canceled' }) }));
        expect(h.billingProfileRepository.updatePayg).toHaveBeenCalledWith(
            'u1',
            expect.objectContaining({ paygStatus: 'canceled', paygEnabled: false }),
        );
    });

    it('ignores other kinds and reports unattributed deliveries', async () => {
        const h = makeHarness({ profile: null });
        await expect(h.service.applyWebhook(event({ kind: 'subscription.updated' }))).resolves.toBe(
            'ignored',
        );
        await expect(h.service.applyWebhook(event())).resolves.toBe('unattributed');
    });

    it('a failed pay-as-you-go invoice suspends overflow and notifies; a paid one resumes', async () => {
        const h = makeHarness();
        const invoice = (overrides: Record<string, unknown>) =>
            ({
                providerInvoiceId: 'in_1',
                number: 'A-1',
                status: 'open',
                periodStart: null,
                periodEnd: null,
                subtotalCents: 380,
                totalCents: 380,
                amountPaidCents: 0,
                currency: 'usd',
                hostedUrl: null,
                pdfUrl: null,
                lines: [],
                issuedAt: null,
                subscriptionId: 'sub_payg',
                subscriptionKind: 'payg',
                ...overrides,
            }) as any;

        await h.service.applyInvoice(h.stored(), invoice({ paymentFailed: true }));
        expect(h.billingProfileRepository.updatePayg).toHaveBeenCalledWith('u1', {
            paygStatus: 'past_due',
        });
        expect(h.notificationService.notifyPaygPastDue).toHaveBeenCalledWith({
            userId: 'u1',
            amountCents: 380,
            // Cycle end rides along so the dedup key re-arms next period —
            // a persistent row under a fixed key would announce dunning once
            // per account, ever.
            periodEnd: PERIOD_END,
        });

        await h.service.applyInvoice(h.stored(), invoice({ status: 'paid', amountPaidCents: 380 }));
        expect(h.billingProfileRepository.updatePayg).toHaveBeenCalledWith('u1', {
            paygStatus: 'active',
        });
        expect(h.notificationService.clearByDeduplicationKey).toHaveBeenCalledWith(
            'u1',
            'payg_past_due',
        );

        // A PLAN invoice never touches pay-as-you-go.
        h.billingProfileRepository.updatePayg.mockClear();
        await h.service.applyInvoice(
            h.stored(),
            invoice({ subscriptionKind: 'plan', paymentFailed: true }),
        );
        expect(h.billingProfileRepository.updatePayg).not.toHaveBeenCalled();
    });
});
