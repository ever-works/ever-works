// The money path (billing PRD B5) — pure-helper spec for the live
// Billing-page surfaces. The two `can*` helpers hold the whole gating
// rule (master switch AND provider configured), so they are pinned here
// rather than left as inline JSX conditions.

import { describe, expect, it } from 'vitest';
import {
    canBuyCredits,
    canCancelSubscription,
    canConfigureAutoRecharge,
    canConfigurePayg,
    estimatePaygCents,
    formatCentsPerCredit,
    canResumeSubscription,
    canUpgradePlan,
    formatCardExpiry,
    formatPaymentMethod,
    invoiceStatusTone,
    isSubscriptionPastDue,
    packBonusPercent,
    subscriptionState,
    subscriptionStatusLabelKey,
    subscriptionStatusTone,
    canManagePaymentMethods,
    canRemovePaymentMethod,
    type BillingOverview,
    type PaygState,
    type SubscriptionState,
    type PaymentMethodRow,
} from './billing.shared';

function overview(partial: Partial<BillingOverview> = {}): BillingOverview {
    return {
        status: 'success',
        providerConfigured: true,
        providerId: 'stripe',
        currency: 'usd',
        packs: [],
        balanceCredits: 0,
        paymentMethod: null,
        autoRecharge: { enabled: false, thresholdCredits: null, packId: null, failureCount: 0 },
        ...partial,
    };
}

/** A live, manageable subscription unless a test says otherwise. */
function subscription(partial: Partial<SubscriptionState> = {}): SubscriptionState {
    return {
        status: 'active',
        cancelAtPeriodEnd: false,
        currentPeriodEnd: '2026-08-01T00:00:00.000Z',
        canceledAt: null,
        pastDue: false,
        manageable: true,
        ...partial,
    };
}

function method(partial: Partial<PaymentMethodRow> = {}): PaymentMethodRow {
    return {
        id: 'a'.repeat(32),
        brand: 'visa',
        last4: '4242',
        expMonth: 4,
        expYear: 2031,
        isDefault: false,
        ...partial,
    };
}

describe('packBonusPercent', () => {
    it('is 0 at the 1 credit = 1¢ par rate', () => {
        expect(packBonusPercent({ priceCents: 1000, credits: 1000 })).toBe(0);
    });

    it('reports the volume bonus on the larger packs', () => {
        expect(packBonusPercent({ priceCents: 5000, credits: 5500 })).toBe(10);
        expect(packBonusPercent({ priceCents: 20000, credits: 25000 })).toBe(25);
    });

    it('never reports a negative bonus', () => {
        expect(packBonusPercent({ priceCents: 1000, credits: 500 })).toBe(0);
        expect(packBonusPercent({ priceCents: 0, credits: 500 })).toBe(0);
    });
});

describe('formatPaymentMethod / formatCardExpiry', () => {
    it('renders brand + last4 only', () => {
        expect(formatPaymentMethod({ brand: 'visa', last4: '4242' })).toBe('Visa •••• 4242');
    });

    it('falls back to a generic label without a brand', () => {
        expect(formatPaymentMethod({ brand: null, last4: '4242' })).toBe('Card •••• 4242');
    });

    it('renders nothing when there is no card on file', () => {
        expect(formatPaymentMethod(null)).toBeNull();
        expect(formatPaymentMethod({ brand: 'visa', last4: null })).toBeNull();
    });

    it('zero-pads the expiry month', () => {
        expect(formatCardExpiry({ expMonth: 4, expYear: 2031 })).toBe('04 / 2031');
        expect(formatCardExpiry(null)).toBeNull();
        expect(formatCardExpiry({ expMonth: null, expYear: 2031 })).toBeNull();
    });
});

describe('invoiceStatusTone', () => {
    it('maps paid to positive and the failure states to negative', () => {
        expect(invoiceStatusTone('paid')).toBe('positive');
        expect(invoiceStatusTone('void')).toBe('negative');
        expect(invoiceStatusTone('uncollectible')).toBe('negative');
        expect(invoiceStatusTone('refunded')).toBe('negative');
        expect(invoiceStatusTone('open')).toBe('neutral');
        expect(invoiceStatusTone('draft')).toBe('neutral');
    });
});

