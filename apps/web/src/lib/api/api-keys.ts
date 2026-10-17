import 'server-only';
import type {
    CreateIntegrationKeyRequest,
    CreateIntegrationKeyResponse,
    IntegrationKeySummary,
    RotateApiKeyResponse,
} from '@ever-works/contracts';
import { serverFetch, serverMutation } from './server-api';

export type { CreateIntegrationKeyRequest, CreateIntegrationKeyResponse, IntegrationKeySummary };

export interface CreateApiKeyDto {
    name: string;
    expiresAt?: string;
}

export interface CreateApiKeyResponse {
    id: string;
    name: string;
    key: string;
    prefix: string;
    expiresAt: string | null;
    createdAt: string;
}

export interface ApiKeyListItem {
    id: string;
    name: string;
    prefix: string;
    expiresAt: string | null;
    lastUsedAt: string | null;
    isActive: boolean;
    createdAt: string;
}

export const apiKeysAPI = {
    create: async (data: CreateApiKeyDto) => {
        return serverMutation<CreateApiKeyResponse>({
            endpoint: '/auth/api-keys',
            data,
            method: 'POST',
            wrapInData: false,
        });
    },

    list: async () => {
        return serverFetch<ApiKeyListItem[]>('/auth/api-keys');
    },

    revoke: async (id: string) => {
        return serverMutation<{ message: string }>({
            endpoint: `/auth/api-keys/${id}`,
            data: {},
            method: 'DELETE',
            wrapInData: false,
        });
    },

    // ── EW-P1-2 / EW-P1-7 — integration keys (`ew_int_…`) ────────────────

    /** The workspace's integration keys (workspace owner; others get `[]`). */
    listIntegration: async () => {
        return serverFetch<IntegrationKeySummary[]>('/auth/api-keys/integration');
    },

    createIntegration: async (data: CreateIntegrationKeyRequest) => {
        return serverMutation<CreateIntegrationKeyResponse>({
            endpoint: '/auth/api-keys/integration',
            data,
            method: 'POST',
            wrapInData: false,
        });
    },

    /** Rotate in place; the previous secret keeps working for `graceHours` (default 24). */
    rotate: async (id: string, graceHours?: number) => {
        return serverMutation<RotateApiKeyResponse>({
            endpoint: `/auth/api-keys/${id}/rotate`,
            data: graceHours === undefined ? {} : { graceHours },
            method: 'POST',
            wrapInData: false,
        });
    },
};
