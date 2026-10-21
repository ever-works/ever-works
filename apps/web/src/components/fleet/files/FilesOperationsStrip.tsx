'use client';

import { useTranslations } from 'next-intl';
import { X } from 'lucide-react';
import type { FleetFilesOperationView } from '@ever-works/contracts';
import { formatFileBytes, operationNotice } from './files.shared';

/** An upload this tab is sending right now (the browser knows its progress first-hand). */
export interface LocalUpload {
    id: string;
    label: string;
    loaded: number;
    total: number;
    startedAt: number;
    state: 'running' | 'done' | 'failed' | 'cancelled';
    message?: string;
    cancel(): void;
}

/**
 * Files on computers (FL-11, FR-14, FR-42, spec §5.6) — the Operations strip:
 * every transfer of this computer with its direction, percent, speed and
 * Cancel while it runs, and its end in one sentence ("Done — 1.2 GB in
 * 26 s", "Cancelled — 420 MB moved; nothing partial was left on build-02.",
 * "Interrupted — build-02 went offline after 900 MB."). State changes are
 * announced through a polite live region.
 */
export function FilesOperationsStrip({
    nodeName,
    transfers,
    uploads,
    onCancel,
}: {
    nodeName: string;
    transfers: readonly FleetFilesOperationView[];
    uploads: readonly LocalUpload[];
    onCancel(transfer: FleetFilesOperationView): void;
}) {
    const t = useTranslations('fleet.files.operations');
    if (transfers.length === 0 && uploads.length === 0) return null;

    const line = (view: FleetFilesOperationView): string => {
        const notice = operationNotice(view, nodeName);
        switch (notice.key) {
            case 'running':
                return notice.percent !== null
                    ? t('running', {
                          percent: notice.percent,
                          speed: formatFileBytes(view.bytesPerSec ?? 0),
                      })
                    : t('runningNoTotal', {
                          moved: formatFileBytes(view.bytes),
                          speed: formatFileBytes(view.bytesPerSec ?? 0),
                      });
            case 'done':
                return t('done', { size: formatFileBytes(notice.bytes), seconds: notice.seconds });
            case 'cancelled':
                return t('cancelled', { moved: formatFileBytes(notice.bytes), node: nodeName });
            case 'interrupted':
                return t('interrupted', { moved: formatFileBytes(notice.bytes), node: nodeName });
            default:
                return t('failed', { hint: notice.hint });
        }
    };

    return (
        <section
            aria-label={t('title')}
            className="rounded-xl border border-border dark:border-border-dark p-3 space-y-1 text-xs"
            data-testid="fleet-files-operations"
        >
            <h3 className="font-semibold text-text-muted dark:text-text-muted-dark uppercase tracking-wide">
                {t('title')}
            </h3>
            <ul aria-live="polite" className="space-y-1">
                {uploads.map((upload) => {
                    const percent =
                        upload.total > 0
                            ? Math.min(100, Math.floor((upload.loaded / upload.total) * 100))
                            : 0;
                    const seconds = Math.max(1, (Date.now() - upload.startedAt) / 1000);
                    return (
                        <li
                            key={upload.id}
                            className="flex items-center gap-2"
                            data-testid="fleet-files-upload-row"
                        >
                            <span className="min-w-0 flex-1 truncate text-text dark:text-text-dark">
                                {t('upload', { label: upload.label, node: nodeName })}
                            </span>
                            <span className="text-text-muted dark:text-text-muted-dark tabular-nums">
                                {upload.state === 'running'
                                    ? t('running', {
                                          percent,
                                          speed: formatFileBytes(upload.loaded / seconds),
                                      })
                                    : (upload.message ?? '')}
                            </span>
                            {upload.state === 'running' && (
                                <button
                                    type="button"
                                    onClick={upload.cancel}
                                    className="inline-flex items-center gap-1 text-danger hover:underline"
                                >
                                    <X className="w-3 h-3" aria-hidden="true" />
                                    {t('cancel')}
                                </button>
                            )}
                        </li>
                    );
                })}
                {transfers
                    .filter(
                        (view) =>
                            view.kind !== 'upload' ||
                            view.state !== 'running' ||
                            uploads.length === 0,
                    )
                    .map((view) => (
                        <li
                            key={view.id}
                            className="flex items-center gap-2"
                            data-testid="fleet-files-transfer-row"
                            data-state={view.state}
                        >
                            <span className="min-w-0 flex-1 truncate text-text dark:text-text-dark">
                                {view.kind === 'download'
                                    ? t('download', { label: view.label })
                                    : view.kind === 'copy'
                                      ? t('copy', {
                                            label: view.label,
                                            from: nodeName,
                                            to: view.peerNodeId ?? '',
                                        })
                                      : t('upload', { label: view.label, node: nodeName })}
                            </span>
                            <span className="text-text-muted dark:text-text-muted-dark tabular-nums">
                                {line(view)}
                            </span>
                            {view.state === 'running' && (
                                <button
                                    type="button"
                                    onClick={() => onCancel(view)}
                                    className="inline-flex items-center gap-1 text-danger hover:underline"
                                    data-testid="fleet-files-transfer-cancel"
                                >
                                    <X className="w-3 h-3" aria-hidden="true" />
                                    {t('cancel')}
                                </button>
                            )}
                        </li>
                    ))}
            </ul>
        </section>
    );
}
