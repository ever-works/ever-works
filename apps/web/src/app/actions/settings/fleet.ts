'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { ROUTES } from '@/lib/constants';
import { getAuthFromCookie } from '@/lib/auth';
import { ApiResponseError } from '@/lib/api/server-api';
import {
    fleetAPI,
    type CreateFleetEnrollmentTokenPayload,
    type CreateFleetEnrollmentTokenResponse,
    type FleetAgentNodeAffinityView,
    type FleetEnrollmentTokenView,
    type FleetNodeDetailView,
    type FleetNodeDrainResult,
    type FleetExecutionPreferenceView,
    type FleetExecutionScopeType,
    type FleetNodeView,
    type FleetRunnerStatusView,
    type SetFleetExecutionPreferencePayload,
    type UpdateFleetNodePayload,
} from '@/lib/api/fleet';

/**
 * Fleet (Wave 12, slice 1) — Server Actions wrapping the owner-scoped
 * `/api/fleet` surface. Returns the discriminated `{ success, data,
 * error }` shape so the client form can surface either a toast or an
 * inline error without re-throwing across the RSC boundary (prod
 * redacts thrown Server Action messages — never branch on them).
 *
 * Each action re-verifies the session at the Server Action boundary
 * (defense in depth — the API tier is the final guard). The pattern
 * mirrors `app/actions/settings/job-runtime.ts`.
 */

const SETTINGS_PAGE_PATTERN = '/[locale]/(dashboard)/settings/fleet';

/**
 * The Agent's Capabilities tab, where the preferred-node picker lives.
 *
 * The ROUTE pattern with `'page'`, like `SETTINGS_PAGE_PATTERN` above,
 * rather than a literal `/agents/:id/capabilities`: the page is served
 * under a locale prefix and, in an Organization workspace (the only
 * place the picker is enabled), under `/org/<slug>` too, so a literal
 * path would match nothing the moment the page became cacheable.
 */
const AGENT_CAPABILITIES_PAGE_PATTERN = '/[locale]/(dashboard)/agents/[id]/capabilities';

async function ensureAuth() {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }
    return user;
}

function errorMessage(error: unknown, fallback: string): string {
    if (error instanceof ApiResponseError && error.message) return error.message;
    if (error instanceof Error && error.message) return error.message;
    return fallback;
}

export type FleetActionResult<T> =
    | { success: true; data: T; error: null }
    | { success: false; data: null; error: string };

export async function createFleetEnrollmentTokenAction(
    payload: CreateFleetEnrollmentTokenPayload,
): Promise<FleetActionResult<CreateFleetEnrollmentTokenResponse>> {
    await ensureAuth();
    try {
        const data = await fleetAPI.createEnrollmentToken(payload);
        revalidatePath(SETTINGS_PAGE_PATTERN, 'page');
        return { success: true, data, error: null };
    } catch (error) {
        return {
            success: false,
            data: null,
            error: errorMessage(error, 'Failed to issue an enrollment token'),
        };
    }
}

export async function updateFleetNodeAction(
    nodeId: string,
    payload: UpdateFleetNodePayload,
): Promise<FleetActionResult<FleetNodeView>> {
    await ensureAuth();
    try {
        const data = await fleetAPI.updateNode(nodeId, payload);
        revalidatePath(SETTINGS_PAGE_PATTERN, 'page');
        return { success: true, data, error: null };
    } catch (error) {
        return {
            success: false,
            data: null,
            error: errorMessage(error, 'Failed to update the node'),
        };
    }
}

export async function deleteFleetNodeAction(
    nodeId: string,
): Promise<FleetActionResult<{ deleted: true }>> {
    await ensureAuth();
    try {
        await fleetAPI.deleteNode(nodeId);
        revalidatePath(SETTINGS_PAGE_PATTERN, 'page');
        return { success: true, data: { deleted: true }, error: null };
    } catch (error) {
        return {
            success: false,
            data: null,
            error: errorMessage(error, 'Failed to remove the node'),
        };
    }
}

/** Node-detail drawer: the node plus its recent job / failure history. */
export async function getFleetNodeDetailAction(
    nodeId: string,
): Promise<FleetActionResult<FleetNodeDetailView>> {
    await ensureAuth();
    try {
        const data = await fleetAPI.nodeDetail(nodeId);
        return { success: true, data, error: null };
    } catch (error) {
        return {
            success: false,
            data: null,
            error: errorMessage(error, 'Failed to load the node'),
        };
    }
}

/** Outstanding (minted but never used) enrollment tokens. */
export async function listFleetEnrollmentTokensAction(): Promise<
    FleetActionResult<FleetEnrollmentTokenView[]>
> {
    await ensureAuth();
    try {
        const data = await fleetAPI.listOutstandingTokens();
        return { success: true, data, error: null };
    } catch (error) {
        return {
            success: false,
            data: null,
            error: errorMessage(error, 'Failed to load outstanding enrollment tokens'),
        };
    }
}

/** Revoke an outstanding token BEFORE anyone uses it. */
export async function revokeFleetEnrollmentTokenAction(
    nodeId: string,
): Promise<FleetActionResult<{ revoked: true }>> {
    await ensureAuth();
    try {
        await fleetAPI.revokeEnrollmentToken(nodeId);
        revalidatePath(SETTINGS_PAGE_PATTERN, 'page');
        return { success: true, data: { revoked: true }, error: null };
    } catch (error) {
        return {
            success: false,
            data: null,
            error: errorMessage(error, 'Failed to revoke the enrollment token'),
        };
    }
}

