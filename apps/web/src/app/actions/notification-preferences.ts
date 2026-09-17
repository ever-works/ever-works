'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import type { NotificationMatrixDto } from '@ever-works/contracts';
import { getAuthFromCookie } from '@/lib/auth';
import { ROUTES } from '@/lib/constants';
import { notificationPreferencesAPI } from '@/lib/api/notification-preferences';

/**
 * AW-13 — server actions behind Settings -> Notifications (the notification
 * matrix).
 *
 * Same defense-in-depth gate as `app/actions/notification-channels.ts`: the
 * API enforces auth and per-user scoping, and an unauthenticated caller is
 * redirected to login here before anything is proxied.
 */
async function ensureAuth(): Promise<void> {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }
}

function revalidateNotificationSettings(): void {
    revalidatePath('/', 'layout');
}

function errorMessage(error: unknown, fallback: string): string {
    return error instanceof Error && error.message ? error.message : fallback;
}

export interface NotificationMatrixActionResult<T = undefined> {
    success: boolean;
    data?: T;
    error?: string;
}

/** Refetch the whole matrix (used when the page regains focus). */
export async function loadNotificationMatrix(): Promise<
    NotificationMatrixActionResult<NotificationMatrixDto>
> {
    await ensureAuth();
    try {
        return { success: true, data: await notificationPreferencesAPI.getMatrix() };
    } catch (error) {
        return {
            success: false,
            error: errorMessage(error, 'Failed to load notification settings'),
        };
    }
}

/**
 * Save one row: the exact list of delivery targets for one event. An empty
 * list is an explicit "nothing" and is stored as such.
 *
 * Goes through the matrix write, which stores the choice with the matrix
 * marker: only a choice made here may leave the bell or every external target
 * out. The generic per-event write keeps its original meaning for other callers.
 */
export async function setNotificationEventTargets(
    eventKey: string,
    targetIds: string[],
): Promise<NotificationMatrixActionResult<{ targetIds: string[] }>> {
    await ensureAuth();
    try {
        const { subscription } = await notificationPreferencesAPI.setMatrixEventTargets(
            eventKey,
            targetIds,
        );
        revalidateNotificationSettings();
        return { success: true, data: { targetIds: subscription?.channelIds ?? targetIds } };
    } catch (error) {
        return { success: false, error: errorMessage(error, 'Failed to save') };
    }
}

/** Reset stored choices (for `eventKeys`, or every event) to the recommended defaults. */
export async function resetNotificationMatrix(
    eventKeys?: string[],
): Promise<NotificationMatrixActionResult<{ changed: number }>> {
    await ensureAuth();
    try {
        const result = await notificationPreferencesAPI.resetMatrix(eventKeys);
        revalidateNotificationSettings();
        return { success: true, data: { changed: result.changed } };
    } catch (error) {
        return { success: false, error: errorMessage(error, 'Failed to reset') };
    }
}

/**
 * Set or clear quiet hours. `urgentBypassesQuietHours` is the person's opt-in
 * to let every urgent event through; leave it out to keep what is stored.
 */
export async function setNotificationQuietHours(input: {
    quietHoursStart: string | null;
    quietHoursEnd: string | null;
    timezone: string | null;
    urgentBypassesQuietHours?: boolean;
}): Promise<NotificationMatrixActionResult> {
    await ensureAuth();
    try {
        await notificationPreferencesAPI.setQuietHours(input);
        revalidateNotificationSettings();
        return { success: true };
    } catch (error) {
        return { success: false, error: errorMessage(error, 'Failed to save quiet hours') };
    }
}

/** End a category mute early. */
export async function unmuteNotificationCategory(
    category: string,
): Promise<NotificationMatrixActionResult> {
    await ensureAuth();
    try {
        await notificationPreferencesAPI.unmuteCategory(category);
        revalidateNotificationSettings();
        return { success: true };
    } catch (error) {
        return { success: false, error: errorMessage(error, 'Failed to unmute') };
    }
}
