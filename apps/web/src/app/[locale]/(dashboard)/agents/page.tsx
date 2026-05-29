import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { agentsAPI, type Agent } from '@/lib/api/agents';
import { listAstTemplates, type AstTemplateEntry } from '@/lib/api/agent-templates';
import { AgentsList } from '@/components/agents';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('dashboard.agentsPage');
    return { title: t('title') };
}

/**
 * Agents/Skills/Tasks PR #1017 — Phase 5. `/agents` catalog page.
 * Server-fetches the user's Agent list + the agent-template catalog
 * once. Both fetches are defensive (`.catch`) so a flaky API / cold
 * catalog renders the empty-state surface (and fallback chips)
 * instead of a 500.
 *
 * agent-prompt-first-creation — the catalog feeds the quick-pick chips
 * + `View All` panel below the prompt composer; the user's existing
 * Agents are surfaced as "Your templates" (spec FR-29, Q2 default).
 */
export default async function AgentsPage() {
    const [result, templates] = await Promise.all([
        agentsAPI.list({ limit: 50 }).catch(() => ({
            data: [] as Agent[],
            meta: { total: 0, limit: 50, offset: 0 },
        })),
        listAstTemplates('agent').catch(() => [] as AstTemplateEntry[]),
    ]);

    // "Your templates" — the user's existing Agents as reusable
    // starting points. Until an explicit save-as-template flow ships,
    // this derives directly from the Agent list (spec Q2 default).
    const userTemplates: AstTemplateEntry[] = result.data.map((a) => ({
        slug: a.slug,
        title: a.name,
        description: a.title ?? a.capabilities ?? '',
        iconName: a.avatarIcon ?? undefined,
    }));

    return <AgentsList agents={result.data} templates={templates} userTemplates={userTemplates} />;
}
