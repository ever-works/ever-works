import { Module, OnModuleInit } from '@nestjs/common';
import { DatabaseModule } from '@ever-works/agent/database';
import {
    WebhookDeliveryService,
    WebhookSubscriptionDeliveryService,
} from '@ever-works/agent/services';
import { TriggerModule as TasksTriggerModule } from '@ever-works/trigger-tasks';
import { AuthModule } from '../auth/auth.module';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';
import { WebhookSecretService } from './webhook-secret.service';
import { WebhookEventDispatcherService } from './webhook-event-dispatcher.service';
import { WebhooksDeliveriesService } from './webhooks-deliveries.service';

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
    imports: [DatabaseModule, AuthModule, TasksTriggerModule],
    controllers: [WebhooksController],
    providers: [
        WebhooksService,
        WebhookSecretService,
        WebhookDeliveryService,
        WebhookSubscriptionDeliveryService,
        WebhookEventDispatcherService,
        WebhooksDeliveriesService,
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
