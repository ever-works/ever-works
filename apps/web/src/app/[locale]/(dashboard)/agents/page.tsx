import type { Metadata } from 'next';
import { Suspense } from 'react';
import { RecordViewTabs } from '@/components/record-visibility';
import { parseRecordTab } from '@/lib/record-visibility';
import { getTranslations } from 'next-intl/server';
import { agentsAPI, type Agent } from '@/lib/api/agents';
import type { AstTemplateEntry } from '@/lib/api/agent-templates';
import { fetchAgentTemplateCatalog } from '@/lib/api/agent-templates.server';
import { AgentsList } from '@/components/agents';
import { AgentsPageTabs } from '@/components/agents/AgentsPageTabs';
import { AgentsHubTabs } from '@/components/agents/AgentsHubTabs';
import { AgentsHashRedirect } from '@/components/agents/AgentsHashRedirect';

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
 *
 * Navigation consolidation (`docs/specs/features/navigation-consolidation`
 * §3.5) once hosted the **Skills catalog** here as a `#skills` block below the
 * Agent grid, which is why this page used to read the four Skills query
 * params. The Activity merge moved Skills to a sub-tab of its own
 * (`/agents/skills`, `AgentsHubTabs`), so this page is back to ONE job and one
 * round of fetches — and `AgentsHashRedirect` still catches the old
 * `/agents#skills` links.
 */
export default async function AgentsPage({
    searchParams,
}: {
    /** Record visibility (EW-P1-3) list tab: `?tab=mine|shared|organization`. */
    searchParams: Promise<{ tab?: string | string[] }>;
}) {
    const tab = parseRecordTab((await searchParams).tab);
    const [result, templates] = await Promise.all([
        agentsAPI.list({ limit: 50, view: tab }).catch(() => ({
            data: [] as Agent[],
            meta: { total: 0, limit: 50, offset: 0 },
        })),
        fetchAgentTemplateCatalog('agent').catch(() => [] as AstTemplateEntry[]),
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

    // Agents hub: the top strip (Teams | Agents | Archived) plus this tab's own
    // sub-strip (Agents | Skills | Activity) above the catalog.
    return (
        <div className="w-full">
            <AgentsPageTabs active="agents" />
            <AgentsHubTabs active="agents" />
            <AgentsHashRedirect />
            <Suspense fallback={null}>
                <RecordViewTabs />
            </Suspense>
            <AgentsList
                key={tab}
                agents={result.data}
                templates={templates}
                userTemplates={userTemplates}
            />
        </div>
    );
}
