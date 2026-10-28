'use client';

import { useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle, ExternalLink } from 'lucide-react';
import type { FleetActionsJobView } from '@ever-works/contracts';
import { Button } from '@/components/ui/button';
import { formatWaited, jobDiagnosisLine } from './runners.shared';
import { safeHttpsUrl } from '@/lib/utils/safe-link';

const LINK = 'inline-flex items-center gap-1 text-xs text-primary hover:underline';

/**
 * Actions jobs (FL-18 P2, spec §0, §5.4, FR-20, FR-22, FR-23) — one queued or
 * running job of the hub's Actions jobs panel:
 *
 * ```
 * ◐ acme/api   CI · test · ubuntu   #4821   build-01-2 · running 4 min
 * ◷ acme/api   CI · e2e · windows   #4822   queued 6 min
 *              ⚠ no runner can take it — no runner has the label windows   [Cancel workflow run…]
 * ◷ acme/api   CI · lint            #4823   queued 2 min · waiting for build-01-1
 * ```
 *
 * The diagnosis is the API's, from the closed set (FR-22); "waiting for
 * <runner>" is not a problem and reads muted. **Open job on GitHub** opens the
 * job; **Cancel workflow run…** is offered to the `machines` audience only
 * (`canCancel`) and confirmed by the panel's dialog. A row the needs-a-look item
 * pointed at (`?actionsJob=`) is highlighted and scrolled into view.
 */
export function ActionsJobRow({
    job,
    highlighted = false,
    canCancel,
    paused,
    busy,
    onCancel,
}: {
    job: FleetActionsJobView;
    highlighted?: boolean;
    /** The viewer may cancel workflow runs (`machines`, FR-23). */
    canCancel: boolean;
    /** The kill switch is on: cancelling is paused. */
    paused: boolean;
    /** A cancel of this run is in flight. */
    busy: boolean;
    onCancel: (job: FleetActionsJobView) => void;
}) {
    const t = useTranslations('fleet.runners.jobs');
    const tDiagnosis = useTranslations('fleet.runners.diagnosis');
    const ref = useRef<HTMLLIElement | null>(null);
    const diagnosis = jobDiagnosisLine(job);
    const running = job.status === 'in_progress';
    const waited = formatWaited(running ? job.startedAt : job.queuedAt);
    const title = job.workflowName ? `${job.workflowName} · ${job.name}` : job.name;

    useEffect(() => {
        const element = ref.current;
        if (highlighted && element && typeof element.scrollIntoView === 'function') {
            element.scrollIntoView({ block: 'center' });
        }
    }, [highlighted]);

    const where = running
        ? [job.runnerName, waited ? t('running', { duration: waited }) : t('runningNow')]
              .filter(Boolean)
              .join(' · ')
        : waited
          ? t('queued', { duration: waited })
          : t('queuedNow');

    return (
        <li
            ref={ref}
            className={`flex flex-col gap-1 border-t border-border py-2 first:border-t-0 dark:border-border-dark ${
                highlighted ? 'rounded-md bg-primary/5 px-2 ring-1 ring-primary/40' : ''
            }`}
            aria-current={highlighted ? 'true' : undefined}
            data-testid="fleet-actions-job"
            data-status={job.status}
            data-highlighted={highlighted ? 'true' : undefined}
        >
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span
                    aria-hidden
                    className={
                        running ? 'text-success' : 'text-text-muted dark:text-text-muted-dark'
                    }
                >
                    {running ? '◐' : '◷'}
                </span>
                <span className="font-medium">{job.repository}</span>
                <span>{title}</span>
                {typeof job.runNumber === 'number' ? (
                    <span className="text-text-muted dark:text-text-muted-dark">
                        {t('run', { number: job.runNumber })}
                    </span>
                ) : null}
                <span
                    className="text-xs text-text-muted dark:text-text-muted-dark"
                    data-testid="fleet-actions-job-where"
                >
                    {where}
                </span>
            </div>
            {diagnosis ? (
                <p
                    className={`flex items-center gap-1 text-xs ${
                        diagnosis.problem
                            ? 'text-warning'
                            : 'text-text-muted dark:text-text-muted-dark'
                    }`}
                    data-testid="fleet-actions-job-diagnosis"
                    data-diagnosis={job.diagnosis ?? undefined}
                >
                    {diagnosis.problem ? (
                        <>
                            <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden />
                            {`${t('noRunner')} — `}
                        </>
                    ) : null}
                    {tDiagnosis(diagnosis.key, diagnosis.values)}
                </p>
            ) : null}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                {safeHttpsUrl(job.url) ? (
                    <a
                        href={safeHttpsUrl(job.url) ?? undefined}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={LINK}
                        data-testid="fleet-actions-job-open"
                    >
                        {t('openJob')}
                        <ExternalLink className="h-3 w-3" aria-hidden />
                    </a>
                ) : null}
                {canCancel ? (
                    <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => onCancel(job)}
                        disabled={paused || busy}
                        title={paused ? t('cancelPaused') : undefined}
                        data-testid="fleet-actions-job-cancel"
                    >
                        {t('cancel')}
                    </Button>
                ) : null}
            </div>
        </li>
    );
}
