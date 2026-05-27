import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { Sparkles } from 'lucide-react';
import { skillsAPI } from '@/lib/api/skills';
import type { Skill, SkillCatalogEntry } from '@/lib/api/skills';
import { SkillsPageClient } from '@/components/skills/SkillsPageClient';
import { PageHeader } from '@/components/common/PageHeader';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('dashboard.skillsPage');
    return { title: t('title') };
}

/**
 * Agents/Skills/Tasks PR #1017 — Phase 9. Real `/skills` page.
 *
 * Server-fetches installed Skills + the catalog union in parallel.
 * The client component renders the three-section layout
 * (Installed / Available / Custom) per `features/skills/plan.md §6`.
 *
 * Defensive `.catch(...)` so a partial backend failure (e.g.
 * a flaky catalog plugin) still renders the page with the
 * sections that did load.
 */
export default async function SkillsPage() {
    const t = await getTranslations('dashboard.skillsPage');
    const [installed, catalog] = await Promise.all([
        skillsAPI
            .listInstalled({ limit: 50 })
            .catch(() => ({ data: [] as Skill[], meta: { total: 0, limit: 50, offset: 0 } })),
        skillsAPI
            .listCatalog({ limit: 50 })
            .catch(() => ({ entries: [] as SkillCatalogEntry[], total: 0 })),
    ]);

    return (
        <div className="w-full overflow-auto p-6 max-w-screen-2xl mx-auto">
            <PageHeader
                icon={Sparkles}
                title={t('title')}
                subtitle={t('subtitle')}
                tone="success"
            />
            <SkillsPageClient installed={installed.data ?? []} catalog={catalog.entries ?? []} />
        </div>
    );
}
