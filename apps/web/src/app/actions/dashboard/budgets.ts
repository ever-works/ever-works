'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { budgetsAPI, type CreateBudgetInput, type UpdateBudgetInput } from '@/lib/api/budgets';
import { getAuthFromCookie } from '@/lib/auth';
import { ROUTES } from '@/lib/constants';
// Security: import ApiResponseError so HTTP status codes can be mapped to
// generic client-safe messages instead of forwarding raw backend strings.
import { ApiResponseError } from '@/lib/api/server-api';

/**
 * EW-602 — Server actions for the per-Work Budgets & Usage page.
 *
 * Each action authenticates via the cookie, proxies the mutation
 * through serverMutation (Bearer-auth attached), then revalidates
 * the budgets page so the next render shows fresh data without a
 * full reload.
 */

async function requireAuth() {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }
}

function budgetsPath(workId: string): string {
    return `/works/${workId}/settings/budgets-usage`;
}

// Security: map ApiResponseError HTTP status codes to generic client-safe
// messages so internal backend strings (plugin IDs, conflict details, etc.)
// are never forwarded to the browser verbatim.
function toBudgetClientError(error: unknown, fallback: string): string {
    if (error instanceof ApiResponseError) {
        if (error.statusCode === 409) {
            return 'A budget with these settings already exists. Please update the existing budget instead.';
        }
        if (error.statusCode === 400) {
            return 'Invalid budget settings. Please check your input and try again.';
        }
        if (error.statusCode === 403) {
            return 'You do not have permission to manage budgets for this work.';
        }
        if (error.statusCode === 404) {
            return 'Budget not found.';
        }
        return fallback;
    }
    return fallback;
}

export async function createBudget(workId: string, data: CreateBudgetInput) {
    await requireAuth();
    try {
        const result = await budgetsAPI.create(workId, data);
        revalidatePath(budgetsPath(workId));
        return { success: true as const, data: result.budget, error: null };
    } catch (error) {
        // Security: log full error server-side; return only a generic client-safe message.
        console.error('[createBudget]', error);
        return {
            success: false as const,
            data: null,
            error: toBudgetClientError(error, 'Failed to create budget'),
        };
    }
}

export async function updateBudget(workId: string, budgetId: string, data: UpdateBudgetInput) {
    await requireAuth();
    try {
        const result = await budgetsAPI.update(workId, budgetId, data);
        revalidatePath(budgetsPath(workId));
        return { success: true as const, data: result.budget, error: null };
    } catch (error) {
        // Security: log full error server-side; return only a generic client-safe message.
        console.error('[updateBudget]', error);
        return {
            success: false as const,
            data: null,
            error: toBudgetClientError(error, 'Failed to update budget'),
        };
    }
}

export async function deleteBudget(workId: string, budgetId: string) {
    await requireAuth();
    try {
        await budgetsAPI.remove(workId, budgetId);
        revalidatePath(budgetsPath(workId));
        return { success: true as const, error: null };
    } catch (error) {
        // Security: log full error server-side; return only a generic client-safe message.
        console.error('[deleteBudget]', error);
        return {
            success: false as const,
            error: toBudgetClientError(error, 'Failed to delete budget'),
        };
    }
}
