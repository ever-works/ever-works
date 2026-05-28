import { notificationChannelsAPI } from '@/lib/api/notification-channels';
import { NotificationChannelsSettings } from '@/components/settings/NotificationChannelsSettings';

/**
 * EW-663 / EW-679 — Notification channels settings page.
 */
export default async function NotificationChannelsPage() {
    let initialChannels: Awaited<ReturnType<typeof notificationChannelsAPI.list>> = [];
    try {
        initialChannels = await notificationChannelsAPI.list();
    } catch {
        initialChannels = [];
    }
    return <NotificationChannelsSettings initialChannels={initialChannels} />;
}