describe('canBuyCredits — the master switch AND the provider must agree', () => {
    it('is false when the deployment flag is off, even with a configured provider', () => {
        expect(canBuyCredits(overview({ providerConfigured: true }), false)).toBe(false);
    });

    it('is false when the provider is not configured, even with the flag on', () => {
        expect(canBuyCredits(overview({ providerConfigured: false }), true)).toBe(false);
    });

    it('is false when the overview could not be loaded at all', () => {
        expect(canBuyCredits(null, true)).toBe(false);
    });

    it('is true only when both gates pass', () => {
        expect(canBuyCredits(overview({ providerConfigured: true }), true)).toBe(true);
    });
});

describe('canConfigureAutoRecharge', () => {
    const withCard = overview({
        providerConfigured: true,
        paymentMethod: { brand: 'visa', last4: '4242', expMonth: 4, expYear: 2031 },
    });

    it('requires a saved payment method on top of the buy gates', () => {
        expect(canConfigureAutoRecharge(overview({ providerConfigured: true }), true)).toBe(false);
        expect(canConfigureAutoRecharge(withCard, true)).toBe(true);
    });

    it('is false whenever buying is off', () => {
        expect(canConfigureAutoRecharge(withCard, false)).toBe(false);
    });
});

describe('canUpgradePlan — a tier is only sellable when it can also be applied', () => {
    const configured = overview({ providerConfigured: true });

    it('needs the payments master switch', () => {
        expect(canUpgradePlan(configured, false, true)).toBe(false);
    });

    it('needs a configured provider', () => {
        expect(canUpgradePlan(overview({ providerConfigured: false }), true, true)).toBe(false);
    });

    it('needs subscriptions to be enabled — an upgrade that cannot apply is not offered', () => {
        expect(canUpgradePlan(configured, true, false)).toBe(false);
    });

    it('is false when the overview could not be loaded at all', () => {
        expect(canUpgradePlan(null, true, true)).toBe(false);
    });

    it('is true only when all three gates pass', () => {
        expect(canUpgradePlan(configured, true, true)).toBe(true);
    });
});

/**
 * Subscription lifecycle (audit B07/B08). These helpers ARE the UI rule:
 * which chip renders, whether the past-due banner shows, and whether the
 * page offers cancel or resume. Pinning them here keeps the JSX free of
 * untested conditionals.
 */
describe('subscriptionState — a missing block never crashes the page', () => {
    it('falls back to `none` when the API omitted the subscription', () => {
        expect(subscriptionState(overview())).toEqual({
            status: 'none',
            cancelAtPeriodEnd: false,
            currentPeriodEnd: null,
            canceledAt: null,
            pastDue: false,
            manageable: false,
        });
    });

    it('falls back to `none` when the overview failed to load', () => {
        expect(subscriptionState(null).status).toBe('none');
    });
});

describe('subscriptionStatusTone / subscriptionStatusLabelKey (B08)', () => {
    it('reads a free account (`none`) as healthy, not broken', () => {
        expect(subscriptionStatusTone('none')).toBe('positive');
        expect(subscriptionStatusTone('active')).toBe('positive');
        expect(subscriptionStatusTone('trialing')).toBe('positive');
    });

    it('flags the uncollected states as negative', () => {
        expect(subscriptionStatusTone('past_due')).toBe('negative');
        expect(subscriptionStatusTone('unpaid')).toBe('negative');
    });

    it('keeps the pre-existing key for the common case, adds keys for the rest', () => {
        expect(subscriptionStatusLabelKey('none')).toBe('currentPlan.statusActive');
        expect(subscriptionStatusLabelKey('active')).toBe('currentPlan.statusActive');
        expect(subscriptionStatusLabelKey('past_due')).toBe('currentPlan.statuses.past_due');
        expect(subscriptionStatusLabelKey('canceled')).toBe('currentPlan.statuses.canceled');
    });
});

