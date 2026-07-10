import { Module, OnModuleInit } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DatabaseModule } from '@ever-works/agent/database';
import { TenantJobRuntimeConfig } from '@ever-works/agent/entities';
// Security (EW-711 #14): WorkModule provides/exports WorkOwnershipService so
// WebhooksService can authorize a supplied workId before binding a
// subscription to that Work's event stream.
import {
    WebhookDeliveryService,
    WebhookSubscriptionDeliveryService,
    WorkModule,
} from '@ever-works/agent/services';
import { InProcessSecretStoreResolver, SECRET_STORE_RESOLVER } from '@ever-works/agent/tasks';
import { TriggerModule as TasksTriggerModule } from '@ever-works/trigger-tasks';
import { AuthModule } from '../auth/auth.module';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';
import { WebhookSecretService } from './webhook-secret.service';
import { WebhookEventDispatcherService } from './webhook-event-dispatcher.service';
import { WebhooksDeliveriesService } from './webhooks-deliveries.service';
import { TenantJobRuntimeModule } from '../account/tenant-job-runtime/tenant-job-runtime.module';
import { TriggerWebhookController } from './trigger-webhook.controller';
import { TriggerWebhookEventRouterService } from './trigger-webhook-event-router.service';
import { TriggerRunStatusSubscriber } from './subscribers/trigger-run-status.subscriber';
import { TriggerRunFailureSentryBreadcrumbSubscriber } from './subscribers/trigger-run-failure-sentry-breadcrumb.subscriber';

/**
 * `/api/webhooks` surface — subscriptions CRUD, delivery test-fire,
 * deliveries listing + redeliver, and the EventEmitter2 fanout listener
 * that turns platform events into outbound deliveries.
 *
 * Wiring notes:
 *
 *  - `WebhookSubscriptionDeliveryService` lives in `@ever-works/agent` so
 *    the Trigger.dev task can share it. It needs a decryptor function to
 *    turn the at-rest envelope back into the raw HMAC secret — we wire
 *    that in `onModuleInit` using `WebhookSecretService.decrypt`.
 *  - `WebhookEventDispatcherService` reaches for `TriggerService` via the
 *    `WEBHOOK_DELIVERY_DISPATCHER` injection token. `TriggerModule`
 *    provides it when present; the producer falls back to in-process
 *    delivery when Trigger.dev is unconfigured.
 */
@Module({
    imports: [
        DatabaseModule,
        AuthModule,
        TasksTriggerModule,
        WorkModule,
        // EW-742 P3.2 T22 — RuntimeBindingStamperService for the
        // WebhookEventDispatcherService enqueue-site stamping.
        TenantJobRuntimeModule,
        // EW-743 — the Trigger.dev webhook receiver injects the tenant
        // overlay repo directly to resolve the per-tenant
        // `credentials.webhookSecret`. `TenantJobRuntimeModule` does
        // not export the bare repository, so register it locally.
        TypeOrmModule.forFeature([TenantJobRuntimeConfig]),
    ],
    controllers: [WebhooksController, TriggerWebhookController],
    providers: [
        WebhooksService,
        WebhookSecretService,
        WebhookDeliveryService,
        WebhookSubscriptionDeliveryService,
        WebhookEventDispatcherService,
        WebhooksDeliveriesService,
        // EW-743 — SecretStoreResolver binding for the Trigger.dev
        // webhook receiver. `TenantJobRuntimeModule` also binds this
        // for its own use but does not export the token, so the same
        // default implementation is provided locally. Production
        // deployments override this binding at the module level for
        // their secret-store scheme (Vault, k8s, etc.).
        { provide: SECRET_STORE_RESOLVER, useClass: InProcessSecretStoreResolver },
        // EW-743 Phase 2 — verified-payload → internal-event router
        // used by TriggerWebhookController after HMAC check. Not
        // exported; subscribers live in their own modules and bind
        // via @OnEvent on the constants from
        // ./trigger-webhook-events.
        TriggerWebhookEventRouterService,
        // EW-743 Phase 3 — Trigger.dev internal-event subscribers.
        // Each subscribes via @OnEvent('trigger.*') and consumes the
        // router's envelope. They are deliberately NOT exported — no
        // one outside this module calls them directly; they live as
        // EventEmitter2 listeners. Adding more subscribers in the
        // future means: drop the @Injectable file under
        // ./subscribers, append it here, and add a spec.
        TriggerRunStatusSubscriber,
        TriggerRunFailureSentryBreadcrumbSubscriber,
    ],
    exports: [
        WebhooksService,
        WebhookSecretService,
        WebhookDeliveryService,
        WebhookSubscriptionDeliveryService,
        WebhookEventDispatcherService,
    ],
})
export class WebhooksModule implements OnModuleInit {
    constructor(
        private readonly orchestrator: WebhookSubscriptionDeliveryService,
        private readonly secrets: WebhookSecretService,
    ) {}

    onModuleInit(): void {
        // Per-delivery decryption (no caching) — see WebhookSubscriptionDeliveryService.
        this.orchestrator.setSecretDecryptor((encrypted) => this.secrets.decrypt(encrypted));
    }
}
