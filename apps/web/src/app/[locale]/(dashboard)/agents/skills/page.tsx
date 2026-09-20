import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { AgentsPageTabs } from '@/components/agents/AgentsPageTabs';
import { AgentsHubTabs } from '@/components/agents/AgentsHubTabs';
import { SkillsSection } from '@/components/skills/SkillsSection';
import { loadSkillsPageData, parseSkillsSearchParams } from '@/lib/skills-page-data';

type SearchParams = Record<string, string | string[] | undefined>;

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('dashboard.agentsPage.skillsBlock');
    return { title: t('title') };
}

/**
 * `/agents/skills` — the **Skills** sub-tab of the Agents hub.
 *
 * The catalog itself is unchanged: this is `SkillsSection`, the exact component
 * (and the exact `loadSkillsPageData` / `parseSkillsSearchParams` pair) that
 * used to render as a `#skills` block at the bottom of `/agents`. What changed
 * is where it lives and how it is addressed:
 *
 *  - it has a URL of its own instead of an anchor, so the filters it owns
 *    (`section`, `search`, `tags`, `readiness`, `provenance`, `enabled`, `sort`,
 *    the two offsets) are shareable and survive a reload with a real path;
 *  - `/skills` (the old standalone page, retired by navigation consolidation)
 *    now redirects HERE, carrying its filters, instead of to `/agents#skills`;
 *  - `/agents#skills` — every link written against the anchor while the block
 *    lived there — is caught by `AgentsHashRedirect` on `/agents` and forwarded
 *    here, so old bookmarks and docs still land on the catalog.
 *
 * Server component: it only reads translations and forwards already-fetched
 * data, so the four filters keep costing one parallel round of fetches (no
 * Agents list to re-issue on this route, unlike when the block shared a page
 * with the catalog).
 */
export default async function AgentsSkillsPage({
    searchParams,
}: {
    searchParams?: Promise<SearchParams>;
}) {
    const filters = parseSkillsSearchParams((await searchParams) ?? {});
    const data = await loadSkillsPageData(filters);

    return (
        <div className="w-full">
            <AgentsPageTabs active="agents" />
            <AgentsHubTabs active="skills" />
            <SkillsSection data={data} filters={filters} />
        </div>
    );
}
