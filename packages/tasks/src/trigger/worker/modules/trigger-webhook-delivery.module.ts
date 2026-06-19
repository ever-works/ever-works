import { Module, OnModuleInit } from '@nestjs/common';
import { DatabaseModule } from '@ever-works/agent/database';
import {
    WebhookDeliveryService,
    WebhookSubscriptionDeliveryService,
    WebhookSubscriptionSecretService,
} from '@ever-works/agent/services';
import { CredentialVersionService } from '@ever-works/agent/tasks';
import { TenantRuntimeBindingResolverService } from '../services/tenant-runtime-binding-resolver.service';

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
 *
 * # EW-742 P3.2 T22 — direct (non-proxied) wiring
 *
 * Unlike `TriggerWorkerModule`, this module imports `DatabaseModule`
 * directly so the resolver service uses the real `WebhookSubscription-
 * Repository` + `CredentialVersionService` instead of an RPC proxy.
 * The webhook-delivery worker already shares the same database as the
 * API (it has to — `WebhookSubscriptionDeliveryService` reads the
 * subscription row directly), so layering an RPC proxy on top would
 * just add a network hop with zero correctness benefit.
 */
@Module({
    imports: [DatabaseModule],
    providers: [
        WebhookDeliveryService,
        WebhookSubscriptionDeliveryService,
        WebhookSubscriptionSecretService,
        // EW-742 P3.2 T22 — `(providerId, credentialVersion)` lookup +
        // 4-state binding classifier for the webhook-delivery task.
        CredentialVersionService,
        TenantRuntimeBindingResolverService,
    ],
    exports: [
        WebhookDeliveryService,
        WebhookSubscriptionDeliveryService,
        WebhookSubscriptionSecretService,
        TenantRuntimeBindingResolverService,
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
