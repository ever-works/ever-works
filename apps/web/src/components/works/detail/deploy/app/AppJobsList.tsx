'use client';

import { useId, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Play, ScrollText } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils/cn';
import { appRuntimeOpsClient } from '@/lib/api/app-runtime-ops.client';
import type { AppJobRunView, AppStatusRequestView } from '@/lib/api/app-runtime.types';
import { durationSeconds } from './app-ops-format';

export interface AppJobsListProps {
    workId: string;
    jobs: Array<{ name: string; last?: AppJobRunView }>;
    /** Whether the member may run jobs and read logs (edit). */
    canEdit: boolean;
    /** The tab's recent requests, so a queued run of a job disables its Run now. */
    requests?: AppStatusRequestView[];
    /** A Deployment holds the lock: runs are refused, so Run now is disabled with the reason. */
    deploying?: boolean;
    onLogs?: (job: string) => void;
    /** After the API accepted a run — the page re-reads the status. */
    onRan?: () => void;
}

/** The refusal codes the run dialog explains in its own words → their `refusals.*` leaf. */
const RUN_REFUSALS = {
    job_active: 'jobActive',
    deploy_in_progress: 'deployInProgress',
    job_confirmation_required: 'confirmRequired',
    app_not_deployed: 'notDeployed',
    APP_WORK_DELETING: 'deleting',
    invalid_job_name: 'invalidName',
    forbidden: 'forbidden',
} as const;
type RunRefusalLeaf = (typeof RUN_REFUSALS)[keyof typeof RUN_REFUSALS];

/** A job's `when` → its `when.*` leaf. */
const WHEN_LEAF = {
    'pre-deploy': 'preDeploy',
    'first-deploy': 'firstDeploy',
    'post-deploy': 'postDeploy',
} as const satisfies Record<AppJobRunView['when'], string>;

/**
 * Lane aw-ops (APW-06 T38, FR-51) — the App spec's jobs with their last run, **Logs** and
 * **Run now**. A job changes the app's data (a migration, a seed), so Run now always opens a
 * confirmation dialog — a first-deploy job says plainly it was meant to run once — and the run is
 * sent only after the member ticks the confirmation. One run per job at a time: Run now is
 * disabled while a run is going or queued, and during a Deployment.
 */
export function AppJobsList({
    workId,
    jobs,
    canEdit,
    requests,
    deploying,
    onLogs,
    onRan,
}: AppJobsListProps) {
    const t = useTranslations('dashboard.workDetail.appDeploy.jobs');
    const [running, setRunning] = useState<{ name: string; when?: AppJobRunView['when'] } | null>(
        null,
    );

    if (jobs.length === 0) {
        return <p className="text-sm text-text-secondary">{t('empty')}</p>;
    }

    const queued = new Set(
        (requests ?? [])
            .filter(
                (request) =>
                    request.op === 'job-run' &&
                    (request.state === 'queued' || request.state === 'running'),
            )
            .map((request) => request.jobName ?? ''),
    );

    return (
        <>
            <ul
                className="divide-y divide-card-border dark:divide-white/9"
                data-testid="app-jobs-list"
            >
                {jobs.map((job) => {
                    const last = job.last;
                    const busy = last?.status === 'running' || queued.has(job.name);
                    const seconds = durationSeconds(last?.startedAt, last?.completedAt);
                    return (
                        <li
                            key={job.name}
                            className="flex flex-wrap items-center justify-between gap-2 py-2"
                            data-testid="app-job-row"
                            data-name={job.name}
                            data-status={last?.status ?? 'never'}
                        >
                            <div className="min-w-0 space-y-0.5">
                                <div className="flex flex-wrap items-center gap-1.5">
                                    <code className="text-xs font-semibold">{job.name}</code>
                                    {last?.when && WHEN_LEAF[last.when] && (
                                        <span className="rounded border border-card-border px-1.5 text-[10px] text-text-muted dark:border-white/9">
                                            {t(`when.${WHEN_LEAF[last.when]}`)}
                                        </span>
                                    )}
                                </div>
                                <p
                                    className={cn(
                                        'text-xs',
                                        last?.status === 'failed' || last?.status === 'timeout'
                                            ? 'font-medium text-red-700 dark:text-red-400'
                                            : 'text-text-secondary',
                                    )}
                                >
                                    {queued.has(job.name) && last?.status !== 'running'
                                        ? t('status.queued')
                                        : last
                                          ? seconds !== null
                                              ? t('lastRunWithDuration', {
                                                    status: t(`status.${last.status}`),
                                                    seconds,
                                                })
                                              : t(`status.${last.status}`)
                                          : t('neverRun')}
                                    {typeof last?.exitCode === 'number' && last.exitCode !== 0
                                        ? ` · ${t('exitCode', { code: last.exitCode })}`
                                        : ''}
                                </p>
                            </div>
                            {canEdit && (
                                <div className="flex gap-1">
                                    <Button
                                        type="button"
                                        size="sm"
                                        variant="ghost"
                                        onClick={() => onLogs?.(job.name)}
                                        aria-label={t('logsAria', { name: job.name })}
                                        data-testid="app-job-logs"
                                    >
                                        <ScrollText
                                            className="mr-1 h-3.5 w-3.5"
                                            aria-hidden="true"
                                        />
                                        {t('logs')}
                                    </Button>
                                    <Button
                                        type="button"
                                        size="sm"
                                        variant="secondary"
                                        onClick={() =>
                                            setRunning({ name: job.name, when: last?.when })
                                        }
                                        disabled={busy || deploying === true}
                                        title={
                                            deploying
                                                ? t('deployInProgress')
                                                : busy
                                                  ? t('active')
                                                  : undefined
                                        }
                                        aria-label={t('runAria', { name: job.name })}
                                        data-testid="app-job-run-open"
                                    >
                                        <Play className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
                                        {t('run')}
                                    </Button>
                                </div>
                            )}
                        </li>
                    );
                })}
            </ul>
            {running && (
                <AppJobRunDialog
                    workId={workId}
                    job={running}
                    onOpenChange={(open) => {
                        if (!open) setRunning(null);
                    }}
                    onRan={() => {
                        setRunning(null);
                        onRan?.();
                    }}
                />
            )}
        </>
    );
}

