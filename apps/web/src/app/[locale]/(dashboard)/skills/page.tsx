import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { Sparkles } from 'lucide-react';
import { skillsAPI } from '@/lib/api/skills';
import type { Skill, SkillCatalogEntry } from '@/lib/api/skills';
import { SkillsPageClient } from '@/components/skills/SkillsPageClient';

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
            <div className="flex items-start gap-3 mb-6">
                <div className="shrink-0 w-9 h-9 rounded-lg bg-success/10 border border-success/20 flex items-center justify-center">
                    <Sparkles className="w-4 h-4 text-success" />
                </div>
                <div>
                    <h1 className="text-2xl font-semibold text-text dark:text-text-dark">
                        {t('title')}
                    </h1>
                    <p className="text-sm text-text-secondary dark:text-text-secondary-dark mt-1 max-w-2xl">
                        {t('subtitle')}
                    </p>
                </div>
            </div>
            <SkillsPageClient
                installed={installed.data ?? []}
                catalog={catalog.entries ?? []}
            />
        </div>
    );
}
