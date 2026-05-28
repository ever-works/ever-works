import { notificationPreferencesAPI } from '@/lib/api/notification-preferences';
import { notificationChannelsAPI } from '@/lib/api/notification-channels';
import { NotificationPreferencesSettings } from '@/components/settings/NotificationPreferencesSettings';

/**
 * EW-664 / EW-679 — Notification preferences settings page.
 */
export default async function NotificationPreferencesPage() {
    const [eventTypes, preferences, channels] = await Promise.all([
        notificationPreferencesAPI.listEventTypes().catch(() => []),
        notificationPreferencesAPI
            .getPreferences()
            .catch(() => ({ subscriptions: [], preference: null, mutes: [] })),
        notificationChannelsAPI.list().catch(() => []),
    ]);
    return (
        <NotificationPreferencesSettings
            initialEventTypes={eventTypes}
            initialPreferences={preferences}
            initialChannels={channels}
        />
    );
}
