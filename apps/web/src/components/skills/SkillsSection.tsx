import { Plus, Sparkles } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { PageHeader } from '@/components/common/PageHeader';
import { Button } from '@/components/ui/button';
import { ROUTES } from '@/lib/constants';
import type { SkillsPageData, SkillsPageFilters } from '@/lib/skills-page-data';
import { SkillsPageClient } from './SkillsPageClient';

/**
 * Navigation consolidation (docs/specs/features/navigation-consolidation §3.5):
 * the Skills catalog is a block on the Agents tab rather than its own sidebar
 * entry — nobody browses Skills without an Agent in mind. `/skills` (index)
 * redirects to `/agents#skills`; the detail routes are unchanged.
 *
 * Server component: it only reads translations and forwards already-fetched
 * data. `SkillsPageClient` inside is the client island that owns the
 * section/search state, pointed at `/agents` + `#skills` so its `router.replace`
 * keeps the reader on this page and on this anchor.
 */
export async function SkillsSection({
    data,
    filters,
}: {
    data: SkillsPageData;
    filters: SkillsPageFilters;
}) {
    const t = await getTranslations('dashboard.agentsPage');
    const tSkills = await getTranslations('dashboard.skillsPage');

    return (
        <section
            id="skills"
            data-testid="agents-skills-section"
            className="mt-10 rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-5 sm:p-6"
        >
            <PageHeader
                icon={Sparkles}
                as="h2"
                title={t('skillsBlock.title')}
                subtitle={t('skillsBlock.subtitle')}
                tone="success"
                actions={
                    <>
                        {/* EW-058: the only inbound link to the /skills/templates
                            browser — it moved here with the catalog. */}
                        <Button
                            href={ROUTES.DASHBOARD_SKILL_TEMPLATES}
                            variant="secondary"
                            size="sm"
                            className="gap-1.5 shrink-0"
                        >
                            {tSkills('list.browseTemplates')}
                        </Button>
                        <Button
                            href={ROUTES.DASHBOARD_SKILL_NEW}
                            size="sm"
                            className="gap-1.5 shrink-0"
                        >
                            <Plus className="w-3.5 h-3.5" aria-hidden="true" />
                            {tSkills('list.newSkill')}
                        </Button>
                    </>
                }
            />
            <SkillsPageClient
                {...data}
                filters={filters}
                basePath={ROUTES.DASHBOARD_AGENTS}
                hash="#skills"
            />
        </section>
    );
}