/**
 * Re-key a node. The replacement token comes back exactly once, so the
 * caller MUST surface it immediately — there is no second read.
 */
export async function rotateFleetNodeCredentialAction(
    nodeId: string,
): Promise<FleetActionResult<CreateFleetEnrollmentTokenResponse>> {
    await ensureAuth();
    try {
        const data = await fleetAPI.rotateNodeCredential(nodeId);
        revalidatePath(SETTINGS_PAGE_PATTERN, 'page');
        return { success: true, data, error: null };
    } catch (error) {
        return {
            success: false,
            data: null,
            error: errorMessage(error, 'Failed to rotate the node credential'),
        };
    }
}

/** Drain (or return to service) a node, requeuing its in-flight claims. */
export async function drainFleetNodeAction(
    nodeId: string,
    drain: boolean,
): Promise<FleetActionResult<FleetNodeDrainResult>> {
    await ensureAuth();
    try {
        const data = await fleetAPI.drainNode(nodeId, drain);
        revalidatePath(SETTINGS_PAGE_PATTERN, 'page');
        return { success: true, data, error: null };
    } catch (error) {
        return {
            success: false,
            data: null,
            error: errorMessage(error, 'Failed to drain the node'),
        };
    }
}

/**
 * Runner status for the always-visible sidebar pill.
 *
 * Polled every 30s from every dashboard page, so it deliberately does
 * NOT `revalidatePath` — this is a read, and invalidating the settings
 * page cache twice a minute for every signed-in user would be a
 * self-inflicted load problem.
 */
export async function getFleetRunnerStatusAction(): Promise<
    FleetActionResult<FleetRunnerStatusView>
> {
    await ensureAuth();
    try {
        const data = await fleetAPI.runnerStatus();
        return { success: true, data, error: null };
    } catch (error) {
        return {
            success: false,
            data: null,
            error: errorMessage(error, 'Failed to load runner status'),
        };
    }
}

/** Every execution routing preference this owner has configured. */
export async function listFleetExecutionPreferencesAction(): Promise<
    FleetActionResult<FleetExecutionPreferenceView[]>
> {
    await ensureAuth();
    try {
        const data = await fleetAPI.listExecutionPreferences();
        return { success: true, data, error: null };
    } catch (error) {
        return {
            success: false,
            data: null,
            error: errorMessage(error, 'Failed to load execution preferences'),
        };
    }
}

/** Set where runs in one scope execute (local runner vs cloud). */
export async function setFleetExecutionPreferenceAction(
    payload: SetFleetExecutionPreferencePayload,
): Promise<FleetActionResult<FleetExecutionPreferenceView>> {
    await ensureAuth();
    try {
        const data = await fleetAPI.setExecutionPreference(payload);
        revalidatePath(SETTINGS_PAGE_PATTERN, 'page');
        return { success: true, data, error: null };
    } catch (error) {
        return {
            success: false,
            data: null,
            error: errorMessage(error, 'Failed to save the execution preference'),
        };
    }
}

/**
 * Pin an Agent's `agent-task` jobs to ONE of the owner's nodes.
 *
 * Invalidates the Agent's Capabilities tab (where the picker lives)
 * rather than the Fleet settings page: the binding is a property of the
 * Agent, and nothing on the settings page renders it.
 */
export async function setFleetAgentAffinityAction(
    agentId: string,
    nodeId: string,
): Promise<FleetActionResult<FleetAgentNodeAffinityView>> {
    await ensureAuth();
    try {
        const data = await fleetAPI.setAgentAffinity(agentId, nodeId);
        revalidatePath(AGENT_CAPABILITIES_PAGE_PATTERN, 'page');
        return { success: true, data, error: null };
    } catch (error) {
        return {
            success: false,
            data: null,
            error: errorMessage(error, 'Failed to set the preferred node'),
        };
    }
}

/**
 * Return an Agent to "any of my nodes". Jobs already queued keep the node
 * they were enqueued for; only future jobs become unbound.
 */
export async function clearFleetAgentAffinityAction(
    agentId: string,
): Promise<FleetActionResult<{ cleared: true }>> {
    await ensureAuth();
    try {
        await fleetAPI.clearAgentAffinity(agentId);
        revalidatePath(AGENT_CAPABILITIES_PAGE_PATTERN, 'page');
        return { success: true, data: { cleared: true }, error: null };
    } catch (error) {
        return {
            success: false,
            data: null,
            error: errorMessage(error, 'Failed to clear the preferred node'),
        };
    }
}

/** Clear one scope so it inherits from the next scope out. */
export async function clearFleetExecutionPreferenceAction(
    scopeType: FleetExecutionScopeType,
    scopeId?: string | null,
): Promise<FleetActionResult<{ cleared: true }>> {
    await ensureAuth();
    try {
        await fleetAPI.clearExecutionPreference(scopeType, scopeId ?? null);
        revalidatePath(SETTINGS_PAGE_PATTERN, 'page');
        return { success: true, data: { cleared: true }, error: null };
    } catch (error) {
        return {
            success: false,
            data: null,
            error: errorMessage(error, 'Failed to clear the execution preference'),
        };
    }
}
