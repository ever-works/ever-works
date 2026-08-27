import Stripe from 'stripe';

/**
 * Verifies a Stripe webhook signature against an ARBITRARY signing secret.
 *
 * `StripeBillingProvider.verifyWebhook` exists already, but it is hard-bound to
 * the platform's own receiver secret (`config.billing.stripe.getWebhookSecret()`).
 * The shared **relay** endpoint has its own, separate signing secret, so it needs
 * the same verification with a different key.
 *
 * 🛑 Deliberately delegates to the official SDK. `constructEvent` performs the
 * constant-time HMAC comparison (`secureCompare`) AND the delivery-timestamp
 * tolerance check. We do not hand-roll the scheme — see the posture notes on
 * `BillingWebhookController`.
 *
 * The API key passed to the constructor is irrelevant here: `constructEvent` is
 * pure crypto over the raw body and never performs a network call. A placeholder
 * keeps the relay receiver working on a deployment that verifies-and-forwards
 * without holding a Stripe secret key of its own.
 */
export function constructStripeEvent(
    rawBody: string | Buffer,
    signature: string,
    webhookSecret: string,
): Stripe.Event {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || 'sk_relay_verification_only');
    // Throws on any mismatch; callers translate that into one undifferentiated
    // 401 so the response cannot be used to probe configuration.
    return stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
}
