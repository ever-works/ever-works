import 'server-only';
import { serverFetch, serverMutation } from './server-api';
import { APIResponse } from './types';

export type InvitationRole = 'manager' | 'editor' | 'viewer' | 'owner-claim';

export interface WorkInvitation {
    id: string;
    workId: string;
    role: InvitationRole;
    email: string | null;
    status: 'pending' | 'accepted' | 'expired' | 'revoked';
    tokenExpiresAt: string;
    createdAt: string;
    invitedById: string;
    metadata?: Record<string, unknown> | null;
}

export interface CreateInvitationDto {
    email?: string;
    role: InvitationRole;
    expiresInDays?: number;
    expectedProviderUsername?: string;
    metadata?: Record<string, unknown>;
}

export interface CreateInvitationResponse extends WorkInvitation {
    claimUrl?: string;
}

export interface ListInvitationsResponse {
    status: 'success';
    invitations: WorkInvitation[];
}

export const invitationsAPI = {
    list: async (workId: string) => {
        return serverFetch<ListInvitationsResponse>(`/works/${workId}/invitations`);
    },

    create: async (workId: string, data: CreateInvitationDto) => {
        return serverMutation<APIResponse<CreateInvitationResponse>>({
            endpoint: `/works/${workId}/invitations`,
            data,
            method: 'POST',
            wrapInData: false,
        });
    },

    revoke: async (workId: string, invitationId: string) => {
        return serverMutation<APIResponse<{ status: 'success' }>>({
            endpoint: `/works/${workId}/invitations/${invitationId}`,
            data: {},
            method: 'DELETE',
            wrapInData: false,
        });
    },
};