export interface AppJobRunDialogProps {
    workId: string;
    job: { name: string; when?: AppJobRunView['when'] };
    onOpenChange: (open: boolean) => void;
    onRan: () => void;
}

/**
 * The confirmation before a job runs. **Run** stays disabled until the member ticks "I understand"
 * — the API refuses an unconfirmed run (`422 job_confirmation_required`) anyway, so this is the
 * same rule said first. A refusal is shown inside the dialog, which stays open.
 */
export function AppJobRunDialog({ workId, job, onOpenChange, onRan }: AppJobRunDialogProps) {
    const t = useTranslations('dashboard.workDetail.appDeploy.jobs');
    const checkboxId = useId();
    const [confirmed, setConfirmed] = useState(false);
    const [pending, setPending] = useState(false);
    const [message, setMessage] = useState<string | null>(null);
    const inFlight = useRef(false);

    const run = async () => {
        if (!confirmed || inFlight.current) return;
        inFlight.current = true;
        setPending(true);
        setMessage(null);
        try {
            const result = await appRuntimeOpsClient.runJob(workId, job.name);
            if (result.ok) {
                toast.success(
                    result.data?.dispatched === false
                        ? t('notDispatched', { name: job.name })
                        : t('queued', { name: job.name }),
                );
                onRan();
                return;
            }
            const leaf = result.code
                ? (RUN_REFUSALS as Readonly<Record<string, RunRefusalLeaf>>)[result.code]
                : undefined;
            setMessage(
                leaf
                    ? t(`refusals.${leaf}`)
                    : t('failed', {
                          reason: result.message ?? result.code ?? String(result.status),
                      }),
            );
        } finally {
            inFlight.current = false;
            setPending(false);
        }
    };

    return (
        <Dialog open onOpenChange={onOpenChange}>
            <DialogContent className="max-w-lg">
                <DialogClose onClose={() => onOpenChange(false)} />
                <div className="space-y-4" data-testid="app-job-run-dialog">
                    <DialogHeader>
                        <DialogTitle>{t('runTitle', { name: job.name })}</DialogTitle>
                        <DialogDescription>{t('runDescription')}</DialogDescription>
                    </DialogHeader>
                    {job.when === 'first-deploy' && (
                        <p
                            className="rounded border border-amber-300 bg-amber-50/60 p-2 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-900/10 dark:text-amber-300"
                            data-testid="app-job-first-deploy-warning"
                        >
                            {t('firstDeployWarning')}
                        </p>
                    )}
                    <label htmlFor={checkboxId} className="flex items-start gap-2 text-sm">
                        <input
                            id={checkboxId}
                            type="checkbox"
                            className="mt-0.5"
                            checked={confirmed}
                            onChange={(event) => setConfirmed(event.target.checked)}
                            data-testid="app-job-run-confirm"
                        />
                        <span>{t('confirmCheckbox')}</span>
                    </label>
                    {message && (
                        <p
                            className="text-sm text-red-600 dark:text-red-400"
                            role="alert"
                            data-testid="app-job-run-error"
                        >
                            {message}
                        </p>
                    )}
                    <DialogFooter>
                        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                            {t('cancel')}
                        </Button>
                        <Button
                            type="button"
                            onClick={() => void run()}
                            disabled={!confirmed || pending}
                            loading={pending}
                            data-testid="app-job-run-submit"
                        >
                            {t('runConfirm')}
                        </Button>
                    </DialogFooter>
                </div>
            </DialogContent>
        </Dialog>
    );
}
