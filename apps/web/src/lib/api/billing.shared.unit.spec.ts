// The money path (billing PRD B5) — pure-helper spec for the live
// Billing-page surfaces. The two `can*` helpers hold the whole gating
// rule (master switch AND provider configured), so they are pinned here
// rather than left as inline JSX conditions.

import { describe, expect, it } from 'vitest';
import {
    canBuyCredits,
    canConfigureAutoRecharge,
    formatCardExpiry,
    formatPaymentMethod,
    invoiceStatusTone,
    packBonusPercent,
    type BillingOverview,
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
        expect(
            formatPaymentMethod({ brand: 'visa', last4: '4242', expMonth: 4, expYear: 2031 }),
        ).toBe('Visa •••• 4242');
    });

    it('falls back to a generic label without a brand', () => {
        expect(
            formatPaymentMethod({ brand: null, last4: '4242', expMonth: null, expYear: null }),
        ).toBe('Card •••• 4242');
    });

    it('renders nothing when there is no card on file', () => {
        expect(formatPaymentMethod(null)).toBeNull();
        expect(
            formatPaymentMethod({ brand: 'visa', last4: null, expMonth: null, expYear: null }),
        ).toBeNull();
    });

    it('zero-pads the expiry month', () => {
        expect(formatCardExpiry({ brand: 'visa', last4: '4242', expMonth: 4, expYear: 2031 })).toBe(
            '04 / 2031',
        );
        expect(formatCardExpiry(null)).toBeNull();
        expect(
            formatCardExpiry({ brand: 'visa', last4: '4242', expMonth: null, expYear: 2031 }),
        ).toBeNull();
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
