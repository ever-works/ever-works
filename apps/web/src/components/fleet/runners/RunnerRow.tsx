'use client';

import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { ExternalLink } from 'lucide-react';
import type { FleetActionsRunnerView } from '@ever-works/contracts';
import { Link } from '@/i18n/navigation';
import { openLogsForSource } from '../logs/logs-tab.registry';
import {
    formatClock,
    runnerLabelChips,
    runnerStatus,
    runnerUpdateAvailable,
    type RunnerTone,
} from './runners.shared';

const TONE_CLASS: Readonly<Record<RunnerTone, string>> = {
    ok: 'text-success',
    muted: 'text-text-muted dark:text-text-muted-dark',
    warning: 'text-warning',
    danger: 'text-danger',
};

const LINK = 'inline-flex items-center gap-1 text-xs text-primary hover:underline';

/**
 * Actions runners on computers (FL-18 P1, spec §5.2, FR-13, FR-17, FR-18) —
 * one runner on a computer's Overview:
 *
 * `● build-01-1   acme/api   idle   self-hosted Linux X64 gpu   service · 2.321.0   checked 09:41`
 *
 * The state reads with its glyph — `◐ working · "<job>" run #<n>`, `■ stopped
 * (by you)`, `◌ installing · verifying`, `✕ failed — <first line>`, `? unknown
 * — <the discrepancy>` — with who said so (GitHub or the computer) on hover.
 * **Logs** opens the computer's Logs tab on the runner's diagnostic log
 * (`runner:<name>`, FL-08); **Open on GitHub** opens the runner settings page,
 * **Open job on GitHub** the job a working runner is on. `actions` is the
 * row's act menu (`RunnerActionsMenu`).
 */
export function RunnerRow({
    runner,
    nodeId,
    computer,
    actions,
}: {
    runner: FleetActionsRunnerView;
    nodeId: string;
    /** The computer's name ("as build-01 reports it"). */
    computer: string;
    actions?: ReactNode;
}) {
    const t = useTranslations('fleet.runners.row');
    const status = runnerStatus(runner);
    const job = runner.state === 'working' ? runner.currentJob : null;
    const checked = formatClock(runner.lastCheckAt);
    // P3 (FR-28): GitHub publishes a newer build for this runner's platform; Reinstall takes it.
    const update = runnerUpdateAvailable(runner);
    const source =
        runner.stateSource === 'github'
            ? t('sourceGithub')
            : runner.stateSource === 'node'
              ? t('sourceNode', { name: computer })
              : undefined;

    return (
        <li
            className="flex flex-col gap-1 border-t border-border py-2 first:border-t-0 dark:border-border-dark"
            data-testid="fleet-runner-row"
            data-runner={runner.name}
            data-state={runner.state}
        >
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="flex items-center gap-2 font-medium">
                    <span aria-hidden className={TONE_CLASS[status.tone]}>
                        {status.glyph}
                    </span>
                    {runner.name}
                </span>
                <span className="text-text-muted dark:text-text-muted-dark">{runner.target}</span>
                <span
                    className={TONE_CLASS[status.tone]}
                    title={source}
                    data-testid="fleet-runner-state"
                >
                    {t(`states.${status.labelKey}` as Parameters<typeof t>[0])}
                    {status.phaseKey
                        ? ` · ${t(`phases.${status.phaseKey}` as Parameters<typeof t>[0])}`
                        : null}
                    {status.detail ? ` — ${status.detail}` : null}
                </span>
                {job ? (
                    <span data-testid="fleet-runner-job">
                        {typeof job.runNumber === 'number'
                            ? t('jobRun', { job: job.name, run: job.runNumber })
                            : t('job', { job: job.name })}
                    </span>
                ) : null}
                <span className="flex flex-wrap gap-1" aria-label={t('labels')}>
                    {runnerLabelChips(runner).map((label) => (
                        <span
                            key={label}
                            className="rounded bg-surface-secondary px-1.5 py-0.5 text-xs dark:bg-surface-secondary-dark"
                        >
                            {label}
                        </span>
                    ))}
                </span>
                <span className="text-xs text-text-muted dark:text-text-muted-dark">
                    {t(`modes.${runner.mode}` as Parameters<typeof t>[0])}
                    {runner.runnerVersion
                        ? ` · ${t('version', { version: runner.runnerVersion })}`
                        : null}
                </span>
                {update ? (
                    <span
                        className="rounded bg-primary/10 px-1.5 py-0.5 text-xs text-primary"
                        data-testid="fleet-runner-update"
                    >
                        {t('updateAvailable', { version: update })}
                    </span>
                ) : null}
                {checked ? (
                    <span className="text-xs text-text-muted dark:text-text-muted-dark">
                        {t('checked', { time: checked })}
                    </span>
                ) : null}
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                {actions}
                <Link
                    href={openLogsForSource(nodeId, runner.logSource)}
                    className={LINK}
                    aria-label={t('logsOf', { name: runner.name })}
                    data-testid="fleet-runner-logs"
                >
                    {t('logs')}
                </Link>
                {job?.url ? (
                    <a
                        href={job.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={LINK}
                        data-testid="fleet-runner-open-job"
                    >
                        {t('openJob')}
                        <ExternalLink className="h-3 w-3" aria-hidden />
                    </a>
                ) : null}
                <a
                    href={runner.githubUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={LINK}
                    data-testid="fleet-runner-open-github"
                >
                    {t('openOnGitHub')}
                    <ExternalLink className="h-3 w-3" aria-hidden />
                </a>
            </div>
        </li>
    );
}