describe('isSubscriptionPastDue — when the recovery banner shows', () => {
    it('shows for past_due and unpaid', () => {
        expect(
            isSubscriptionPastDue(overview({ subscription: subscription({ status: 'past_due' }) })),
        ).toBe(true);
        expect(
            isSubscriptionPastDue(overview({ subscription: subscription({ status: 'unpaid' }) })),
        ).toBe(true);
    });

    it('does not show for a healthy or absent subscription', () => {
        expect(isSubscriptionPastDue(overview({ subscription: subscription() }))).toBe(false);
        expect(isSubscriptionPastDue(overview())).toBe(false);
        expect(isSubscriptionPastDue(null)).toBe(false);
    });

    it('trusts the server-computed flag even if the token set later grows', () => {
        expect(
            isSubscriptionPastDue(
                overview({ subscription: subscription({ status: 'active', pastDue: true }) }),
            ),
        ).toBe(true);
    });
});

describe('canCancelSubscription / canResumeSubscription (B07)', () => {
    it('offers cancel on a live, manageable subscription', () => {
        expect(canCancelSubscription(overview({ subscription: subscription() }), true)).toBe(true);
        expect(canResumeSubscription(overview({ subscription: subscription() }), true)).toBe(false);
    });

    it('swaps to resume once a cancellation is pending', () => {
        const pending = overview({ subscription: subscription({ cancelAtPeriodEnd: true }) });
        expect(canCancelSubscription(pending, true)).toBe(false);
        expect(canResumeSubscription(pending, true)).toBe(true);
    });

    it('offers neither once the subscription has actually ended', () => {
        const ended = overview({
            subscription: subscription({ status: 'canceled', cancelAtPeriodEnd: true }),
        });
        expect(canCancelSubscription(ended, true)).toBe(false);
        expect(canResumeSubscription(ended, true)).toBe(false);
    });

    it('still offers cancel while the subscription is past due', () => {
        expect(
            canCancelSubscription(
                overview({ subscription: subscription({ status: 'past_due' }) }),
                true,
            ),
        ).toBe(true);
    });

    it('offers nothing on a free account with no provider subscription', () => {
        expect(canCancelSubscription(overview(), true)).toBe(false);
        expect(canResumeSubscription(overview(), true)).toBe(false);
    });

    it('offers nothing when the subscription is not manageable', () => {
        const unmanageable = overview({ subscription: subscription({ manageable: false }) });
        expect(canCancelSubscription(unmanageable, true)).toBe(false);
        expect(canResumeSubscription(unmanageable, true)).toBe(false);
    });

    it('respects the deployment master switch and the provider gate', () => {
        const live = overview({ subscription: subscription() });
        expect(canCancelSubscription(live, false)).toBe(false);
        expect(
            canCancelSubscription(
                overview({ providerConfigured: false, subscription: subscription() }),
                true,
            ),
        ).toBe(false);
    });
});

describe('canManagePaymentMethods — same two gates as buying', () => {
    it('is false when the deployment flag is off', () => {
        expect(canManagePaymentMethods({ providerConfigured: true }, false)).toBe(false);
    });

    it('is false when the provider is not configured', () => {
        expect(canManagePaymentMethods({ providerConfigured: false }, true)).toBe(false);
    });

    it('is false when the list could not be loaded at all', () => {
        expect(canManagePaymentMethods(null, true)).toBe(false);
    });

    it('is true only when both gates pass', () => {
        expect(canManagePaymentMethods({ providerConfigured: true }, true)).toBe(true);
    });
});

describe('canRemovePaymentMethod — the last card on a paid plan is protected', () => {
    it('refuses the last card while a paid plan is active', () => {
        expect(canRemovePaymentMethod([method()], true)).toBe(false);
    });

    it('allows the last card on a free plan', () => {
        expect(canRemovePaymentMethod([method()], false)).toBe(true);
    });

    it('allows removing when a replacement exists, paid plan or not', () => {
        const two = [method(), method({ id: 'b'.repeat(32) })];
        expect(canRemovePaymentMethod(two, true)).toBe(true);
        expect(canRemovePaymentMethod(two, false)).toBe(true);
    });

    it('stays conservative on an empty list — a state the server never sees', () => {
        // The helper is a faithful mirror of the server guard, which is
        // `all.length <= 1 && hasActivePaidSubscription` — so an empty
        // list answers the same way a single-card list does.
        //
        // That case is unreachable in practice: `remove()` runs
        // `requireOwnedMethod` first, so a card that does not exist is a
        // 404 long before the last-card rule is consulted, and `all`
        // therefore always holds at least the card being removed. With
        // zero cards the UI renders no remove button at all, so the value
        // is never read. Pinned as false because mirroring the server
        // exactly matters more than a nicer answer to a question nobody
        // asks.
        expect(canRemovePaymentMethod([], true)).toBe(false);
        expect(canRemovePaymentMethod([], false)).toBe(true);
    });
});

