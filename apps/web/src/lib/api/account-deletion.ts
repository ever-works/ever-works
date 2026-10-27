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
 * The visitor's address, forwarded so the API's per-IP limit applies per
 * visitor rather than to the web server as a whole. The API trusts it only
 * as far as its `TRUST_PROXY_HOPS` allows.
 */
async function clientIpHeaders(): Promise<Record<string, string>> {
    const incoming = await headers();
    const forwarded = incoming.get('x-forwarded-for')?.split(',')[0]?.trim() || incoming.get('x-real-ip')?.trim();
    return forwarded ? { 'X-Forwarded-For': forwarded } : {};
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
