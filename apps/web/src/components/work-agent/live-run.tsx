import type { WorkAgentRun, WorkAgentRunLog } from '@/lib/api/work-agent';
import { LogList } from './log-list';
import { Metric } from './metric';
import { StatusPill } from './status-pill';

/**
 * Phase 4 PR K — extracted from WorkAgentSettings.tsx so the
 * Mission detail page (Phase 6 PR R) can render a LIST of these
 * (one per in-flight run) per Decision A15 instead of duplicating
 * the JSX. The label strings live on `labels` so the parent
 * controls i18n — this component stays decoupled from any
 * specific `useTranslations(...)` namespace.
 *
 * `activeRun = null` → renders just the no-run empty state.
 * Output is byte-identical to the inline structure the
 * extraction replaced (Decision A10).
 */
export interface LiveRunLabels {
    worksMetric: string;
    itemsMetric: string;
    emptyWaitingForUpdate: string;
    emptyNoActiveRun: string;
}

export function LiveRun({
    activeRun,
    logs,
    labels,
}: {
    activeRun: WorkAgentRun | null;
    logs: WorkAgentRunLog[];
    labels: LiveRunLabels;
}) {
    if (!activeRun) {
        return (
            <p className="text-sm text-text-muted dark:text-text-muted-dark">
                {labels.emptyNoActiveRun}
            </p>
        );
    }

    return (
        <>
            <div className="flex items-center justify-between gap-3">
                <StatusPill status={activeRun.status} />
                <span className="text-xs text-text-muted dark:text-text-muted-dark">
                    {activeRun.progressPercent}%
                </span>
            </div>
            <div className="h-2 rounded-full bg-surface-secondary dark:bg-surface-secondary-dark overflow-hidden">
                <div
                    className="h-full bg-primary transition-all"
                    style={{ width: `${activeRun.progressPercent}%` }}
                />
            </div>
            <div className="grid grid-cols-2 gap-2 text-xs">
                <Metric label={labels.worksMetric} value={activeRun.summary.worksCreated} />
                <Metric label={labels.itemsMetric} value={activeRun.summary.itemsCreated} />
            </div>
            <LogList logs={logs} emptyText={labels.emptyWaitingForUpdate} />
        </>
    );
}
