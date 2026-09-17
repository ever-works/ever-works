import { useTranslations } from 'next-intl';
import { CheckCircle2, XCircle } from 'lucide-react';
import type { WorkflowGraph } from '@ever-works/contracts';
import type { WorkflowRunDetail } from '@/lib/api/workflows.shared';
import { cn } from '@/lib/utils/cn';

function stringifyOutput(output: unknown): string {
    if (typeof output === 'string') return output;
    try {
        return JSON.stringify(output, null, 2) ?? '';
    } catch {
        return String(output);
    }
}

/**
 * One workflow run's trace: which nodes ran and how each ended, the edges it
 * traversed, the choices made at decision nodes, any errors, and the final
 * output as the run recorded it (already capped server-side).
 */
export function WorkflowRunTrace({ run, graph }: { run: WorkflowRunDetail; graph: WorkflowGraph }) {
    const t = useTranslations('dashboard.catalogPage.workflows');
    const trace = run.trace;
    const kindOf = new Map(graph.nodes.map((node) => [node.id, node.kind]));
    const hasOutput = run.output !== null && run.output !== undefined && run.output !== '';

    return (
        <section
            aria-labelledby="workflow-run-trace"
            data-testid="workflow-run-trace"
            data-run-id={run.id}
            className="space-y-4 rounded-lg border border-border dark:border-border-dark bg-surface dark:bg-surface-dark p-4"
        >
            <header className="flex flex-wrap items-baseline gap-2">
                <h2 id="workflow-run-trace" className="text-sm font-semibold">
                    {t('runLabel', { id: run.id.slice(0, 8) })}
                </h2>
                <span data-testid="workflow-run-status" className="text-xs text-text-muted">
                    {t(`runStatus.${run.status}`)} · {t('stepCount', { count: run.stepCount })}
                    {typeof run.durationMs === 'number' && (
                        <> · {t('duration', { seconds: Math.round(run.durationMs / 100) / 10 })}</>
                    )}
                </span>
            </header>

            {run.errorMessage && (
                <p role="alert" className="text-sm text-danger">
                    {run.errorMessage}
                </p>
            )}

            <ol className="space-y-1" data-testid="workflow-trace-nodes">
                {(trace?.nodes ?? []).map((node, index) => (
                    <li
                        key={`${node.nodeId}-${index}`}
                        className="flex flex-wrap items-center gap-3 text-sm"
                    >
                        <span className="w-5 text-right tabular-nums text-text-muted">
                            {index + 1}
                        </span>
                        <span className="font-mono">{node.nodeId}</span>
                        <span className="text-xs text-text-muted">
                            {kindOf.get(node.nodeId) ?? ''}
                        </span>
                        <span
                            className={cn(
                                'inline-flex items-center gap-1 text-xs font-medium',
                                node.ok ? 'text-success' : 'text-danger',
                            )}
                        >
                            {node.ok ? (
                                <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
                            ) : (
                                <XCircle className="h-3 w-3" aria-hidden="true" />
                            )}
                            {node.ok ? t('nodeOk') : t('nodeFailed')}
                        </span>
                        {node.error && <span className="text-xs text-danger">{node.error}</span>}
                    </li>
                ))}
                {(trace?.nodes ?? []).length === 0 && (
                    <li className="text-sm text-text-muted">{t('none')}</li>
                )}
            </ol>

            <div className="grid gap-4 md:grid-cols-2">
                <div>
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-text-muted">
                        {t('edgesTraversed')}
                    </h3>
                    <p className="text-sm font-mono break-words">
                        {(trace?.traversedEdges ?? []).length > 0
                            ? trace?.traversedEdges.join(' → ')
                            : t('none')}
                    </p>
                </div>
                <div>
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-text-muted">
                        {t('decisions')}
                    </h3>
                    <ul className="text-sm">
                        {(trace?.decisions ?? []).map((decision, index) => (
                            <li key={`${decision.nodeId}-${index}`}>
                                {t('chose', { node: decision.nodeId, choice: decision.choice })}
                            </li>
                        ))}
                        {(trace?.decisions ?? []).length === 0 && (
                            <li className="text-text-muted">{t('none')}</li>
                        )}
                    </ul>
                </div>
            </div>

            {(trace?.errors ?? []).length > 0 && (
                <div>
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-text-muted">
                        {t('errors')}
                    </h3>
                    <ul className="text-sm text-danger">
                        {trace?.errors.map((error, index) => (
                            <li key={index}>{error}</li>
                        ))}
                    </ul>
                </div>
            )}
            {trace?.truncated && <p className="text-xs text-text-muted">{t('traceTruncated')}</p>}

            <div>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-text-muted">
                    {t('output')}
                </h3>
                {hasOutput ? (
                    <pre className="max-h-96 overflow-auto rounded-md bg-surface-secondary dark:bg-white/5 p-3 text-xs">
                        {stringifyOutput(run.output)}
                    </pre>
                ) : (
                    <p className="text-sm text-text-muted">{t('noOutput')}</p>
                )}
                {run.outputTruncated && (
                    <p className="text-xs text-text-muted">{t('outputTruncated')}</p>
                )}
            </div>
        </section>
    );
}
