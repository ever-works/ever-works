import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { cn } from '@/lib/utils/cn';
import { WorkflowList } from '@/components/catalog/WorkflowList';
import { WorkflowRunTrace } from '@/components/catalog/WorkflowRunTrace';
import { workflowsAPI } from '@/lib/api/workflows';

type Params = Promise<{ id: string }>;
type SearchParams = Promise<{ run?: string | string[] }>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('metadata.pages');
    return { title: t('catalogWorkflows') };
}

/**
 * Capability catalogue (AW-21) — `/catalog/workflows/[id]`: one saved
 * workflow, its run history (newest first) and the trace of the selected run
 * (`?run=<id>`, defaulting to the latest). Everything reads the existing
 * `/api/workflows` routes.
 */
export default async function CatalogWorkflowPage({
    params,
    searchParams,
}: {
    params: Params;
    searchParams: SearchParams;
}) {
    const { id } = await params;
    if (!UUID_PATTERN.test(id)) notFound();
    const query = await searchParams;
    const t = await getTranslations('dashboard.catalogPage.workflows');
    const format = await getFormatter();

    const [workflowResult, runsResult] = await Promise.all([
        workflowsAPI.get(id),
        workflowsAPI.listRuns(id, { limit: 50 }),
    ]);
    if (!workflowResult.ok) {
        if (workflowResult.status === 404 || workflowResult.status === 400) notFound();
        throw new Error(workflowResult.message);
    }
    const workflow = workflowResult.data;
    const runs = runsResult.ok ? runsResult.data.items : [];
    const requestedRun = Array.isArray(query.run) ? query.run[0] : query.run;
    const selectedRunId =
        requestedRun && UUID_PATTERN.test(requestedRun) ? requestedRun : (runs[0]?.id ?? null);
    const runResult = selectedRunId ? await workflowsAPI.getRun(selectedRunId) : null;

    return (
        <div className="w-full space-y-6" data-testid="catalog-workflow-page">
            <Link
                href={ROUTES.DASHBOARD_CATALOG_WORKFLOWS}
                className="text-xs text-text-muted hover:text-text"
            >
                ← {t('backToList')}
            </Link>
            <div className="space-y-1">
                <h1 className="text-2xl font-semibold text-text dark:text-text-dark">
                    {workflow.name}
                </h1>
                {workflow.description && (
                    <p className="text-sm text-text-secondary dark:text-text-secondary-dark">
                        {workflow.description}
                    </p>
                )}
            </div>

            <WorkflowList
                workflows={[
                    {
                        id: workflow.id,
                        name: workflow.name,
                        description: workflow.description ?? '',
                        status: workflow.status,
                        nodeCount: workflow.graph?.nodes?.length ?? 0,
                        runCount: workflow.runCount ?? 0,
                        lastRunAt: workflow.lastRunAt ?? null,
                    },
                ]}
            />

            <div className="grid gap-6 lg:grid-cols-[18rem_1fr]">
                <section aria-labelledby="workflow-run-history" className="space-y-2">
                    <h2 id="workflow-run-history" className="text-sm font-semibold">
                        {t('history')}
                    </h2>
                    {runs.length === 0 ? (
                        <p className="text-sm text-text-muted">{t('noRuns')}</p>
                    ) : (
                        <ul className="space-y-1" data-testid="workflow-run-history">
                            {runs.map((run) => (
                                <li key={run.id}>
                                    <Link
                                        href={`${ROUTES.DASHBOARD_CATALOG_WORKFLOW(workflow.id)}?run=${run.id}`}
                                        aria-current={run.id === selectedRunId ? 'true' : undefined}
                                        className={cn(
                                            'block rounded-md px-3 py-2 text-sm hover:bg-surface-secondary dark:hover:bg-white/9',
                                            run.id === selectedRunId &&
                                                'bg-surface-secondary dark:bg-white/9',
                                        )}
                                    >
                                        <span className="font-mono">{run.id.slice(0, 8)}</span>
                                        <span className="block text-xs text-text-muted">
                                            {t(`runStatus.${run.status}`)} ·{' '}
                                            {t('stepCount', { count: run.stepCount })} ·{' '}
                                            {format.relativeTime(new Date(run.createdAt))}
                                        </span>
                                    </Link>
                                </li>
                            ))}
                        </ul>
                    )}
                </section>
                {runResult?.ok ? (
                    <WorkflowRunTrace run={runResult.data} graph={workflow.graph} />
                ) : (
                    <p className="text-sm text-text-muted">{t('traceHint')}</p>
                )}
            </div>
        </div>
    );
}
