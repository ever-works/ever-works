import 'server-only';
import { serverFetch, serverMutation } from '../server-api';

export interface ComposioTrigger {
    id: string;
    toolkitSlug: string;
    triggerSlug: string;
    composioTriggerId: string;
    composioConnectedAccountId: string;
    enabled: boolean;
    deliveriesReceived: number;
    deliveriesRejected: number;
    lastFiredAt?: string | null;
    createdAt: string;
}

export interface CreateComposioTriggerInput {
    toolkitSlug: string;
    triggerSlug: string;
    composioConnectedAccountId: string;
    config?: Record<string, unknown>;
}

export const composioTriggersAPI = {
    list: async (): Promise<ComposioTrigger[]> => {
        const response = await serverFetch<{ items: ComposioTrigger[] }>(
            '/plugins/composio/triggers',
        );
        return response.items ?? [];
    },

    create: async (input: CreateComposioTriggerInput): Promise<ComposioTrigger> => {
        return serverMutation<ComposioTrigger>({
            endpoint: '/plugins/composio/triggers',
            data: input,
            method: 'POST',
            wrapInData: false,
        });
    },

    remove: async (id: string): Promise<void> => {
        await serverMutation<void>({
            endpoint: `/plugins/composio/triggers/${id}`,
            data: {},
            method: 'DELETE',
            wrapInData: false,
        });
    },
};