describe('formatters accept a payment-method row (no provider reference needed)', () => {
    it('formats brand + last four', () => {
        expect(formatPaymentMethod(method({ brand: 'amex', last4: '1881' }))).toBe(
            'Amex •••• 1881',
        );
    });

    it('formats the expiry', () => {
        expect(formatCardExpiry(method({ expMonth: 9, expYear: 2030 }))).toBe('09 / 2030');
    });
});

// ── Pay-as-you-go (billing spec §3.5) ──────────────────────────────────

function paygState(partial: Partial<PaygState> = {}): PaygState {
    return {
        available: true,
        enabled: false,
        subscriptionStatus: 'none',
        pastDue: false,
        monthlyCapCredits: 10000,
        defaultMonthlyCapCredits: 10000,
        maxMonthlyCapCredits: 100000,
        minMonthlyCapCredits: 500,
        cycleUsedCredits: 0,
        cycleEstimateCents: 0,
        periodStart: null,
        periodEnd: null,
        tiers: [
            { upTo: 5000, centsPerCredit: '1' },
            { upTo: 25000, centsPerCredit: '0.91' },
            { upTo: null, centsPerCredit: '0.8' },
        ],
        invoiceThresholdCents: 5000,
        ...partial,
    };
}

describe('canConfigurePayg — buy gates + a card on file + the feature being available', () => {
    const card = { brand: 'visa', last4: '4242', expMonth: 4, expYear: 2031 };

    it('offers pay-as-you-go only when payments are on, the provider is wired, PAYG is available and a card exists', () => {
        const ready = overview({
            providerConfigured: true,
            paymentMethod: card,
            payg: paygState(),
        });
        expect(canConfigurePayg(ready, true)).toBe(true);
        expect(canConfigurePayg(ready, false)).toBe(false);
        expect(
            canConfigurePayg(
                overview({ providerConfigured: false, paymentMethod: card, payg: paygState() }),
                true,
            ),
        ).toBe(false);
        expect(
            canConfigurePayg(
                overview({ providerConfigured: true, paymentMethod: null, payg: paygState() }),
                true,
            ),
        ).toBe(false);
        expect(
            canConfigurePayg(
                overview({
                    providerConfigured: true,
                    paymentMethod: card,
                    payg: paygState({ available: false }),
                }),
                true,
            ),
        ).toBe(false);
        expect(
            canConfigurePayg(overview({ providerConfigured: true, paymentMethod: card }), true),
        ).toBe(false);
        expect(canConfigurePayg(null, true)).toBe(false);
    });
});

describe('estimatePaygCents — graduated arithmetic shared with the API', () => {
    const tiers = paygState().tiers;

    it('bills each span at its own rate and rounds once at the end', () => {
        expect(estimatePaygCents(0, tiers)).toBe(0);
        expect(estimatePaygCents(-3, tiers)).toBe(0);
        expect(estimatePaygCents(5000, tiers)).toBe(5000);
        expect(estimatePaygCents(6000, tiers)).toBe(5000 + 910);
        expect(estimatePaygCents(30000, tiers)).toBe(5000 + 18200 + 4000);
        // Fractional credits are floored — the ledger only ever holds integers.
        expect(estimatePaygCents(10.9, tiers)).toBe(11 - 1); // 10 credits × 1¢
    });
});

describe('formatCentsPerCredit — display rate', () => {
    it('renders two decimals with the cent sign', () => {
        expect(formatCentsPerCredit('1')).toBe('1.00¢');
        expect(formatCentsPerCredit('0.91')).toBe('0.91¢');
        expect(formatCentsPerCredit('0.8')).toBe('0.80¢');
    });
});
