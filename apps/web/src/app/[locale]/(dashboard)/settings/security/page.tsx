import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { requireFreshProfile } from '@/lib/auth/require-fresh-profile';
import { getEverIdSecuritySettings } from '@/lib/auth/ever-id-settings';
import { SecuritySettings } from '@/components/settings/SecuritySettings';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('metadata.pages');
    return { title: t('security') };
}

export default async function SecuritySettingsPage({
    searchParams,
}: {
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
    // Get fresh profile. A rejected session redirects to login instead of
    // 500ing the route; a real backend failure still reaches the error
    // boundary. See `requireFreshProfile`.
    const profile = await requireFreshProfile('settings/security');

    // APW-12 (Ever ID) — the Connected identities card, plus the notice a
    // connect attempt carried back in `?everId=`.
    const everId = await getEverIdSecuritySettings(profile.id, await searchParams);

    return <SecuritySettings user={profile} everId={everId} />;
}
