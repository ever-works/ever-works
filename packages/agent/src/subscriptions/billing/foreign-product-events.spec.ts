import Stripe from 'stripe';
import { BillingService } from './billing.service';
import { PlanSubscriptionService } from './plan-subscription.service';
import {
    StripeBillingProvider,
    STRIPE_METADATA_KEYS,
    STRIPE_PURCHASE_KINDS,
} from './stripe-billing.provider';

/**
 * Audit CC04-08: the platform's own Stripe endpoint
 * (`api.ever.works/api/billing/webhook`, `we_1U7b8H...`) is ACCOUNT-WIDE. The
 * one Stripe account also sells Ever Gauzy, Ever Teams, Rec, Demand, Traduora
 * and Platform through the shared ever.co checkout, directory sponsor ads and
 * GitHands, so every one of their events is delivered here too. On 2026-09-15
 * the Gauzy $99 lifetime sale (`evt_1UFwPn...`) reached this endpoint and was
 * answered 2xx; this spec pins that such an event is IGNORED with ZERO writes.
 *
 * Unlike the provider and service specs, nothing on the path is mocked except
 * storage and the two Stripe read APIs the refund path consults:
 *
 *  - each payload is SIGNED with the real Stripe SDK and verified by the real
 *    `constructEvent`, exactly as a delivery would be;
 *  - the real `StripeBillingProvider` normalizes it;
 *  - the real `BillingService` and the real `PlanSubscriptionService` handle it;
 *  - every repository and collaborator is a recording spy: any method that is
 *    not a lookup (`find*`, `get*`, `count*`, `list*`, `is*`, `has*`) counts as
 *    a WRITE, and the assertion is that there are none.
 *
 * The payload shapes are the real ones: metadata keys and object shapes were
 * read from the live Gauzy $99 session and PaymentIntent (no customer on
 * either; `ever_product`, `ever_hosting`, `ever_tier`, `ever_licence`) and from
 * the shared checkout's subscription metadata. The endpoint's 15 subscribed
 * event types are all covered.
 *
 * A known-DIRTY control runs through the same harness: an Ever Works credit
 * top-up must produce a write, which proves the harness can see one.
 *
 * ASSUMPTION (stated, not tested): every foreign event here names a Stripe
 * customer that has NO Ever Works billing profile, so each customer lookup
 * returns null. `invoice.*` and `payment_method.*` are attributed BY
 * CUSTOMER, so a foreign-product event on a `cus_` that ALSO has a Works
 * billing profile would be attributed to that Works account and would write.
 * This holds only while the shared ever.co checkout and the other products
 * never reuse a Works customer id; if that changes, add that case here and
 * gate attribution on the product metadata.
 */

const WHSEC = 'whsec_foreign_product_spec';
const sdk = new Stripe('sk_test_foreign_product_spec');

const GAUZY_PI = 'pi_3GauzyLifetime000000000';
const GAUZY_CS = 'cs_live_gauzy_lifetime_0000';
const FOREIGN_CUSTOMER = 'cus_ForeignGauzyBuyer';
const FOREIGN_SUB = 'sub_ForeignGauzyTrial';

const GAUZY_SESSION_META = {
    ever_product: 'gauzy',
    ever_hosting: 'selfhosted',
    ever_tier: 'small_business',
    ever_interval: 'lifetime',
    ever_lookup_key: 'ever_gauzy_selfhosted_small_business_lifetime',
};
const GAUZY_PI_META = {
    ever_product: 'gauzy',
    ever_hosting: 'selfhosted',
    ever_tier: 'small_business',
    ever_licence: 'lifetime',
};
const GAUZY_SUB_META = {
    ever_product: 'gauzy',
    ever_hosting: 'cloud',
    ever_tier: 'enterprise',
    ever_interval: 'annual',
    ever_lookup_key: 'ever_gauzy_cloud_enterprise_annual',
};

const READ = /^(find|get|count|list|is|has)/;

interface Recorder {
    writes: string[];
}

/**
 * A stand-in for a repository or service. Lookups resolve to "not found";
 * anything else is recorded as a write. `impl` overrides specific methods.
 */
