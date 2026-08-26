import { Module } from '@nestjs/common';
import { DatabaseModule } from '@ever-works/agent/database';
import { WorkModule } from '@ever-works/agent/services';
import { AuthModule } from '@src/auth';
import { StripeRelayController } from './stripe-relay.controller';
import { StripeRelayService } from './stripe-relay.service';

/**
 * The shared Stripe webhook relay (relay phase 3).
 *
 * Imports mirror `ActivityFeedModule`, the other platform to site caller:
 * `WorkModule` for `PlatformSyncSecretService` (per-Work signing secret) and
 * `DatabaseModule` for `WorkRepository` (resolving `work_id` to a Work + its
 * deployed website). `AuthModule` supplies the guard that `@Public()` opts out
 * of, matching every other webhook receiver in this app.
 *
 * No `HttpModule`: the forwarder uses global `fetch` so it can pin
 * `redirect: 'manual'` per request and abort on a timeout without adding a
 * transport dependency.
 *
 * Additive — the existing `BillingWebhookController` (the platform's OWN Stripe
 * receiver on `/api/billing/webhook`) is untouched and keeps its own secret.
 */
@Module({
    imports: [WorkModule, DatabaseModule, AuthModule],
    controllers: [StripeRelayController],
    providers: [StripeRelayService],
    exports: [StripeRelayService],
})
export class StripeRelayModule {}
