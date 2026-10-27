'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { FleetCommandRunView, FleetScheduleView } from '@ever-works/contracts';
import { commandsClient } from '../commands/commands.client';
import { schedulesClient } from './schedules.client';
import { formatRunDuration, runGlyph, runSkipText, twoZoneTime } from './schedules.shared';

/**
 * Schedules on computers (FL-13, spec S6, FR-20) — one schedule's history,
 * inline under its row: the last 30 runs newest first, each with its outcome
 * glyph, the fire it belongs to, when it actually started, how long it took
 * and its exit status — or, for a skipped fire, why in words. **Output**
 * shows the stored head and tail; **Open full output** downloads the whole
 * output from the computer while it is online (FL-12's route).
 */
export function ScheduleRunHistory({
    schedule,
    viewerZone,
}: {
    schedule: FleetScheduleView;
    viewerZone: string;
}) {
    const t = useTranslations('fleet.schedules.history');
    const [runs, setRuns] = useState<FleetCommandRunView[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [open, setOpen] = useState<string | null>(null);
    const computer = schedule.nodeName ?? t('removedComputer');

    useEffect(() => {
        let cancelled = false;
        void schedulesClient.runs(schedule.id).then((result) => {
            if (cancelled) return;
            if (result.ok) setRuns(result.data);
            else setError(result.error.hint ?? t('failed'));
        });
        return () => {
            cancelled = true;
        };
    }, [schedule.id, schedule.lastRunAt, t]);

    const download = async (run: FleetCommandRunView) => {
        const result = await commandsClient.fullOutput(schedule.id, run.id);
        if (!result.ok) {
            setError(result.error.hint ?? t('failed'));
            return;
        }
        const url = URL.createObjectURL(result.blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = result.filename;
        link.click();
        URL.revokeObjectURL(url);
    };

    if (error) {
        return (
            <p role="alert" className="px-2 py-1 text-xs text-red-600 dark:text-red-400">
                {error}
            </p>
        );
    }
    if (runs === null) return <p className="px-2 py-1 text-xs text-text-muted">{t('loading')}</p>;
    if (runs.length === 0) return <p className="px-2 py-1 text-xs text-text-muted">{t('empty')}</p>;

    return (
        <div className="space-y-1 px-2 py-1" data-testid="fleet-schedule-history">
            <p className="text-xs text-text-muted dark:text-text-muted-dark">
                {t('title', { computer })}
            </p>
            <ul className="space-y-1">
                {runs.map((run) => {
                    const fire = twoZoneTime(
                        run.scheduledFor ?? run.startedAt,
                        schedule.nodeTimeZone,
                        viewerZone,
                    );
                    const skip = runSkipText(run, computer);
                    const hasOutput = run.outputHead.length > 0 || run.outputTail.length > 0;
                    return (
                        <li key={run.id} className="text-xs" data-testid="fleet-schedule-run">
                            <span className="font-mono">{runGlyph(run.status)}</span>{' '}
                            {fire
                                ? fire.viewer
                                    ? t('twoZones', {
                                          computer: fire.computer,
                                          viewer: fire.viewer,
                                      })
                                    : fire.computer
                                : '—'}
                            {run.scheduledFor === null ? ` · ${t('runNow')}` : ''}
                            {skip ? (
                                <span className="text-text-muted"> — {skip}</span>
                            ) : (
                                <>
                                    {' · '}
                                    {formatRunDuration(run.durationMs)}
                                    {' · '}
                                    {run.status === 'running'
                                        ? t('running')
                                        : run.status === 'timeout'
                                          ? t('timeout')
                                          : run.failedReason
                                            ? t('failedReason', { reason: run.failedReason })
                                            : t('exit', { code: run.exitCode ?? '—' })}
                                    {hasOutput ? (
                                        <button
                                            type="button"
                                            className="ml-2 underline"
                                            onClick={() => setOpen(open === run.id ? null : run.id)}
                                        >
                                            {t('output')}
                                        </button>
                                    ) : null}
                                    {run.hasFullOutput && schedule.linkUp ? (
                                        <button
                                            type="button"
                                            className="ml-2 underline"
                                            onClick={() => void download(run)}
                                        >
                                            {t('fullOutput')}
                                        </button>
                                    ) : null}
                                </>
                            )}
                            {open === run.id ? (
                                <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-surface-secondary p-2 font-mono text-[11px] dark:bg-surface-secondary-dark">
                                    {run.outputHead}
                                    {run.truncated ? `\n… ${t('truncated')} …\n` : ''}
                                    {run.outputTail}
                                </pre>
                            ) : null}
                        </li>
                    );
                })}
            </ul>
        </div>
    );
}