function spy(label: string, recorder: Recorder, impl: Record<string, unknown> = {}): any {
    const fns = new Map<string, jest.Mock>();
    return new Proxy(
        {},
        {
            get(_target, prop) {
                if (typeof prop !== 'string') return undefined;
                if (prop === 'then') return undefined; // not a thenable
                if (!fns.has(prop)) {
                    const override = impl[prop];
                    fns.set(
                        prop,
                        jest.fn(async (...args: unknown[]) => {
                            if (override !== undefined) {
                                return typeof override === 'function'
                                    ? (override as (...a: unknown[]) => unknown)(...args)
                                    : override;
                            }
                            if (!READ.test(prop)) recorder.writes.push(`${label}.${prop}`);
                            return null;
                        }),
                    );
                }
                return fns.get(prop);
            },
        },
    );
}

function harness(options: { ownProfile?: unknown } = {}) {
    const recorder: Recorder = { writes: [] };

    // Only the two READ endpoints the refund path consults are provided. Any
    // other Stripe call would throw, so an unexpected write to Stripe fails
    // the test loudly instead of passing silently.
    const client = {
        webhooks: sdk.webhooks,
        invoicePayments: {
            // A one-off payment has no invoice; that is what Stripe returns.
            list: jest.fn().mockResolvedValue({ data: [] }),
        },
        paymentIntents: {
            retrieve: jest.fn().mockResolvedValue({
                id: GAUZY_PI,
                customer: null,
                metadata: GAUZY_PI_META,
            }),
        },
    };
    const provider = new StripeBillingProvider(() => client as unknown as Stripe);

    const billingProfiles = spy('billingProfileRepository', recorder, {
        findByCustomerId: async () => options.ownProfile ?? null,
    });
    const creditLedgerRepository = spy('creditLedgerRepository', recorder, {
        // The real method opens a transaction, looks the payment up and
        // returns 'missing-purchase' WITHOUT writing when the payment is not
        // one of our credit purchases (credit-ledger.repository.ts). The
        // ledger here is empty, so that is its answer.
        recordCumulativeRefundAtomic: async () => ({
            status: 'missing-purchase',
            creditsReversed: 0,
        }),
    });
    const creditLedgerService = spy('creditLedgerService', recorder);
    const plans = new PlanSubscriptionService(
        provider,
        spy('subscriptionPlanRepository', recorder),
        spy('userSubscriptionRepository', recorder),
        billingProfiles,
        spy('userRepository', recorder),
        spy('subscriptionService', recorder),
        spy('licencePurchaseRepository', recorder),
        spy('planCreditGrantService', recorder),
    );
    const billing = new BillingService(
        provider,
        billingProfiles,
        spy('invoiceRepository', recorder),
        creditLedgerRepository,
        creditLedgerService,
        spy('userRepository', recorder),
        plans,
        spy('paygService', recorder),
    );
    return { billing, recorder, client };
}

function deliver(billing: BillingService, type: string, object: Record<string, unknown>) {
    const payload = JSON.stringify({
        id: `evt_foreign_${type.replace(/\./g, '_')}`,
        object: 'event',
        type,
        livemode: true,
        created: Math.floor(Date.now() / 1000),
        data: { object, previous_attributes: {} },
    });
    const signature = sdk.webhooks.generateTestHeaderString({ payload, secret: WHSEC });
    return billing.handleWebhook(payload, signature);
}

const gauzyInvoice = {
    id: 'in_ForeignGauzy',
    object: 'invoice',
    customer: FOREIGN_CUSTOMER,
    currency: 'usd',
    total: 166800,
    subtotal: 166800,
    amount_paid: 166800,
    status: 'paid',
    number: 'GAUZY-0001',
    lines: { data: [] },
    parent: {
        type: 'subscription_details',
        subscription_details: { subscription: FOREIGN_SUB, metadata: GAUZY_SUB_META },
    },
};

const gauzySubscription = (status: string) => ({
    id: FOREIGN_SUB,
    object: 'subscription',
    customer: FOREIGN_CUSTOMER,
    status,
    currency: 'usd',
    cancel_at_period_end: false,
    metadata: GAUZY_SUB_META,
    items: { data: [] },
});

/**
 * What the handler reports for a foreign event. Invoice and payment-method
 * handlers look for an Ever Works billing profile first and return
 * 'unattributed' when none resolves; every other handler recognises the
 * event as not Ever Works' and returns 'ignored'. Neither writes anything.
 */
