import 'server-only';
import { serverFetch, serverMutation } from '../server-api';

export interface ComposioToolkit {
    slug: string;
    name: string;
    description?: string;
    categories?: string[];
}

export interface ComposioConnectedAccount {
    id: string;
    status: string;
    toolkitSlug?: string;
    userId?: string;
}

export interface InitiateConnectionRequest {
    toolkitSlug: string;
    authConfigId: string;
    callbackUrl?: string;
}

export interface InitiateConnectionResponse {
    redirectUrl: string;
    connectedAccountId?: string;
}

export const composioAPI = {
    listToolkits: async (limit = 100): Promise<ComposioToolkit[]> => {
        const response = await serverFetch<{ items: ComposioToolkit[] }>(
            `/plugins/composio/toolkits?limit=${limit}`,
        );
        return response.items ?? [];
    },

    listConnectedAccounts: async (toolkitSlug?: string): Promise<ComposioConnectedAccount[]> => {
        const query = toolkitSlug ? `?toolkit=${encodeURIComponent(toolkitSlug)}` : '';
        const response = await serverFetch<{ items: ComposioConnectedAccount[] }>(
            `/plugins/composio/connected-accounts${query}`,
        );
        return response.items ?? [];
    },

    initiateConnection: async (
        body: InitiateConnectionRequest,
    ): Promise<InitiateConnectionResponse> => {
        return serverMutation<InitiateConnectionResponse>({
            endpoint: `/plugins/composio/connect`,
            data: body,
            method: 'POST',
            wrapInData: false,
        });
    },
};
