import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { GitFork } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { PageHeader } from '@/components/common/PageHeader';
import { CatalogPager } from '@/components/catalog/CatalogPager';
import { WorkflowList } from '@/components/catalog/WorkflowList';
import {
    WORKFLOW_LIST_PAGE_SIZE,
    catalogHref,
    catalogPageWindow,
    parseCatalogOffset,
} from '@/components/catalog/workflow-pages';
import { workflowsAPI } from '@/lib/api/workflows';

type SearchParams = Promise<{ offset?: string | string[] }>;

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('metadata.pages');
    return { title: t('catalogWorkflows') };
}

/**
 * Capability catalogue (AW-21) — `/catalog/workflows`: every saved workflow
 * graph the caller owns, newest-updated first, each runnable from the list,
 * a page at a time (`?offset=`). Reads the existing `/api/workflows` routes;
 * there is no second backend.
 */
export default async function CatalogWorkflowsPage({
    searchParams,
}: {
    searchParams: SearchParams;
}) {
    const t = await getTranslations('dashboard.catalogPage');
    const offset = parseCatalogOffset((await searchParams).offset);
    const result = await workflowsAPI.list({ limit: WORKFLOW_LIST_PAGE_SIZE, offset });
    const page = result.ok
        ? catalogPageWindow({
              offset,
              pageSize: WORKFLOW_LIST_PAGE_SIZE,
              itemCount: result.data.items.length,
              total: result.data.total,
          })
        : null;
    const pager = page ? (
        <CatalogPager
            page={page}
            label={t('workflows.listPages')}
            testId="catalog-workflows-pager"
            previousHref={
                page.previousOffset === null
                    ? null
                    : catalogHref(ROUTES.DASHBOARD_CATALOG_WORKFLOWS, {
                          offset: page.previousOffset,
                      })
            }
            nextHref={
                page.nextOffset === null
                    ? null
                    : catalogHref(ROUTES.DASHBOARD_CATALOG_WORKFLOWS, { offset: page.nextOffset })
            }
        />
    ) : null;

    return (
        <div className="w-full space-y-6" data-testid="catalog-workflows-page">
            <Link
                href={ROUTES.DASHBOARD_CATALOG}
                className="text-xs text-text-muted hover:text-text"
            >
                ← {t('workflows.back')}
            </Link>
            <PageHeader
                icon={GitFork}
                title={t('sections.workflows')}
                subtitle={t('workflows.subtitle')}
                tone="primary"
            />
            {!result.ok ? (
                <div
                    role="alert"
                    className="rounded-lg border border-warning/30 bg-warning/5 p-4 text-sm"
                >
                    <p className="font-medium">{t('error.section')}</p>
                    <p className="text-xs text-text-muted">{t('error.sectionHint')}</p>
                </div>
            ) : result.data.total === 0 && offset === 0 ? (
                <p className="text-sm text-text-muted">{t('empty.workflows')}</p>
            ) : (
                <>
                    {result.data.items.length > 0 && (
                        <WorkflowList
                            workflows={result.data.items.map((row) => ({
                                id: row.id,
                                name: row.name,
                                description: row.description ?? '',
                                status: row.status,
                                nodeCount: row.graph?.nodes?.length ?? 0,
                                runCount: row.runCount ?? 0,
                                lastRunAt: row.lastRunAt ?? null,
                            }))}
                        />
                    )}
                    {pager}
                </>
            )}
        </div>
    );
}
