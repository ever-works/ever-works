'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle, Download, FileText, RefreshCw, UploadCloud } from 'lucide-react';
import type { KbUploadDto } from '@ever-works/contracts';
import { cn } from '@/lib/utils/cn';
import { KbUploadError, listKbUploads, retryKbUploadExtraction } from '@/lib/kb/kb-uploads';

/**
 * The workbench "Originals" tab — the uploaded FILES behind the KB, as
 * opposed to the extracted markdown documents shown on the "KB" tab.
 *
 * This replaces a hardcoded placeholder. Uploads had been storing and
 * extracting correctly since Phase 1B; what was missing was purely a way
 * to SEE them — the Next.js proxy for `GET /kb/uploads` only exported
 * `POST`, so any client listing attempt 404'd. With the proxy in place
 * this panel is a thin read view over the same endpoint.
 *
 * Why the extraction status is surfaced per row rather than hidden:
 * "uploaded" and "usable by the agent" are different states. A PDF whose
 * extraction FAILED is stored but contributes nothing to retrieval, and
 * before this tab existed there was no way to discover that — the file
 * simply never appeared as a document. Failed rows therefore carry the
 * reason and a Retry action, which is the one recovery path the API has
 * always had and the browser could never reach.
 */

interface KbOriginalsPanelProps {
    readonly workId: string;
    /** Bumped by the parent after an upload settles, to refetch. */
    readonly refreshToken?: number;
}

type Status = KbUploadDto['extractionStatus'];

export function KbOriginalsPanel({ workId, refreshToken = 0 }: KbOriginalsPanelProps) {
    const t = useTranslations('dashboard.workDetail.kb.workbench.originals');
    const [items, setItems] = useState<KbUploadDto[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [retryingId, setRetryingId] = useState<string | null>(null);

    useEffect(() => {
        const controller = new AbortController();
        let alive = true;
        setLoading(true);
        setError(null);
        listKbUploads(workId, { signal: controller.signal })
            .then((res) => {
                if (!alive) return;
                setItems(res.items);
            })
            .catch((err: unknown) => {
                if (!alive || controller.signal.aborted) return;
                setError(err instanceof KbUploadError ? err.message : t('error'));
            })
            .finally(() => {
                if (alive) setLoading(false);
            });
        return () => {
            alive = false;
            controller.abort();
        };
    }, [workId, refreshToken, t]);

    const onRetry = useCallback(
        async (uploadId: string) => {
            setRetryingId(uploadId);
            try {
                const res = await retryKbUploadExtraction(workId, uploadId);
                // Swap the single row rather than refetching the list: the
                // response already carries the authoritative post-retry row.
                setItems((prev) => prev.map((u) => (u.id === uploadId ? res.upload : u)));
            } catch (err: unknown) {
                setError(err instanceof KbUploadError ? err.message : t('error'));
            } finally {
                setRetryingId(null);
            }
        },
        [workId, t],
    );

    if (loading) {
        return <PanelNote testId="kb-workbench-originals-loading" message={t('loading')} />;
    }
    if (error) {
        return <PanelNote testId="kb-workbench-originals-error" message={error} tone="error" />;
    }
    if (items.length === 0) {
        return <PanelNote testId="kb-workbench-originals-empty" message={t('empty')} />;
    }

    return (
        <ul data-testid="kb-workbench-originals-list" className="flex flex-col gap-1">
            {items.map((upload) => (
                <li
                    key={upload.id}
                    data-testid="kb-workbench-originals-row"
                    className={cn(
                        'flex flex-col gap-1 rounded-md border border-border px-2.5 py-2',
                        'dark:border-border-dark',
                    )}
                >
                    <div className="flex items-center gap-2">
                        <FileText
                            className="h-3.5 w-3.5 shrink-0 text-text-muted dark:text-text-muted-dark/70"
                            aria-hidden="true"
                        />
                        <span
                            className="truncate text-xs font-medium text-text dark:text-text-dark"
                            title={upload.originalFilename}
                        >
                            {upload.originalFilename}
                        </span>
                        <StatusChip
                            status={upload.extractionStatus}
                            label={t(`status.${upload.extractionStatus}`)}
                        />
                    </div>

                    {upload.extractionStatus === 'failed' && upload.extractionError ? (
                        <p className="flex items-start gap-1 text-[11px] text-red-600 dark:text-red-400">
                            <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
                            <span className="break-words">{upload.extractionError}</span>
                        </p>
                    ) : null}

                    <div className="flex items-center gap-3 text-[11px]">
                        <a
                            href={`/api/works/${workId}/kb/uploads/${upload.id}/download`}
                            className="inline-flex items-center gap-1 text-text-muted hover:underline dark:text-text-muted-dark/70"
                        >
                            <Download className="h-3 w-3" aria-hidden="true" />
                            {t('download')}
                        </a>
                        {upload.extractionStatus === 'failed' ? (
                            <button
                                type="button"
                                data-testid="kb-workbench-originals-retry"
                                onClick={() => onRetry(upload.id)}
                                disabled={retryingId === upload.id}
                                className={cn(
                                    'inline-flex items-center gap-1 text-primary hover:underline',
                                    'disabled:cursor-not-allowed disabled:opacity-60',
                                )}
                            >
                                <RefreshCw
                                    className={cn(
                                        'h-3 w-3',
                                        retryingId === upload.id && 'animate-spin',
                                    )}
                                    aria-hidden="true"
                                />
                                {retryingId === upload.id ? t('retrying') : t('retry')}
                            </button>
                        ) : null}
                    </div>
                </li>
            ))}
        </ul>
    );
}

function StatusChip({ status, label }: { status: Status; label: string }) {
    const tone =
        status === 'succeeded'
            ? 'bg-green-500/10 text-green-700 dark:text-green-400'
            : status === 'failed'
              ? 'bg-red-500/10 text-red-700 dark:text-red-400'
              : status === 'running' || status === 'pending'
                ? 'bg-amber-500/10 text-amber-700 dark:text-amber-400'
                : 'bg-card-hover text-text-muted dark:bg-card-primary-dark/40 dark:text-text-muted-dark/70';
    return (
        <span
            className={cn('ml-auto shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium', tone)}
        >
            {label}
        </span>
    );
}

function PanelNote({ testId, message, tone }: { testId: string; message: string; tone?: 'error' }) {
    return (
        <div
            data-testid={testId}
            className={cn(
                'flex flex-col items-center justify-center gap-2 rounded-md border border-dashed',
                'border-border px-4 py-6 text-center text-xs',
                tone === 'error'
                    ? 'text-red-600 dark:text-red-400'
                    : 'text-text-muted dark:text-text-muted-dark/60',
                'dark:border-border-dark',
            )}
        >
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-card-hover dark:bg-card-primary-dark/40">
                <UploadCloud className="h-4 w-4" aria-hidden="true" />
            </span>
            <p>{message}</p>
        </div>
    );
}
