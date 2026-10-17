'use server';

import { redirect } from 'next/navigation';
import { recordVisibilityAPI } from '@/lib/api/record-visibility';
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

export async function setRecordTeamsAction(
    aggregate: RecordAggregate,
    id: string,
    teamIds: string[],
): Promise<RecordVisibilityView> {
    await ensureAuth();
    assertAggregate(aggregate);
    return recordVisibilityAPI.setTeams(aggregate, id, teamIds);
}
