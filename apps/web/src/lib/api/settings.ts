import 'server-only';
import { serverMutation, serverFetch } from './server-api';

// DTOs
export interface UpdateVercelTokenDto {
    token: string;
}

export interface NotificationPreferencesDto {
    email?: {
        updates?: boolean;
        newItems?: boolean;
        weeklyDigest?: boolean;
        marketing?: boolean;
    };
    app?: {
        newItems?: boolean;
        comments?: boolean;
        mentions?: boolean;
        systemUpdates?: boolean;
    };
}

export interface VercelTokenStatus {
    hasToken: boolean;
    validUntil?: Date;
}

export interface NotificationPreferencesResponse {
    email: {
        updates: boolean;
        newItems: boolean;
        weeklyDigest: boolean;
        marketing: boolean;
    };
    app: {
        newItems: boolean;
        comments: boolean;
        mentions: boolean;
        systemUpdates: boolean;
    };
}

export const settingsAPI = {
    getVercelTokenStatus: async () => {
        return serverFetch<VercelTokenStatus>('/settings/vercel-token/status');
    },

    // Notification Preferences
    getNotificationPreferences: async () => {
        return serverFetch<NotificationPreferencesResponse>('/settings/notifications');
    },

    updateNotificationPreferences: async (preferences: NotificationPreferencesDto) => {
        return serverMutation<NotificationPreferencesResponse>({
            endpoint: '/settings/notifications',
            data: preferences,
            method: 'PUT',
            wrapInData: false,
        });
    },

    // Export Data
    requestDataExport: async () => {
        return serverMutation<{ exportId: string; message: string }>({
            endpoint: '/settings/export-data',
            data: {},
            method: 'POST',
            wrapInData: false,
        });
    },

    getExportStatus: async (exportId: string) => {
        return serverFetch<{
            status: 'pending' | 'processing' | 'completed' | 'failed';
            downloadUrl?: string;
            error?: string;
        }>(`/settings/export/${exportId}/status`);
    },
};
