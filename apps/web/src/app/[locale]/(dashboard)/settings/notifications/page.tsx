import { createHmac } from 'node:crypto';
import { authAPI } from '@/lib/api';
import { notificationPreferencesAPI } from '@/lib/api/notification-preferences';
import { notificationChannelsAPI } from '@/lib/api/notification-channels';
import { NotificationPreferencesSettings } from '@/components/settings/NotificationPreferencesSettings';
import { NovuInbox } from '@/components/notifications/NovuInbox';

/**
 * EW-664 / EW-679 — Notification preferences settings page.
 */
export default async function NotificationPreferencesPage() {
    const [eventTypes, preferences, channels, profile] = await Promise.all([
        notificationPreferencesAPI.listEventTypes().catch(() => []),
        notificationPreferencesAPI
            .getPreferences()
            .catch(() => ({ subscriptions: [], preference: null, mutes: [] })),
        notificationChannelsAPI.list().catch(() => []),
        authAPI.getProfile().catch(() => null),
    ]);

    // EW-665 — optional Novu inbox widget. Compute the HMAC subscriber
    // hash server-side (secured mode) when NOVU_SECRET_KEY is set; the
    // widget self-gates on NEXT_PUBLIC_NOVU_APP_ID, so this is a no-op
    // when Novu isn't configured.
    const novuSecret = process.env.NOVU_SECRET_KEY;
    const subscriberHash =
        novuSecret && profile?.id
            ? createHmac('sha256', novuSecret).update(profile.id).digest('hex')
            : undefined;

    return (
        <div className="space-y-6">
            {profile?.id ? (
                <NovuInbox subscriberId={profile.id} subscriberHash={subscriberHash} />
            ) : null}
            <NotificationPreferencesSettings
                initialEventTypes={eventTypes}
                initialPreferences={preferences}
                initialChannels={channels}
            />
        </div>
    );
}
