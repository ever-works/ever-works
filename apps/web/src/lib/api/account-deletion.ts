import 'server-only';
import { headers } from 'next/headers';
import { serverFetch } from './server-api';

/** What happens to one workspace the account belongs to (mirrors the API). */
export interface AccountDeletionWorkspace {
    workspace: string;
    role: 'OWNER' | 'ADMIN' | 'MEMBER';
    organizations: string[];
    otherMembers: number;
    outcome: 'workspace-deleted' | 'workspace-transferred' | 'account-removed';
    soleAdmin: boolean;
    newOwner?: string | null;
}

export interface AccountDeletionPreview {
    email: string | null;
    accounts: AccountDeletionWorkspace[];
    worksDeleted: number;
    worksKept: number;
    apiKeys: number;
    hasSubscription: boolean;
    /** Email-link flow only: when the link stops working. */
    expiresAt?: string;
}

export interface AccountDeletionResult {
    deleted: true;
    accounts: number;
    workspacesDeleted: number;
}

/**
 * The visitor's address, so the API's per-IP limit applies per visitor rather
 * than to the web server as a whole.
 *
 * The incoming `X-Forwarded-For` chain is passed on WHOLE. Its left-most entry
 * is whatever the caller sent, so picking it would let a caller rotate it past
 * the limit; with the full chain the API resolves the address the same way it
 * does for a request that reaches it directly (its `TRUST_PROXY_HOPS` counts
 * from the right, where the ingress appended the real peer). `X-Real-IP`, set
 * by the ingress, is the fallback when there is no chain.
 */
async function clientIpHeaders(): Promise<Record<string, string>> {
    const incoming = await headers();
    const chain = incoming.get('x-forwarded-for')?.trim();
    if (chain) return { 'X-Forwarded-For': chain };
    const realIp = incoming.get('x-real-ip')?.trim();
    return realIp ? { 'X-Forwarded-For': realIp } : {};
}

export const accountDeletionAPI = {
    /** Public. Always resolves the same way, whatever the address. */
    async request(email: string, callbackUrl: string): Promise<void> {
        await serverFetch('/account-deletion/request', {
            method: 'POST',
            body: JSON.stringify({ email, callbackUrl }),
            headers: await clientIpHeaders(),
            publicRouteScope: 'personal',
        });
    },

    /** Public. Throws an `ApiResponseError` with status 410 for any unusable link. */
    async verify(token: string): Promise<AccountDeletionPreview> {
        return serverFetch<AccountDeletionPreview>('/account-deletion/verify', {
            method: 'POST',
            body: JSON.stringify({ token }),
            headers: await clientIpHeaders(),
            publicRouteScope: 'personal',
        });
    },

    /** Public. Uses the link (single use) and deletes the account. */
    async confirm(token: string): Promise<AccountDeletionResult> {
        return serverFetch<AccountDeletionResult>('/account-deletion/confirm', {
            method: 'POST',
            body: JSON.stringify({ token, confirm: true }),
            headers: await clientIpHeaders(),
            publicRouteScope: 'personal',
        });
    },

    /** Signed in: what deleting this account would delete. */
    async previewMine(): Promise<AccountDeletionPreview> {
        return serverFetch<AccountDeletionPreview>('/account-deletion/me', {
            method: 'GET',
            publicRouteScope: 'personal',
        });
    },

    /** Signed in: delete this account (typed email confirmation). */
    async deleteMine(confirmEmail: string): Promise<AccountDeletionResult> {
        return serverFetch<AccountDeletionResult>('/account-deletion/me', {
            method: 'POST',
            body: JSON.stringify({ confirmEmail }),
            publicRouteScope: 'personal',
        });
    },
};
