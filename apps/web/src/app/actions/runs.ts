'use server';

import { redirect } from 'next/navigation';
import { getAuthFromCookie } from '@/lib/auth';
import { ROUTES } from '@/lib/constants';
import { runsAPI, type RunsListQuery, type RunsWindowQuery } from '@/lib/api/runs';

/**
 * Runs ledger + run receipt (AW-09) — read-only server actions behind the
 * Runs page's window stepping, filtering, live refresh and receipt drawer.
 *
 * Reads, not mutations: nothing here revalidates a path (the same posture
 * as the Sessions list poll). Each action re-checks the session at the
 * action boundary before reaching the API, which is the final guard.
 */

async function ensureAuth() {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }
    return user;
}

export async function getRunsAction(query: RunsListQuery) {
    await ensureAuth();
    return runsAPI.list(query);
}

export async function getRunStatsAction(query: RunsWindowQuery) {
    await ensureAuth();
    return runsAPI.stats(query);
}

/** Null when the run does not exist or is not the caller's — the API answers both with 404. */
export async function getRunReceiptAction(runId: string) {
    await ensureAuth();
    try {
        return await runsAPI.receipt(runId);
    } catch {
        return null;
    }
}
