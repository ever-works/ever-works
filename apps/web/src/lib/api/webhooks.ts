import 'server-only';
import { serverFetch, serverMutation } from './server-api';

/**
 * Outbound webhook subscriptions (`/api/webhooks`) — server-side client for
 * Settings → Webhooks (EW-P1-5). Hand-mirrors `WebhookSubscriptionView` and
 * `WebhookDeliveryView` in `apps/api/src/webhooks/`.
 */

export type WebhookStatus = 'active' | 'paused' | 'failed' | 'disabled';

export interface WebhookSubscription {
    id: string;
    accountId: string;
    workId: string | null;
    url: string;
    status: WebhookStatus;
    consecutiveFailures: number;
    lastDeliveryAt: string | null;
    createdAt: string;
    updatedAt: string;
    /** 1 = legacy work/deploy events; 2 = domain events. */
    version: 1 | 2;
    ownerType: 'user' | 'integration_key';
    /** The owning user or integration key id (null on v1 rows). */
    ownerId?: string | null;
    events: string[] | null;
    organizationIds: string[] | null;
    excludeOriginTags: string[] | null;
    description: string | null;
}

export interface WebhookDelivery {
    id: string;
    subscriptionId: string;
    event: string;
    status: 'pending' | 'delivered' | 'failed' | 'retrying';
    attempts: number;
    lastResponseStatus: number | null;
    lastOutcome: string | null;
    lastError: string | null;
    durationMs: number | null;
    triggerRunId: string | null;
    lastAttemptAt: string | null;
    createdAt: string;
    updatedAt: string;
}

/** v2 when `events` + `organizationIds` are set; v1 (work/deploy events) otherwise. */
export interface CreateWebhookInput {
    url: string;
    events?: string[];
    organizationIds?: string[];
    excludeOriginTags?: string[];
    description?: string | null;
}

export interface UpdateWebhookInput {
    status?: 'active' | 'paused';
    url?: string;
    events?: string[];
    organizationIds?: string[];
    excludeOriginTags?: string[];
    description?: string | null;
}

export interface WebhookWithSecret {
    subscription: WebhookSubscription;
    /** Returned ONCE (create / rotate). */
    signingSecret: string;
}

export interface WebhookTestResult {
    deliveryId: string;
    outcome: string;
    status: number | null;
    ok: boolean;
}

export const webhooksAPI = {
    list: async (): Promise<WebhookSubscription[]> => {
        const data = await serverFetch<{ subscriptions: WebhookSubscription[] }>('/webhooks');
        return data.subscriptions;
    },
    create: async (input: CreateWebhookInput): Promise<WebhookWithSecret> =>
        serverMutation<WebhookWithSecret>({
            method: 'POST',
            endpoint: '/webhooks',
            data: input,
            wrapInData: false,
        }),
    update: async (id: string, input: UpdateWebhookInput): Promise<WebhookSubscription> =>
        serverMutation<WebhookSubscription>({
            method: 'PATCH',
            endpoint: `/webhooks/${encodeURIComponent(id)}`,
            data: input,
            wrapInData: false,
        }),
    remove: async (id: string): Promise<void> => {
        await serverMutation<void>({
            method: 'DELETE',
            endpoint: `/webhooks/${encodeURIComponent(id)}`,
            data: {},
            wrapInData: false,
        });
    },
    test: async (id: string): Promise<WebhookTestResult> =>
        serverMutation<WebhookTestResult>({
            method: 'POST',
            endpoint: `/webhooks/${encodeURIComponent(id)}/test`,
            data: {},
            wrapInData: false,
        }),
    rotateSecret: async (id: string): Promise<WebhookWithSecret> =>
        serverMutation<WebhookWithSecret>({
            method: 'POST',
            endpoint: `/webhooks/${encodeURIComponent(id)}/rotate-secret`,
            data: {},
            wrapInData: false,
        }),
    deliveries: async (subscriptionId?: string, limit = 50): Promise<WebhookDelivery[]> => {
        const params = new URLSearchParams({ limit: String(limit) });
        if (subscriptionId) params.set('subscriptionId', subscriptionId);
        const data = await serverFetch<{ deliveries: WebhookDelivery[] }>(
            `/webhooks/deliveries?${params.toString()}`,
        );
        return data.deliveries;
    },
    redeliver: async (deliveryId: string): Promise<{ deliveryId: string; enqueued: boolean }> =>
        serverMutation<{ deliveryId: string; enqueued: boolean }>({
            method: 'POST',
            endpoint: `/webhooks/deliveries/${encodeURIComponent(deliveryId)}/redeliver`,
            data: {},
            wrapInData: false,
        }),
};