const UNATTRIBUTED_FOREIGN_TYPES = new Set([
    'invoice.finalized',
    'invoice.paid',
    'invoice.payment_failed',
    'invoice.voided',
    'payment_method.attached',
    'payment_method.detached',
]);
const expectedForeignAction = (type: string): 'ignored' | 'unattributed' =>
    UNATTRIBUTED_FOREIGN_TYPES.has(type) ? 'unattributed' : 'ignored';

const FOREIGN_EVENTS: Array<[string, string, Record<string, unknown>]> = [
    [
        'the Gauzy $99 lifetime sale (the real evt_1UFwPn shape: no customer)',
        'checkout.session.completed',
        {
            id: GAUZY_CS,
            object: 'checkout.session',
            mode: 'payment',
            status: 'complete',
            payment_status: 'paid',
            customer: null,
            client_reference_id: null,
            payment_intent: GAUZY_PI,
            amount_total: 9900,
            currency: 'usd',
            metadata: GAUZY_SESSION_META,
        },
    ],
    [
        'a Gauzy Enterprise annual trial bought on ever.co',
        'checkout.session.completed',
        {
            id: 'cs_live_gauzy_trial',
            object: 'checkout.session',
            mode: 'subscription',
            status: 'complete',
            payment_status: 'no_payment_required',
            customer: FOREIGN_CUSTOMER,
            subscription: FOREIGN_SUB,
            client_reference_id: null,
            amount_total: 0,
            currency: 'usd',
            metadata: GAUZY_SUB_META,
        },
    ],
    [
        'a GitHands checkout carrying its own client_reference_id',
        'checkout.session.completed',
        {
            id: 'cs_live_githands',
            object: 'checkout.session',
            mode: 'subscription',
            status: 'complete',
            payment_status: 'paid',
            customer: 'cus_GitHandsBuyer',
            client_reference_id: '5f0c8a2e-0000-4000-8000-000000000001',
            amount_total: 1900,
            currency: 'usd',
            metadata: { product: 'githands' },
        },
    ],
    [
        'a directory sponsor-ad checkout (routed by the relay, not here)',
        'checkout.session.completed',
        {
            id: 'cs_live_directory',
            object: 'checkout.session',
            mode: 'payment',
            status: 'complete',
            payment_status: 'paid',
            customer: 'cus_DirectoryBuyer',
            client_reference_id: null,
            payment_intent: 'pi_directory',
            amount_total: 4900,
            currency: 'usd',
            metadata: { work_id: 'b1e0d2c3-0000-4000-8000-000000000002' },
        },
    ],
    [
        'the Gauzy lifetime PaymentIntent',
        'payment_intent.succeeded',
        {
            id: GAUZY_PI,
            object: 'payment_intent',
            customer: null,
            amount: 9900,
            amount_received: 9900,
            currency: 'usd',
            metadata: GAUZY_PI_META,
        },
    ],
    [
        'a full refund of the Gauzy lifetime sale',
        'charge.refunded',
        {
            id: 'ch_gauzy',
            object: 'charge',
            customer: null,
            payment_intent: GAUZY_PI,
            amount_refunded: 9900,
            refunded: true,
            currency: 'usd',
            metadata: GAUZY_PI_META,
        },
    ],
    [
        'a dispute on the Gauzy lifetime sale',
        'charge.dispute.created',
        {
            id: 'dp_gauzy',
            object: 'dispute',
            payment_intent: GAUZY_PI,
            amount: 9900,
            currency: 'usd',
        },
    ],
    [
        'a Gauzy subscription starting its trial',
        'customer.subscription.created',
        gauzySubscription('trialing'),
    ],
    ['a Gauzy subscription update', 'customer.subscription.updated', gauzySubscription('active')],
    ['a Gauzy subscription ending', 'customer.subscription.deleted', gauzySubscription('canceled')],
    ['a Gauzy subscription pausing', 'customer.subscription.paused', gauzySubscription('paused')],
    ['a Gauzy subscription resuming', 'customer.subscription.resumed', gauzySubscription('active')],
    ['a Gauzy invoice being finalized', 'invoice.finalized', { ...gauzyInvoice, status: 'open' }],
    ['a Gauzy invoice being paid', 'invoice.paid', gauzyInvoice],
    ['a Gauzy invoice failing', 'invoice.payment_failed', { ...gauzyInvoice, status: 'open' }],
    ['a Gauzy invoice being voided', 'invoice.voided', { ...gauzyInvoice, status: 'void' }],
    [
        'a Gauzy buyer saving a card',
        'payment_method.attached',
        {
            id: 'pm_foreign',
            object: 'payment_method',
            customer: FOREIGN_CUSTOMER,
            card: { brand: 'visa', last4: '4242', exp_month: 4, exp_year: 2031 },
        },
    ],
    [
        'a Gauzy buyer removing a card',
        'payment_method.detached',
        {
            id: 'pm_foreign',
            object: 'payment_method',
            customer: null,
            card: { brand: 'visa', last4: '4242', exp_month: 4, exp_year: 2031 },
        },
    ],
];

