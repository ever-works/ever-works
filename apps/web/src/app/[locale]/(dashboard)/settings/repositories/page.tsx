import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { repoConnectionsAPI } from '@/lib/api/repo-connections';
import { githubAppAPI } from '@/lib/api/github-app';
import { RepositoriesSettings } from '@/components/settings/RepositoriesSettings';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('dashboard.settings');
    return { title: t('tabs.repositories') };
}

export default async function RepositoriesSettingsPage() {
    // Installations are optional context (credential picker + import
    // list); a flaky GitHub-App API must never 500 the registry page.
    // includeDerived surfaces the Work repos as read-only entries with
    // the "Work" source badge alongside manual + imported rows.
    const [repos, installations] = await Promise.all([
        repoConnectionsAPI.list(true),
        githubAppAPI.listInstallations().catch(() => []),
    ]);

    return <RepositoriesSettings repos={repos} installations={installations} />;
}
