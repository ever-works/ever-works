import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { agentsAPI, type Agent } from '@/lib/api/agents';
import { AgentsList } from '@/components/agents';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('dashboard.agentsPage');
    return { title: t('title') };
}

/**
 * Agents/Skills/Tasks PR #1017 — Phase 5. `/agents` catalog page.
 * Server-fetches the user's Agent list once. Defensive
 * `.catch(() => [])` so a flaky API renders the empty-state
 * surface instead of a 500.
 */
export default async function AgentsPage() {
    const result = await agentsAPI.list({ limit: 50 }).catch(() => ({
        data: [] as Agent[],
        meta: { total: 0, limit: 50, offset: 0 },
    }));
    return <AgentsList agents={result.data} />;
}
