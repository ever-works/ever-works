'use server';

import {
    notificationChannelsAPI,
    type NotificationChannel,
    type CreateChannelDto,
} from '@/lib/api/notification-channels';

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
    try {
        const channel = await notificationChannelsAPI.create(input);
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
    try {
        await notificationChannelsAPI.remove(id);
        return { success: true };
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to delete channel',
        };
    }
}
