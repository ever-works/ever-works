import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { Compass } from 'lucide-react';
import { PageHeader } from '@/components/common/PageHeader';
import { CatalogShell } from '@/components/catalog/CatalogShell';
import type {
    CatalogIndexData,
    CatalogSectionData,
    CatalogStartingPoint,
    CatalogStartingPointKind,
    CatalogWorkflowCard,
} from '@/components/catalog/catalog-data';
import { catalogAPI } from '@/lib/api/catalog';
import { skillsAPI } from '@/lib/api/skills';
import { taskTemplatesAPI } from '@/lib/api/task-templates';
import { templatesAPI } from '@/lib/api/templates';
import { workflowsAPI } from '@/lib/api/workflows';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('metadata.pages');
    return { title: t('catalog') };
}

/** Enough to search across on the page; each section still shows its true total. */
const SECTION_FETCH_LIMIT = 50;
const STARTING_POINT_KINDS: readonly CatalogStartingPointKind[] = ['work', 'website', 'mission'];

function failed<T>(): CatalogSectionData<T> {
    return { items: [], total: 0, error: true };
}

/**
 * Capability catalogue (AW-21) — `/catalog`.
 *
 * One index over what this workspace can do: Playbooks, Skills, Workflows,
 * Task templates and Starting points. Every section reads its OWN existing
 * endpoint in one `Promise.all`, and each fetch is independently guarded, so
 * a failing source renders that section's error state and nothing else.
 * Everything is server-rendered; the client shell only filters.
 */
export default async function CatalogPage() {
    const t = await getTranslations('dashboard.catalogPage');

    const [playbooks, skills, workflows, taskTemplates, startingPoints] = await Promise.all([
        catalogAPI
            .listPlaybooks({ limit: SECTION_FETCH_LIMIT })
            .then((result): CatalogIndexData['playbooks'] =>
                result.ok
                    ? { items: result.data.items, total: result.data.total, error: false }
                    : failed(),
            ),
        Promise.all([
            skillsAPI.listCatalog({ limit: SECTION_FETCH_LIMIT }),
            // Only used to mark catalogue skills already installed; the
            // section still renders when this read fails.
            skillsAPI.listInstalled({ limit: 200 }).catch(() => ({ data: [] })),
        ])
            .then(([catalog, installed]): CatalogIndexData['skills'] => {
                const installedSlugs = new Set(
                    installed.data.map((skill) => skill.sourceCatalogSlug).filter(Boolean),
                );
                return {
                    items: catalog.entries.map((entry) => ({
                        slug: entry.slug,
                        title: entry.title,
                        description: entry.description,
                        tags: entry.tags ?? [],
                        installed: installedSlugs.has(entry.slug),
                    })),
                    total: catalog.total,
                    error: false,
                };
            })
            .catch((): CatalogIndexData['skills'] => failed()),
        workflowsAPI
            .list({ limit: SECTION_FETCH_LIMIT })
            .then((result): CatalogIndexData['workflows'] =>
                result.ok
                    ? {
                          items: result.data.items.map(
                              (row): CatalogWorkflowCard => ({
                                  id: row.id,
                                  name: row.name,
                                  description: row.description ?? '',
                                  status: row.status,
                                  nodeCount: row.graph?.nodes?.length ?? 0,
                                  runCount: row.runCount ?? 0,
                                  lastRunAt: row.lastRunAt ?? null,
                              }),
                          ),
                          total: result.data.total,
                          error: false,
                      }
                    : failed(),
            ),
        taskTemplatesAPI
            .list()
            .then(({ data }): CatalogIndexData['taskTemplates'] => ({
                items: (data ?? []).map((row) => ({
                    id: row.id,
                    name: row.name,
                    description: row.description ?? '',
                    labels: row.labels ?? [],
                    stepCount: row.steps?.length ?? 0,
                    needApprovalCount: (row.steps ?? []).filter((step) => step.requiresApproval)
                        .length,
                })),
                total: data?.length ?? 0,
                error: false,
            }))
            .catch((): CatalogIndexData['taskTemplates'] => failed()),
        Promise.all(STARTING_POINT_KINDS.map((kind) => templatesAPI.list(kind)))
            .then((responses): CatalogIndexData['startingPoints'] => {
                const items = responses.map(
                    (response, index): CatalogStartingPoint => ({
                        kind: STARTING_POINT_KINDS[index],
                        count: response.templates?.length ?? 0,
                    }),
                );
                return { items, total: items.length, error: false };
            })
            .catch((): CatalogIndexData['startingPoints'] => failed()),
    ]);

    return (
        <div className="w-full space-y-6" data-testid="catalog-page">
            <PageHeader icon={Compass} title={t('title')} subtitle={t('subtitle')} tone="primary" />
            <CatalogShell data={{ playbooks, skills, workflows, taskTemplates, startingPoints }} />
        </div>
    );
}
