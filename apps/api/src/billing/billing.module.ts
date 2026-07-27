import { Module } from '@nestjs/common';
import { AuthModule } from '@src/auth';
import { SubscriptionsModule as AgentSubscriptionsModule } from '@ever-works/agent/subscriptions';
import { OrganizationsModule } from '@src/organizations/organizations.module';
import { BillingController, CreditsCheckoutController } from './billing.controller';
import { BillingWebhookController } from './billing-webhook.controller';
import { PlanCheckoutController } from './plan-checkout.controller';

/**
 * The money path (billing PRD B5) — thin API module over the agent-side
 * `BillingService` / `BillingProvider` seam.
 *
 * Four controllers, two auth postures:
 *   - `BillingController` + `CreditsCheckoutController` +
 *     `PlanCheckoutController`: session-guarded, owner-scoped (overview,
 *     invoices, auto-recharge, packs, credit checkout, plan checkout).
 *   - `BillingWebhookController`: @Public, authenticated by the provider
 *     request signature and fail-closed when unconfigured.
 *
 * `OrganizationsModule` is imported for the ONE audited implementation of
 * the tenant-ownership check (`OrganizationMembershipService`), so a plan
 * checkout naming an `organizationId` outside the caller's tenant is
 * rejected the same way every other raw-`orgId` route rejects it.
 *
 * Additive: the existing read-only `CreditsController` (balance, ledger,
 * usage-summary) in `subscriptions/` is untouched.
 */
@Module({
    imports: [AuthModule, AgentSubscriptionsModule, OrganizationsModule],
    controllers: [
        BillingController,
        CreditsCheckoutController,
        PlanCheckoutController,
        BillingWebhookController,
    ],
})
export class BillingApiModule {}
