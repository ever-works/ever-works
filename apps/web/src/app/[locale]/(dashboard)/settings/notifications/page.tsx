import { createHmac } from 'node:crypto';
import { authAPI } from '@/lib/api';
import { notificationPreferencesAPI } from '@/lib/api/notification-preferences';
import { NotificationPreferencesSettings } from '@/components/settings/NotificationPreferencesSettings';
import { NovuInbox } from '@/components/notifications/NovuInbox';

/**
 * Settings -> Notifications (EW-664 / EW-679; AW-13 notification matrix).
 *
 * One read for the whole matrix, plus the profile read the optional Novu
 * widget needs. Each read degrades on its own, so a Novu or profile failure
 * can never blank the matrix, and a matrix failure renders a load error that
 * promises nothing changed.
 */
export default async function NotificationPreferencesPage() {
    const [matrix, profile] = await Promise.all([
        notificationPreferencesAPI.getMatrix().catch(() => null),
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
            <NotificationPreferencesSettings initialMatrix={matrix} />
        </div>
    );
}
