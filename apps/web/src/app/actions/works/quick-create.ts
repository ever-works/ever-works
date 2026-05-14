'use server';

import { worksAPI, type QuickCreateWorkRequest, type QuickCreateWorkResponse } from '@/lib/api/works';
import type { ActionResult } from '@/app/actions/plugins';

/**
 * EW-617 G4 — server action that the wizard's `CreateWorkStep` calls when
 * the user clicks "Generate now". Mirrors the existing onboarding action
 * shape (success-or-error envelope) so callers can `if (!result.success)`
 * uniformly.
 */
export async function quickCreateWorkAction(
    body: QuickCreateWorkRequest,
): Promise<ActionResult<QuickCreateWorkResponse>> {
    try {
        const data = await worksAPI.quickCreate(body);
        return { success: true, data };
    } catch (error) {
        console.error('Failed to quick-create work:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to start generation',
        };
    }
}
