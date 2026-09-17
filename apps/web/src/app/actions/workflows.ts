'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getAuthFromCookie } from '@/lib/auth';
import { ROUTES } from '@/lib/constants';
import { workflowsAPI } from '@/lib/api/workflows';
import type { WorkflowRunStatus } from '@/lib/api/workflows.shared';

export type RunWorkflowActionResult =
    | { success: true; runId: string; status: WorkflowRunStatus }
    | { success: false; archived: boolean; error: string };

export type ReactivateWorkflowActionResult = { success: true } | { success: false; error: string };

/**
 * Start a saved workflow over the existing `POST /api/workflows/:id/run`.
 * The API records the run and hands it to the job runtime without waiting
 * for the graph, so this returns as soon as the run is queued. A refusal is
 * returned as a result object, never thrown.
 */
export async function runWorkflowAction(workflowId: string): Promise<RunWorkflowActionResult> {
    // Security: verify session server-side before mutating data
    const user = await getAuthFromCookie();
    if (!user) redirect(ROUTES.AUTH_LOGIN);

    const result = await workflowsAPI.run(workflowId);
    if (!result.ok) {
        return { success: false, archived: result.status === 409, error: result.message };
    }
    revalidatePath(ROUTES.DASHBOARD_CATALOG_WORKFLOWS);
    revalidatePath(ROUTES.DASHBOARD_CATALOG_WORKFLOW(workflowId));
    return { success: true, runId: result.data.runId, status: result.data.status };
}

/** Move an archived workflow back to `active` over the existing `PATCH /api/workflows/:id`. */
export async function reactivateWorkflowAction(
    workflowId: string,
): Promise<ReactivateWorkflowActionResult> {
    // Security: verify session server-side before mutating data
    const user = await getAuthFromCookie();
    if (!user) redirect(ROUTES.AUTH_LOGIN);

    const result = await workflowsAPI.setStatus(workflowId, 'active');
    if (!result.ok) return { success: false, error: result.message };
    revalidatePath(ROUTES.DASHBOARD_CATALOG);
    revalidatePath(ROUTES.DASHBOARD_CATALOG_WORKFLOWS);
    revalidatePath(ROUTES.DASHBOARD_CATALOG_WORKFLOW(workflowId));
    return { success: true };
}
