import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { githubAppAPI } from '@/lib/api/github-app';
import { GitHubAppSettings } from '@/components/settings/GitHubAppSettings';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('dashboard.settings');
    return { title: t('tabs.githubApp') };
}

export default async function GitHubAppSettingsPage() {
    const installations = await githubAppAPI.listInstallations();

    return <GitHubAppSettings installations={installations} />;
}
