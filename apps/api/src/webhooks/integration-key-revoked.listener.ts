import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { WebhookSubscriptionRepository } from '@ever-works/agent/database';
import {
    INTEGRATION_KEY_REVOKED_EVENT,
    type IntegrationKeyRevokedEvent,
} from '../auth/services/integration-key.service';

/**
 * Webhooks v2 (EW-P1-5, contract v1 B.5): revoking an integration key
 * disables every subscription the key owns, at once. The fan-out and the
 * sender also re-check the owner before each delivery, so nothing reaches a
 * revoked key's endpoint even if this listener missed the event; this makes
 * the subscription's status say so immediately.
 */
@Injectable()
export class IntegrationKeyRevokedWebhooksListener {
    private readonly logger = new Logger(IntegrationKeyRevokedWebhooksListener.name);

    constructor(private readonly subscriptions: WebhookSubscriptionRepository) {}

    @OnEvent(INTEGRATION_KEY_REVOKED_EVENT, { async: true, promisify: true })
    async onRevoked(event: IntegrationKeyRevokedEvent): Promise<void> {
        try {
            const disabled = await this.subscriptions.disableForOwner(
                'integration_key',
                event.keyId,
            );
            if (disabled > 0) {
                this.logger.log(
                    `Disabled ${disabled} webhook subscription(s) of revoked key ${event.keyId}.`,
                );
            }
        } catch (error) {
            this.logger.warn(
                `Could not disable the webhooks of revoked key ${event.keyId}: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }
}
