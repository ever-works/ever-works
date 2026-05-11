'use server';

import { claimAPI, type ClaimAcceptResult } from '@/lib/api/claim';

export type ClaimAcceptOutcome =
    | { ok: true; result: ClaimAcceptResult }
    | { ok: false; error: string };

export async function acceptClaim(token: string): Promise<ClaimAcceptOutcome> {
    if (!token || typeof token !== 'string') {
        return { ok: false, error: 'invalid_token' };
    }
    try {
        const result = await claimAPI.accept(token);
        return { ok: true, result };
    } catch (err) {
        const message =
            err instanceof Error && err.message ? err.message : 'claim_failed';
        return { ok: false, error: message };
    }
}
