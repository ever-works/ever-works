'use server';

import { redirect } from 'next/navigation';
import type { HomeBlockId, HomeSummaryDto } from '@ever-works/contracts';
import { createTaskAction } from '@/app/actions/tasks';
import { canSubmitComposer, deriveTaskTitle } from '@/components/home/home.shared';
import { homeAPI } from '@/lib/api/home';
import { ApiResponseError } from '@/lib/api/server-api';
import { getAuthFromCookie } from '@/lib/auth';
import { ROUTES } from '@/lib/constants';

// Security: defense-in-depth auth guard at the web layer, the same one every
// sibling action file uses. It rejects unauthenticated callers before any
// request is issued; authenticated callers are unaffected (cache()d).
async function requireHomeAuth() {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }
}

/**
 * The composed morning read. A timezone the API refuses (a browser reporting
 * a zone this runtime does not know) is retried once without it, which
 * resolves to the profile timezone or UTC and says so — never a blank screen.
 */
export async function getHomeSummaryAction(tz?: string | null): Promise<HomeSummaryDto> {
    await requireHomeAuth();
    try {
        return await homeAPI.summary({ tz });
    } catch (error) {
        if (tz && error instanceof ApiResponseError && error.statusCode === 400) {
            return homeAPI.summary();
        }
        throw error;
    }
}

/** Re-read one block of the summary (a per-block retry). */
export async function refreshHomeBlockAction(
    blockId: HomeBlockId,
    tz?: string | null,
): Promise<HomeSummaryDto> {
    await requireHomeAuth();
    return homeAPI.summary({ tz, blocks: [blockId] });
}

export type CreateHomeTaskResult =
    | { ok: true; task: { id: string; title: string } }
    | { ok: false; reason: 'invalid' | 'throttled' | 'failed' };

/**
 * The composer: one sentence becomes one Task, through the existing Task
 * create action — the same endpoint, throttle and audit as the Task form.
 * Only a title and the sentence are sent: no owner and no status, so the Task
 * is unscoped and lands in the board's first lane (the create default).
 *
 * Failures come back as a reason rather than a thrown error, because a server
 * action's error message does not survive to the browser and the composer has
 * to tell a throttle apart from anything else.
 */
export async function createHomeTaskAction(text: string): Promise<CreateHomeTaskResult> {
    await requireHomeAuth();
    if (typeof text !== 'string' || !canSubmitComposer(text)) {
        return { ok: false, reason: 'invalid' };
    }
    try {
        const task = await createTaskAction({
            title: deriveTaskTitle(text),
            description: text.trim(),
        });
        return { ok: true, task: { id: task.id, title: task.title } };
    } catch (error) {
        if (error instanceof ApiResponseError && error.statusCode === 429) {
            return { ok: false, reason: 'throttled' };
        }
        console.error('[home] composer: POST /api/tasks failed', error);
        return { ok: false, reason: 'failed' };
    }
}
