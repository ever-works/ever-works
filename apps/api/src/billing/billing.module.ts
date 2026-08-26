import { Module } from '@nestjs/common';
import { AuthModule } from '@src/auth';
import { SubscriptionsModule as AgentSubscriptionsModule } from '@ever-works/agent/subscriptions';
import { OrganizationsModule } from '@src/organizations/organizations.module';
import { BillingController, CreditsCheckoutController } from './billing.controller';
import { BillingWebhookController } from './billing-webhook.controller';
import { PlanCheckoutController } from './plan-checkout.controller';
import { PaymentMethodController } from './payment-method.controller';
import { PaygController } from './payg.controller';
import { SeatsController } from './seats.controller';
import { StripeRelayModule } from './stripe-relay/stripe-relay.module';

/**
 * The money path (billing PRD B5) — thin API module over the agent-side
 * `BillingService` / `BillingProvider` seam.
 *
 * Seven controllers, two auth postures:
 *   - `BillingController` + `CreditsCheckoutController` +
 *     `PlanCheckoutController` + `PaymentMethodController` +
 *     `PaygController`: session-guarded, owner-scoped (overview, invoices,
 *     auto-recharge, packs, credit checkout, plan checkout, payment
 *     methods, pay-as-you-go, seats).
 *   - `BillingWebhookController`: @Public, authenticated by the provider
 *     request signature and fail-closed when unconfigured.
 *
 * `OrganizationsModule` is imported for the ONE audited implementation of
 * the tenant-ownership check (`OrganizationMembershipService`), so a plan
 * checkout naming an `organizationId` outside the caller's tenant is
 * rejected the same way every other raw-`orgId` route rejects it.
 *
 * Additive: the existing read-only `CreditsController` (balance, ledger,
 * usage-summary) in `subscriptions/` is untouched, and so is the
 * read-only payment-method summary on `GET /api/billing/overview`.
 */
@Module({
    imports: [
        AuthModule,
        AgentSubscriptionsModule,
        OrganizationsModule,
        // The SHARED Stripe webhook relay (relay phase 3) — one Stripe endpoint
        // that routes each event to the directory that owns it. Ships dark
        // behind STRIPE_RELAY_ENABLED; additive beside the receiver above.
        StripeRelayModule,
    ],
    controllers: [
        BillingController,
        CreditsCheckoutController,
        PlanCheckoutController,
        PaymentMethodController,
        // Pay-as-you-go (billing spec §3.5) — enable/disable/cap + state.
        PaygController,
        // Seats (billing spec §3.6) — allowance/usage + buying extras.
        SeatsController,
        BillingWebhookController,
    ],
})
export class BillingApiModule {}
