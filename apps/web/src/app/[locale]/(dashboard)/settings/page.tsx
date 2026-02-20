import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { authAPI } from '@/lib/api/auth';
import { ProfileSettings } from '@/components/settings/ProfileSettings';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('metadata.pages');
    return { title: t('profile') };
}

export default async function SettingsPage() {
    // Get fresh profile
    const profile = await authAPI.getFreshProfile();

    return <ProfileSettings user={profile} />;
}
