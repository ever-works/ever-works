'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils/cn';
import { CheckCircle2, Loader2, XCircle } from 'lucide-react';

/**
 * EW-641 slice C — bottom-of-screen upload progress toast stack.
 *
 * The workbench upload coordinator passes the live list of in-flight,
 * completed, and failed uploads down. We render a small fixed-position
 * stack with one row per entry, each carrying a progress bar (for
 * `uploading`) or a status icon (`done` / `failed`).
 *
 * Auto-dismissal of `done` entries is handled by the parent — this
 * component just consumes the list. (Done so the parent can also clear
 * entries on user interaction, e.g. "Hide" button.)
 */

export type UploadProgressStatus = 'uploading' | 'done' | 'failed';

export interface UploadEntry {
    readonly id: string;
    readonly filename: string;
    readonly bytesUploaded: number;
    readonly bytesTotal: number;
    readonly status: UploadProgressStatus;
    readonly error?: string;
}

export interface UploadProgressProps {
    readonly uploads: readonly UploadEntry[];
    /**
     * Optional auto-dismiss hook — when set, the component calls this
     * for every entry that has been `done` for at least `dismissMs`.
     * The parent typically wires it to a state setter that filters the
     * entry out.
     */
    readonly onAutoDismiss?: (entryId: string) => void;
    /** Defaults to 3000 ms (slice C spec). */
    readonly dismissMs?: number;
}

function pct(entry: UploadEntry): number {
    if (entry.status === 'done') return 100;
    if (entry.status === 'failed') return 100;
    if (entry.bytesTotal <= 0) return 0;
    return Math.min(100, Math.round((entry.bytesUploaded / entry.bytesTotal) * 100));
}

export function UploadProgress({ uploads, onAutoDismiss, dismissMs = 3000 }: UploadProgressProps) {
    const t = useTranslations('dashboard.workDetail.kb.workbench.upload');
    const [, force] = useState(0);

    useEffect(() => {
        if (!onAutoDismiss) return;
        const timers: ReturnType<typeof setTimeout>[] = [];
        for (const entry of uploads) {
            if (entry.status === 'done') {
                timers.push(
                    setTimeout(() => {
                        onAutoDismiss(entry.id);
                        force((x) => x + 1);
                    }, dismissMs),
                );
            }
        }
        return () => {
            for (const t of timers) clearTimeout(t);
        };
    }, [uploads, onAutoDismiss, dismissMs]);

    if (uploads.length === 0) return null;

    return (
        <div
            data-testid="kb-workbench-upload-progress"
            aria-live="polite"
            className={cn(
                'pointer-events-none fixed bottom-4 right-4 z-40 flex flex-col gap-2',
                'w-80 max-w-full',
            )}
        >
            {uploads.map((entry) => (
                <div
                    key={entry.id}
                    data-testid={`kb-workbench-upload-progress-row-${entry.id}`}
                    data-status={entry.status}
                    className={cn(
                        'pointer-events-auto rounded-md border bg-surface p-3 shadow-md',
                        'dark:bg-surface-dark',
                        entry.status === 'failed'
                            ? 'border-red-500/50 dark:border-red-500/40'
                            : 'border-border dark:border-border-dark',
                    )}
                >
                    <div className="flex items-center gap-2">
                        {entry.status === 'uploading' ? (
                            <Loader2
                                className="h-4 w-4 shrink-0 animate-spin text-primary"
                                aria-hidden="true"
                            />
                        ) : entry.status === 'done' ? (
                            <CheckCircle2
                                className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400"
                                aria-hidden="true"
                            />
                        ) : (
                            <XCircle
                                className="h-4 w-4 shrink-0 text-red-600 dark:text-red-400"
                                aria-hidden="true"
                            />
                        )}
                        <span className="truncate text-xs font-medium text-text dark:text-text-dark">
                            {entry.filename}
                        </span>
                        <span className="ml-auto text-[10px] uppercase tracking-wider text-text-muted dark:text-text-muted-dark/70">
                            {entry.status === 'uploading'
                                ? t('progress.uploading')
                                : entry.status === 'done'
                                  ? t('progress.done')
                                  : t('progress.failed')}
                        </span>
                    </div>
                    {entry.status === 'uploading' ? (
                        <div
                            data-testid={`kb-workbench-upload-progress-bar-${entry.id}`}
                            className="mt-2 h-1 w-full overflow-hidden rounded-full bg-card-hover dark:bg-card-primary-dark/40"
                        >
                            <div
                                className="h-full bg-primary transition-all"
                                style={{ width: `${pct(entry)}%` }}
                                data-pct={pct(entry)}
                            />
                        </div>
                    ) : null}
                    {entry.status === 'failed' && entry.error ? (
                        <p className="mt-1 text-[11px] text-red-600 dark:text-red-400">
                            {entry.error}
                        </p>
                    ) : null}
                </div>
            ))}
        </div>
    );
}
