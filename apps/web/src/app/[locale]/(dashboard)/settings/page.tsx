import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { requireFreshProfile } from '@/lib/auth/require-fresh-profile';
import { ProfileSettings } from '@/components/settings/ProfileSettings';
import { notificationPreferencesAPI } from '@/lib/api/notification-preferences';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('metadata.pages');
    return { title: t('profile') };
}

export default async function SettingsPage() {
    // Get fresh profile. A rejected session redirects to login instead of
    // 500ing the route; a real backend failure still reaches the error
    // boundary. See `requireFreshProfile`.
    const profile = await requireFreshProfile('settings');

    // Owner 2026-09-18 — the account's time zone, for the `Time zone` control.
    // Read from the notification preferences, which is where the product
    // already keeps it (the morning read falls back to it, the runs ledger
    // resolves its day window in it, quiet hours are interpreted in it).
    // Catch-defended like every other settings read: a flaky endpoint shows
    // the control unset (UTC) instead of breaking the page.
    const preferences = await notificationPreferencesAPI.getPreferences().catch(() => null);

    return <ProfileSettings user={profile} timezone={preferences?.preference?.timezone ?? null} />;
}
