import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { Zap } from 'lucide-react';
import { PageHeader } from '@/components/common/PageHeader';
import { TasksTabsNav } from '@/components/tasks/TasksTabsNav';
import { TaskTriggersClient } from '@/components/tasks/TaskTriggersClient';
import { inboundTriggersAPI } from '@/lib/api/inbound-triggers';
import { agentsAPI } from '@/lib/api/agents';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('dashboard.taskTriggers');
    return { title: t('title') };
}

/**
 * Task Triggers — the Triggers tab of the Tasks surface: rules that
 * fire on inbound webhooks or ingested platform events and spawn Tasks.
 * Server-fetches the trigger list plus a compact agent roster for the
 * target-agent picker; every mutation goes through the inbound-trigger
 * server actions.
 */
export default async function TaskTriggersPage() {
    const t = await getTranslations('dashboard.taskTriggers');
    const [triggers, agentsResult] = await Promise.all([
        inboundTriggersAPI.list().catch(() => []),
        agentsAPI.list({ limit: 100 }).catch(() => null),
    ]);
    const agents = (agentsResult?.data ?? []).map((agent) => ({
        id: agent.id,
        name: agent.name,
    }));

    return (
        <div className="w-full">
            <PageHeader icon={Zap} title={t('title')} subtitle={t('subtitle')} tone="task" />
            <TasksTabsNav active="triggers" />
            <TaskTriggersClient initialTriggers={triggers} agents={agents} />
        </div>
    );
}
