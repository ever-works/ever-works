import 'server-only';
import { serverFetch, serverMutation } from './server-api';

/**
 * EW-664 / EW-679 — server-side API client for notification preferences.
 */

export interface NotificationEventType {
    key: string;
    category: string;
    title: string;
    description: string;
    urgent: boolean;
    defaultChannels: string[];
    source: 'core' | 'plugin';
    pluginId: string | null;
}

export interface NotificationSubscription {
    id: string;
    userId: string;
    eventTypeKey: string;
    channelIds: string[];
}

export interface NotificationPreference {
    userId: string;
    quietHoursStart: string | null;
    quietHoursEnd: string | null;
    timezone: string | null;
}

export interface PreferencesView {
    subscriptions: NotificationSubscription[];
    preference: NotificationPreference | null;
    mutes: { category: string; mutedUntil: string | null }[];
}

export const notificationPreferencesAPI = {
    listEventTypes: async () => {
        const data = await serverFetch<{ eventTypes: NotificationEventType[] }>(
            '/api/notifications/event-types',
        );
        return data.eventTypes;
    },
    getPreferences: async () => {
        return serverFetch<PreferencesView>('/api/notifications/preferences');
    },
    setEventSubscription: async (eventKey: string, channelIds: string[]) => {
        return serverMutation<{ subscription: NotificationSubscription }>({
            method: 'PUT',
            endpoint: `/api/notifications/preferences/event/${encodeURIComponent(eventKey)}`,
            data: { channelIds },
            wrapInData: false,
        });
    },
    setQuietHours: async (input: {
        quietHoursStart: string | null;
        quietHoursEnd: string | null;
        timezone: string | null;
    }) => {
        return serverMutation<{ preference: NotificationPreference }>({
            method: 'PUT',
            endpoint: '/api/notifications/preferences/quiet-hours',
            data: input,
            wrapInData: false,
        });
    },
    muteCategory: async (category: string, mutedUntil: string | null) => {
        return serverMutation<{ mute: { category: string; mutedUntil: string | null } }>({
            method: 'POST',
            endpoint: '/api/notifications/preferences/mute',
            data: { category, mutedUntil },
            wrapInData: false,
        });
    },
    unmuteCategory: async (category: string) => {
        await serverMutation<void>({
            method: 'DELETE',
            endpoint: `/api/notifications/preferences/mute/${encodeURIComponent(category)}`,
            data: {},
            wrapInData: false,
        });
    },
};