describe('account-wide billing webhook vs other Ever products (audit CC04-08)', () => {
    const saved: Record<string, string | undefined> = {};

    beforeEach(() => {
        for (const key of ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'])
            saved[key] = process.env[key];
        process.env.STRIPE_SECRET_KEY = 'sk_test_foreign_product_spec';
        process.env.STRIPE_WEBHOOK_SECRET = WHSEC;
    });

    afterEach(() => {
        for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    });

    it('covers every event type the live endpoint subscribes to', () => {
        // we_1U7b8H enabled_events, read from the Stripe API on 2026-09-28.
        const subscribed = [
            'checkout.session.completed',
            'payment_intent.succeeded',
            'charge.refunded',
            'charge.dispute.created',
            'customer.subscription.created',
            'customer.subscription.updated',
            'customer.subscription.deleted',
            'customer.subscription.paused',
            'customer.subscription.resumed',
            'invoice.finalized',
            'invoice.paid',
            'invoice.payment_failed',
            'invoice.voided',
            'payment_method.attached',
            'payment_method.detached',
        ];
        expect(new Set(FOREIGN_EVENTS.map(([, type]) => type))).toEqual(new Set(subscribed));
    });

    it.each(FOREIGN_EVENTS)('ignores %s with no writes', async (_label, type, object) => {
        const { billing, recorder } = harness();

        const outcome = await deliver(billing, type, object);

        // Exact per type, so a normalisation regression that flips one
        // handler from "not ours" to "ours but unresolved" (or back) fails.
        expect(outcome.action).toBe(expectedForeignAction(type));
        expect(recorder.writes).toEqual([]);
    });

    it('asks Stripe only READ questions about a foreign refund, and then ignores it', async () => {
        const { billing, recorder, client } = harness();

        const outcome = await deliver(billing, 'charge.refunded', FOREIGN_EVENTS[5][2]);

        expect(outcome.action).toBe('ignored');
        expect(client.invoicePayments.list).toHaveBeenCalledTimes(1);
        expect(client.paymentIntents.retrieve).toHaveBeenCalledWith(GAUZY_PI);
        expect(recorder.writes).toEqual([]);
    });

    it('CONTROL: the same harness sees the write an Ever Works credit top-up makes', async () => {
        const { billing, recorder } = harness({
            ownProfile: { userId: 'u1', provider: 'stripe', providerCustomerId: 'cus_EverWorks' },
        });

        const outcome = await deliver(billing, 'checkout.session.completed', {
            id: 'cs_ever_works',
            object: 'checkout.session',
            mode: 'payment',
            status: 'complete',
            payment_status: 'paid',
            customer: 'cus_EverWorks',
            client_reference_id: 'u1:credits-1000',
            payment_intent: 'pi_ever_works',
            amount_total: 1000,
            currency: 'usd',
            metadata: {
                [STRIPE_METADATA_KEYS.kind]: STRIPE_PURCHASE_KINDS.checkout,
                [STRIPE_METADATA_KEYS.packId]: 'credits-1000',
            },
        });

        expect(outcome.action).toBe('credited');
        expect(recorder.writes).toContain('creditLedgerService.record');
    });

    it('CONTROL: a tampered signature never reaches the handler', async () => {
        const { billing, recorder } = harness();
        const payload = JSON.stringify({
            id: 'evt_tampered',
            object: 'event',
            type: 'checkout.session.completed',
            data: { object: FOREIGN_EVENTS[0][2] },
        });
        const signature = sdk.webhooks.generateTestHeaderString({ payload, secret: 'whsec_wrong' });

        await expect(billing.handleWebhook(payload, signature)).rejects.toThrow(
            'Webhook signature verification failed',
        );
        expect(recorder.writes).toEqual([]);
    });
});
