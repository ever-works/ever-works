import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { requireFreshProfile } from '@/lib/auth/require-fresh-profile';
import { SecuritySettings } from '@/components/settings/SecuritySettings';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('metadata.pages');
    return { title: t('security') };
}

export default async function SecuritySettingsPage() {
    // Get fresh profile. A rejected session redirects to login instead of
    // 500ing the route; a real backend failure still reaches the error
    // boundary. See `requireFreshProfile`.
    const profile = await requireFreshProfile('settings/security');

    return <SecuritySettings user={profile} />;
}
