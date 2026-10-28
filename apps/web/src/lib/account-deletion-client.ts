import type { AccountDeletionPreview, AccountDeletionResult } from '@/lib/api/account-deletion';

export type DeletionCallResult<T> = { success: true; data: T } | { success: false; error: string; gone?: boolean };

/**
 * Browser side of the public deletion pages. Posts to the same-origin route
 * handler `/api/account-deletion` (see its note on why not a server action):
 * the token and the address travel only in the POST body.
 */
async function post<T>(payload: Record<string, string>, fallbackError: string): Promise<DeletionCallResult<T>> {
    try {
        const response = await fetch('/api/account-deletion', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            cache: 'no-store',
            credentials: 'same-origin',
            referrerPolicy: 'no-referrer',
        });
        if (!response.ok) return { success: false, error: fallbackError };
        return (await response.json()) as DeletionCallResult<T>;
    } catch {
        return { success: false, error: fallbackError };
    }
}

export const accountDeletionClient = {
    request: (email: string, fallbackError: string) => post<null>({ op: 'request', email }, fallbackError),
    verify: (token: string, fallbackError: string) =>
        post<AccountDeletionPreview>({ op: 'verify', token }, fallbackError),
    confirm: (token: string, fallbackError: string) =>
        post<AccountDeletionResult>({ op: 'confirm', token }, fallbackError),
};
