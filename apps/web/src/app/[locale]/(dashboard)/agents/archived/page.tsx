import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { agentsAPI, type Agent } from '@/lib/api/agents';
import { ArchivedAgentsList } from '@/components/agents/ArchivedAgentsList';
import { AgentsPageTabs } from '@/components/agents/AgentsPageTabs';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('dashboard.agentsPage.archived');
    return { title: t('title') };
}

/**
 * `/agents/archived` — third tab of the Agents page. Archiving is a
 * soft-delete (`DELETE /api/agents/:id` → `status='archived'`), which
 * the catalog filters out; this view is where those Agents remain
 * reachable, and where the permanent delete
 * (`DELETE /api/agents/:id?hard=true`) is offered.
 *
 * Same defensive fetch as the catalog page — a flaky API renders the
 * empty state rather than a 500.
 */
export default async function ArchivedAgentsPage() {
    const result = await agentsAPI.list({ status: 'archived', limit: 50 }).catch(() => ({
        data: [] as Agent[],
        meta: { total: 0, limit: 50, offset: 0 },
    }));

    return (
        <div className="w-full">
            <AgentsPageTabs active="archived" />
            <ArchivedAgentsList agents={result.data} />
        </div>
    );
}
