import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { agentsAPI, type Agent } from '@/lib/api/agents';
import type { AstTemplateEntry } from '@/lib/api/agent-templates';
import { fetchAgentTemplateCatalog } from '@/lib/api/agent-templates.server';
import { AgentsList } from '@/components/agents';
import { AgentsPageTabs } from '@/components/agents/AgentsPageTabs';
import { SkillsSection } from '@/components/skills/SkillsSection';
import { loadSkillsPageData, parseSkillsSearchParams } from '@/lib/skills-page-data';

type SearchParams = Record<string, string | string[] | undefined>;

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
 * §3.5): this page is tab 2 of the Teams hub and now also hosts the **Skills
 * catalog** as a block below the Agent grid (anchor `#skills`; `/skills`
 * redirects here). It therefore reads the four Skills query params the old
 * `/skills` page owned — parsing and fetching both live in
 * `lib/skills-page-data.ts` so the two surfaces cannot drift — and adds that
 * fetch to the same `Promise.all`, keeping the page one round of waterfall.
 */
export default async function AgentsPage({
    searchParams,
}: {
    searchParams?: Promise<SearchParams>;
}) {
    const skillsFilters = parseSkillsSearchParams((await searchParams) ?? {});

    const [result, templates, skills] = await Promise.all([
        agentsAPI.list({ limit: 50 }).catch(() => ({
            data: [] as Agent[],
            meta: { total: 0, limit: 50, offset: 0 },
        })),
        fetchAgentTemplateCatalog('agent').catch(() => [] as AstTemplateEntry[]),
        // Already defensive internally: a failing side reports through
        // `loadErrors` instead of throwing the Agents page into the boundary.
        loadSkillsPageData(skillsFilters),
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

    // Run orchestration (Wave 4 M4) — Agents | Sessions tab strip above
    // the catalog; the Sessions tab is the org-wide fleet view.
    return (
        <div className="w-full">
            <AgentsPageTabs active="agents" />
            <AgentsList agents={result.data} templates={templates} userTemplates={userTemplates} />
            <SkillsSection data={skills} filters={skillsFilters} />
        </div>
    );
}
