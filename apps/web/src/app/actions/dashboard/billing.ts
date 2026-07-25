'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { subscriptionsAPI } from '@/lib/api/credits';
import { getAuthFromCookie } from '@/lib/auth';
import { ROUTES } from '@/lib/constants';
// Security: map ApiResponseError HTTP status codes to generic client-safe
// messages instead of forwarding raw backend strings.
import { ApiResponseError } from '@/lib/api/server-api';

/**
 * Wave 13 — server action for the Billing page's plan switcher.
 *
 * Self-service moves are FREE-plan-only by design (EW-711 #23): the API
 * rejects paid plans with 403; a paid tier is activated only through a
 * billing-verified path once a payment provider is wired. Returns a
 * discriminated union (never throws) — production redacts thrown server
 * action error messages, so the client must branch on the return value.
 */
export async function changePlanAction(planCode: string) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    try {
        const result = await subscriptionsAPI.changePlan(planCode);
        revalidatePath(ROUTES.DASHBOARD_SETTINGS_BILLING);
        return { success: true as const, plan: result.plan, error: null };
    } catch (error) {
        // Security: log full error server-side; return a generic client-safe message.
        console.error('[changePlanAction]', error);
        let message = 'Failed to change plan';
        if (error instanceof ApiResponseError) {
            if (error.statusCode === 403) {
                message = 'Paid plans are activated through billing and cannot be self-assigned.';
            } else if (error.statusCode === 400) {
                message = 'Plan changes are not available on this deployment.';
            } else if (error.statusCode === 404) {
                message = 'Plan not found.';
            }
        }
        return { success: false as const, plan: null, error: message };
    }
}
