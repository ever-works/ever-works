import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { authAPI } from '@/lib/api/auth';
import { SecuritySettings } from '@/components/settings/SecuritySettings';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('metadata.pages');
    return { title: t('security') };
}

export default async function SecuritySettingsPage() {
    // Get fresh profile
    const profile = await authAPI.getFreshProfile();

    return <SecuritySettings user={profile} />;
}
