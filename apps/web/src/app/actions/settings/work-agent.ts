'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import type {
    CreateWorkBuildRequestInput,
    UpdateWorkAgentPreferencesInput,
} from '@/lib/api/work-agent';
import { workAgentAPI } from '@/lib/api/work-agent';
import { getAuthFromCookie } from '@/lib/auth';
import { ROUTES } from '@/lib/constants';

const SETTINGS_PAGE_PATTERN = '/[locale]/(dashboard)/settings/work-agent';

// Security (authn): defense-in-depth auth guard for every work-agent
// Server Action — mirrors `ensureAuth()` in actions/agents.ts and
// `requireAuth()` in actions/dashboard/budgets.ts. The API tier
// (`/me/work-agent/*`, which scopes every build request/preference to the
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

export async function createWorkBuildRequestAction(input: CreateWorkBuildRequestInput) {
    await ensureAuth();
    const result = await workAgentAPI.createBuildRequest(input);
    revalidatePath(SETTINGS_PAGE_PATTERN, 'page');
    return result;
}

export async function cancelWorkBuildRequestAction(buildRequestId: string) {
    await ensureAuth();
    // Security (authz): `buildRequestId` is never used to scope authorization
    // in the web tier — the request is forwarded to
    // `/me/work-agent/build-requests/${buildRequestId}/cancel`, so the API
    // resolves the build request *within the authenticated caller's own
    // `/me` namespace*. A buildRequestId owned by another tenant cannot
    // resolve under the caller's scope, so there is no cross-tenant IDOR to
    // guard here.
    const result = await workAgentAPI.cancelBuildRequest(buildRequestId);
    revalidatePath(SETTINGS_PAGE_PATTERN, 'page');
    return result;
}
