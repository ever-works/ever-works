'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import type {
    CreateWorkAgentGoalInput,
    UpdateWorkAgentPreferencesInput,
} from '@/lib/api/work-agent';
import { workAgentAPI } from '@/lib/api/work-agent';
import { getAuthFromCookie } from '@/lib/auth';
import { ROUTES } from '@/lib/constants';

const SETTINGS_PAGE_PATTERN = '/[locale]/(dashboard)/settings/work-agent';

// Security (authn): defense-in-depth auth guard for every work-agent
// Server Action — mirrors `ensureAuth()` in actions/agents.ts and
// `requireAuth()` in actions/dashboard/budgets.ts. The API tier
// (`/me/work-agent/*`, which scopes every goal/preference to the
// authenticated caller) is the final guard, but re-verifying identity
// at the web-action boundary closes the layered-defense gap so a
// confused-deputy / CSRF-style POST to a Server Action endpoint can't
// reach `workAgentAPI.*` mutations without a valid session.
// `getAuthFromCookie` is React-`cache()`-wrapped, so the per-action
// call is deduplicated and cheap.
async function ensureAuth() {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }
    return user;
}

export async function updateWorkAgentPreferencesAction(input: UpdateWorkAgentPreferencesInput) {
    await ensureAuth();
    const result = await workAgentAPI.updatePreferences(input);
    revalidatePath(SETTINGS_PAGE_PATTERN, 'page');
    return result;
}

export async function createWorkAgentGoalAction(input: CreateWorkAgentGoalInput) {
    await ensureAuth();
    const result = await workAgentAPI.createGoal(input);
    revalidatePath(SETTINGS_PAGE_PATTERN, 'page');
    return result;
}

export async function cancelWorkAgentGoalAction(goalId: string) {
    await ensureAuth();
    // Security (authz): `goalId` is never used to scope authorization in the
    // web tier — the request is forwarded to `/me/work-agent/goals/${goalId}/cancel`,
    // so the API resolves the goal *within the authenticated caller's own
    // `/me` namespace*. A goalId owned by another tenant cannot resolve under
    // the caller's scope, so there is no cross-tenant IDOR to guard here.
    const result = await workAgentAPI.cancelGoal(goalId);
    revalidatePath(SETTINGS_PAGE_PATTERN, 'page');
    return result;
}
