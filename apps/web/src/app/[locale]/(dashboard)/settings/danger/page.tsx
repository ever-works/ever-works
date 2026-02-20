import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { authAPI } from '@/lib/api/auth';
import { DangerZone } from '@/components/settings/DangerZone';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('metadata.pages');
    return { title: t('dangerZone') };
}

export default async function DangerZoneSettingsPage() {
    const profile = await authAPI.getFreshProfile();

    return <DangerZone user={profile} />;
}
