import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { GitFork } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { PageHeader } from '@/components/common/PageHeader';
import { WorkflowList } from '@/components/catalog/WorkflowList';
import { workflowsAPI } from '@/lib/api/workflows';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('metadata.pages');
    return { title: t('catalogWorkflows') };
}

const PAGE_SIZE = 50;

/**
 * Capability catalogue (AW-21) — `/catalog/workflows`: every saved workflow
 * graph the caller owns, newest-updated first, each runnable from the list.
 * Reads the existing `/api/workflows` routes; there is no second backend.
 */
export default async function CatalogWorkflowsPage() {
    const t = await getTranslations('dashboard.catalogPage');
    const result = await workflowsAPI.list({ limit: PAGE_SIZE });

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
            ) : result.data.items.length === 0 ? (
                <p className="text-sm text-text-muted">{t('empty.workflows')}</p>
            ) : (
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
        </div>
    );
}
