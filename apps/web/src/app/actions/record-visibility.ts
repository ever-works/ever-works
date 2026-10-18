'use server';

import { redirect } from 'next/navigation';
import { recordVisibilityAPI } from '@/lib/api/record-visibility';
import { ApiResponseError } from '@/lib/api/server-api';
import { getAuthFromCookie } from '@/lib/auth';
import { ROUTES } from '@/lib/constants';
import {
    VISIBILITY_CHOICES,
    type RecordAggregate,
    type RecordVisibilityView,
    type VisibilityChoice,
} from '@/lib/record-visibility';

/**
 * Record visibility (EW-P1-3) — server actions behind the visibility control. The API
 * decides who may read (`visibleTo`) and who may change (the owner); these only keep
 * the server-only fetch out of client components.
 */

const AGGREGATES: readonly RecordAggregate[] = ['task', 'goal', 'mission', 'idea', 'agent'];

async function ensureAuth() {
    const user = await getAuthFromCookie();
    if (!user) redirect(ROUTES.AUTH_LOGIN);
}

function assertAggregate(aggregate: string): asserts aggregate is RecordAggregate {
    if (!(AGGREGATES as readonly string[]).includes(aggregate)) {
        throw new Error('Unknown record type');
    }
}

export async function getRecordVisibilityAction(
    aggregate: RecordAggregate,
    id: string,
): Promise<RecordVisibilityView | null> {
    await ensureAuth();
    assertAggregate(aggregate);
    return recordVisibilityAPI.get(aggregate, id);
}

export async function setRecordVisibilityAction(
    aggregate: RecordAggregate,
    id: string,
    visibility: VisibilityChoice,
): Promise<RecordVisibilityView> {
    await ensureAuth();
    assertAggregate(aggregate);
    if (!VISIBILITY_CHOICES.includes(visibility)) throw new Error('Unknown visibility');
    return recordVisibilityAPI.set(aggregate, id, visibility);
}

/**
 * Review 2026-10-17 U9 (F119): what a refused change answers, as a value. A production
 * build replaces the message of an error THROWN out of a Server Action with a generic
 * text, so the controls showed "An error occurred in the Server Components render…"
 * instead of the API's reason (for instance a personal record that cannot be shared).
 */
export type RecordVisibilityResult =
    | { ok: true; view: RecordVisibilityView }
    | { ok: false; message: string };

async function asResult(
    work: () => Promise<RecordVisibilityView>,
): Promise<RecordVisibilityResult> {
    try {
        return { ok: true, view: await work() };
    } catch (err) {
        if (err instanceof ApiResponseError) return { ok: false, message: err.message };
        // Not an answer of the API (transport, unexpected): logged here, the control shows
        // its generic message.
        console.error('record visibility change failed', err);
        return { ok: false, message: '' };
    }
}

/** {@link setRecordVisibilityAction}, answering a refusal as a value (U9). */
export async function setRecordVisibilityResultAction(
    aggregate: RecordAggregate,
    id: string,
    visibility: VisibilityChoice,
): Promise<RecordVisibilityResult> {
    await ensureAuth();
    assertAggregate(aggregate);
    if (!VISIBILITY_CHOICES.includes(visibility)) return { ok: false, message: '' };
    return asResult(() => recordVisibilityAPI.set(aggregate, id, visibility));
}

/** {@link setRecordTeamsAction}, answering a refusal as a value (U9). */
export async function setRecordTeamsResultAction(
    aggregate: RecordAggregate,
    id: string,
    teamIds: string[],
): Promise<RecordVisibilityResult> {
    await ensureAuth();
    assertAggregate(aggregate);
    return asResult(() => recordVisibilityAPI.setTeams(aggregate, id, teamIds));
}

export async function setRecordTeamsAction(
    aggregate: RecordAggregate,
    id: string,
    teamIds: string[],
): Promise<RecordVisibilityView> {
    await ensureAuth();
    assertAggregate(aggregate);
    return recordVisibilityAPI.setTeams(aggregate, id, teamIds);
}
