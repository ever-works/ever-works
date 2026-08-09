import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { agentsAPI } from '@/lib/api/agents';
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
 * Unlike the catalog page, this fetch is deliberately not caught. An
 * empty archive and an unreachable API must not render the same, or
 * the restore / permanent-delete actions silently disappear with no
 * indication they are only temporarily unavailable. A rejection falls
 * through to the dashboard error boundary, which offers a retry.
 */
export default async function ArchivedAgentsPage() {
    const result = await agentsAPI.list({ status: 'archived', limit: 50 });

    return (
        <div className="w-full">
            <AgentsPageTabs active="archived" />
            <ArchivedAgentsList agents={result.data} />
        </div>
    );
}
