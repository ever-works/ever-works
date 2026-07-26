import { Module } from '@nestjs/common';
import { AuthModule } from '@src/auth';
import { SubscriptionsModule as AgentSubscriptionsModule } from '@ever-works/agent/subscriptions';
import { BillingController, CreditsCheckoutController } from './billing.controller';
import { BillingWebhookController } from './billing-webhook.controller';

/**
 * The money path (billing PRD B5) — thin API module over the agent-side
 * `BillingService` / `BillingProvider` seam.
 *
 * Three controllers, two auth postures:
 *   - `BillingController` + `CreditsCheckoutController`: session-guarded,
 *     owner-scoped (overview, invoices, auto-recharge, packs, checkout).
 *   - `BillingWebhookController`: @Public, authenticated by the provider
 *     request signature and fail-closed when unconfigured.
 *
 * Additive: the existing read-only `CreditsController` (balance, ledger,
 * usage-summary) in `subscriptions/` is untouched.
 */
@Module({
    imports: [AuthModule, AgentSubscriptionsModule],
    controllers: [BillingController, CreditsCheckoutController, BillingWebhookController],
})
export class BillingApiModule {}
