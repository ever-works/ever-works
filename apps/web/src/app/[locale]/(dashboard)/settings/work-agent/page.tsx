import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { WorkAgentSettings } from '@/components/settings/WorkAgentSettings';
import { workAgentAPI } from '@/lib/api/work-agent';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('dashboard.settings');
    return { title: t('tabs.workAgent') };
}

export default async function WorkAgentSettingsPage() {
    const [preferences, buildRequests, activeRun] = await Promise.all([
        workAgentAPI.preferences(),
        workAgentAPI.listBuildRequests(),
        workAgentAPI.activeRun(),
    ]);
    const logs = activeRun ? await workAgentAPI.runLogs(activeRun.id).catch(() => []) : [];

    return (
        <WorkAgentSettings
            preferences={preferences}
            buildRequests={buildRequests}
            activeRun={activeRun}
            logs={logs}
        />
    );
}
