import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { Plus, Sparkles } from 'lucide-react';
import { skillsAPI } from '@/lib/api/skills';
import type { Skill, SkillCatalogEntry } from '@/lib/api/skills';
import { SkillsPageClient } from '@/components/skills/SkillsPageClient';
import { PageHeader } from '@/components/common/PageHeader';
import { Button } from '@/components/ui/button';
import { ROUTES } from '@/lib/constants';

const PAGE_SIZE = 50;
const SECTIONS = ['installed', 'available', 'custom'] as const;
type Section = (typeof SECTIONS)[number];

type SearchParams = Record<string, string | string[] | undefined>;

function firstParam(value: string | string[] | undefined): string | undefined {
    return Array.isArray(value) ? value[0] : value;
}

function parseOffset(value: string | string[] | undefined): number {
    const raw = firstParam(value);
    if (!raw) return 0;
    const parsed = Number(raw);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

function parseSection(value: string | string[] | undefined): Section {
    const raw = firstParam(value);
    return SECTIONS.includes(raw as Section) ? (raw as Section) : 'installed';
}

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
export default async function SkillsPage({
    searchParams,
}: {
    searchParams?: Promise<SearchParams>;
}) {
    const t = await getTranslations('dashboard.skillsPage');
    const params = (await searchParams) ?? {};
    const section = parseSection(params.section);
    const search = firstParam(params.search)?.trim() ?? '';
    const installedOffset = parseOffset(params.installedOffset);
    const catalogOffset = parseOffset(params.catalogOffset);
    const [installed, catalog] = await Promise.all([
        skillsAPI.listInstalled({ limit: PAGE_SIZE, offset: installedOffset, search }).then(
            (result) => ({ result, error: null as string | null }),
            () => ({
                result: {
                    data: [] as Skill[],
                    meta: { total: 0, limit: PAGE_SIZE, offset: installedOffset },
                },
                error: 'installed',
            }),
        ),
        skillsAPI.listCatalog({ limit: PAGE_SIZE, offset: catalogOffset, search }).then(
            (result) => ({ result, error: null as string | null }),
            () => ({
                result: { entries: [] as SkillCatalogEntry[], total: 0 },
                error: 'catalog',
            }),
        ),
    ]);

    return (
        <div className="w-full">
            <PageHeader
                icon={Sparkles}
                title={t('title')}
                subtitle={t('subtitle')}
                tone="success"
                actions={
                    <Button
                        href={ROUTES.DASHBOARD_SKILL_NEW}
                        size="sm"
                        className="gap-1.5 shrink-0"
                    >
                        <Plus className="w-3.5 h-3.5" aria-hidden="true" />
                        {t('list.newSkill')}
                    </Button>
                }
            />
            <SkillsPageClient
                installed={installed.result.data ?? []}
                installedMeta={installed.result.meta}
                catalog={catalog.result.entries ?? []}
                catalogTotal={catalog.result.total ?? 0}
                catalogLimit={PAGE_SIZE}
                filters={{ section, search, installedOffset, catalogOffset }}
                loadErrors={{
                    installed: installed.error,
                    catalog: catalog.error,
                }}
            />
        </div>
    );
}
