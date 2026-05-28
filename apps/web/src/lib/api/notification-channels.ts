import 'server-only';
import { serverFetch, serverMutation } from './server-api';

/**
 * EW-663 / EW-679 — server-side API client for notification channels.
 */

export interface NotificationChannel {
    id: string;
    userId: string;
    pluginId: string;
    name: string;
    targetConfig: Record<string, unknown>;
    verified: boolean;
    disabledAt: string | null;
    createdAt: string;
    updatedAt: string;
}

export interface CreateChannelDto {
    pluginId: string;
    name: string;
    targetConfig: Record<string, unknown>;
}

export const notificationChannelsAPI = {
    list: async () => {
        const data = await serverFetch<{ channels: NotificationChannel[] }>({
            path: '/api/notification-channels',
        });
        return data.channels;
    },
    create: async (input: CreateChannelDto) => {
        const data = await serverMutation<{ channel: NotificationChannel }>({
            method: 'POST',
            path: '/api/notification-channels',
            body: input,
        });
        return data.channel;
    },
    update: async (id: string, input: Partial<CreateChannelDto> & { disabled?: boolean }) => {
        const data = await serverMutation<{ channel: NotificationChannel }>({
            method: 'PATCH',
            path: `/api/notification-channels/${id}`,
            body: input,
        });
        return data.channel;
    },
    remove: async (id: string) => {
        await serverMutation<void>({
            method: 'DELETE',
            path: `/api/notification-channels/${id}`,
        });
    },
    sendTest: async (id: string) => {
        return serverMutation<{ status: string; error?: string; providerMessageId?: string }>({
            method: 'POST',
            path: `/api/notification-channels/${id}/test`,
            body: {},
        });
    },
};
