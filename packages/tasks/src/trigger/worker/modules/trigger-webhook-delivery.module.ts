import { Module, OnModuleInit } from '@nestjs/common';
import { DatabaseModule } from '@ever-works/agent/database';
import {
    WebhookDeliveryService,
    WebhookSubscriptionDeliveryService,
    WebhookSubscriptionSecretService,
} from '@ever-works/agent/services';

/**
 * Minimal NestJS module booted inside the Trigger.dev webhook-delivery
 * task. Deliberately does NOT pull in the full {@link TriggerWorkerModule}
 * (orchestrators, generators, AI facades, plugin store, …) — webhook
 * delivery only needs the subscription / delivery repositories and the
 * two webhook services. Boot is fast and the failure surface is narrow.
 *
 * The decryptor wiring is done in `onModuleInit` so the orchestrator
 * service has `WebhookSubscriptionSecretService.decrypt` registered
 * before the first dispatch.
 */
@Module({
    imports: [DatabaseModule],
    providers: [
        WebhookDeliveryService,
        WebhookSubscriptionDeliveryService,
        WebhookSubscriptionSecretService,
    ],
    exports: [
        WebhookDeliveryService,
        WebhookSubscriptionDeliveryService,
        WebhookSubscriptionSecretService,
    ],
})
export class TriggerWebhookDeliveryModule implements OnModuleInit {
    constructor(
        private readonly orchestrator: WebhookSubscriptionDeliveryService,
        private readonly secrets: WebhookSubscriptionSecretService,
    ) {}

    onModuleInit(): void {
        this.orchestrator.setSecretDecryptor((encrypted) => this.secrets.decrypt(encrypted));
    }
}
