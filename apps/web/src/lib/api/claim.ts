import { serverFetch, serverMutation } from './server-api';

export interface ClaimPreview {
    workName: string;
    role: string;
    expiresAt: string;
    expectedProviderUsername?: string | null;
    sourceUrl?: string | null;
}

export interface ClaimAcceptResult {
    invitationId: string;
    workId: string;
    role: string;
    transferStatus: 'completed' | 'pending_recipient_acceptance' | 'failed' | 'not_required';
    providerAcceptanceUrl?: string;
}

export const claimAPI = {
    preview: async (token: string): Promise<ClaimPreview> => {
        return serverFetch<ClaimPreview>(`/claim/preview?token=${encodeURIComponent(token)}`);
    },

    accept: async (token: string): Promise<ClaimAcceptResult> => {
        return serverMutation<ClaimAcceptResult>({
            endpoint: '/claim/accept',
            data: { token },
            method: 'POST',
            wrapInData: false,
        });
    },
};
