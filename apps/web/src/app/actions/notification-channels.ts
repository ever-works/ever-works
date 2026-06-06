'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getAuthFromCookie } from '@/lib/auth';
import { ROUTES } from '@/lib/constants';
import {
    notificationChannelsAPI,
    type NotificationChannel,
    type CreateChannelDto,
} from '@/lib/api/notification-channels';

/**
 * Security: defense-in-depth auth gate for these mutating server actions,
 * mirroring `app/actions/api-keys.ts` and the `ensureAuth()` helper in
 * `app/actions/account-transfer.ts`. The downstream API enforces auth + per-
 * object ownership, but gating at the Next.js layer fails closed if header
 * forwarding/middleware is ever misconfigured and avoids proxying an
 * unauthenticated caller's mutation verbatim. Behaviour is unchanged for
 * authenticated users; an unauthenticated caller is redirected to login.
 */
async function ensureAuth(): Promise<void> {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }
}

/**
 * Revalidate cached server components that render channel state (e.g. the
 * channels settings page + any layout that counts channels) after a
 * create/delete. Mirrors the `revalidatePath` calls in
 * `app/actions/notifications.ts`. `'layout'` scope invalidates nested
 * routes too, which covers the locale-prefixed dashboard tree.
 */
function revalidateChannels(): void {
    revalidatePath('/', 'layout');
}

export interface ChannelMutationResult {
    success: boolean;
    channel?: NotificationChannel;
    error?: string;
}

export interface ChannelTestResult {
    success: boolean;
    status?: string;
    providerMessageId?: string;
    error?: string;
}

/** Create a notification channel (Add-channel wizard submit). */
export async function createNotificationChannel(
    input: CreateChannelDto,
): Promise<ChannelMutationResult> {
    await ensureAuth();
    try {
        const channel = await notificationChannelsAPI.create(input);
        revalidateChannels();
        return { success: true, channel };
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to create channel',
        };
    }
}

/** Send a test notification through a channel (Test button). */
export async function sendNotificationChannelTest(id: string): Promise<ChannelTestResult> {
    await ensureAuth();
    try {
        const result = await notificationChannelsAPI.sendTest(id);
        // The provider plugin returns `{ status, error?, providerMessageId? }`.
        // A delivered/queued status is success; a returned `error` is failure.
        const ok = !result.error && result.status !== 'failed';
        return {
            success: ok,
            status: result.status,
            providerMessageId: result.providerMessageId,
            error: result.error,
        };
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Test failed',
        };
    }
}

/** Delete a notification channel. */
export async function deleteNotificationChannel(id: string): Promise<ChannelMutationResult> {
    await ensureAuth();
    try {
        await notificationChannelsAPI.remove(id);
        revalidateChannels();
        return { success: true };
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to delete channel',
        };
    }
}
