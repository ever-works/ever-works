'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { budgetsAPI, type CreateBudgetInput, type UpdateBudgetInput } from '@/lib/api/budgets';
import { getAuthFromCookie } from '@/lib/auth';
import { ROUTES } from '@/lib/constants';

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

export async function createBudget(workId: string, data: CreateBudgetInput) {
    await requireAuth();
    try {
        const result = await budgetsAPI.create(workId, data);
        revalidatePath(budgetsPath(workId));
        return { success: true as const, data: result.budget, error: null };
    } catch (error) {
        return {
            success: false as const,
            data: null,
            error: error instanceof Error ? error.message : 'Failed to create budget',
        };
    }
}

export async function updateBudget(
    workId: string,
    budgetId: string,
    data: UpdateBudgetInput,
) {
    await requireAuth();
    try {
        const result = await budgetsAPI.update(workId, budgetId, data);
        revalidatePath(budgetsPath(workId));
        return { success: true as const, data: result.budget, error: null };
    } catch (error) {
        return {
            success: false as const,
            data: null,
            error: error instanceof Error ? error.message : 'Failed to update budget',
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
        return {
            success: false as const,
            error: error instanceof Error ? error.message : 'Failed to delete budget',
        };
    }
}
