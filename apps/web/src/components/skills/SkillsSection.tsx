import { Plus, Sparkles } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { PageHeader } from '@/components/common/PageHeader';
import { Button } from '@/components/ui/button';
import { ROUTES } from '@/lib/constants';
import type { SkillsPageData, SkillsPageFilters } from '@/lib/skills-page-data';
import { SkillsPageClient } from './SkillsPageClient';

/**
 * The Skills catalog — now the **Skills** sub-tab of the Agents hub, at
 * `/agents/skills`, beside Agents and Activity.
 *
 * It has been two other things: the standalone `/skills` page (until navigation
 * consolidation, docs/specs/features/navigation-consolidation §3.5) and then an
 * `#skills` anchor block at the bottom of the Agents catalog, because nobody
 * browses Skills without an Agent in mind. The anchor was the compromise that
 * kept the catalog reachable without a nav entry; a sub-tab gives it a real URL,
 * its own filters in the address bar, and a page that does not re-issue the
 * Agents list on every filter click. `/skills` and `/agents#skills` both
 * redirect here.
 *
 * Server component: it only reads translations and forwards already-fetched
 * data. `SkillsPageClient` inside is the client island that owns the
 * section/search state, pointed at this page's own path so its `router.replace`
 * keeps the reader here.
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
            className="rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-5 sm:p-6"
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
                basePath={ROUTES.DASHBOARD_AGENTS_SKILLS}
            />
        </section>
    );
}
