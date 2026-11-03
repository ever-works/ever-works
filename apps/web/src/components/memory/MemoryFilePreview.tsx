'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Download, Loader2, X } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { pickKbViewer } from '@/components/works/detail/kb/viewers/pick-viewer';
import { KbPdfViewer } from '@/components/works/detail/kb/viewers/KbPdfViewer';
import { KbDocxViewer } from '@/components/works/detail/kb/viewers/KbDocxViewer';
import { KbXlsxViewer } from '@/components/works/detail/kb/viewers/KbXlsxViewer';
import { KbImageViewer } from '@/components/works/detail/kb/viewers/KbImageViewer';
import { KbVideoViewer } from '@/components/works/detail/kb/viewers/KbVideoViewer';
import { KbAudioViewer } from '@/components/works/detail/kb/viewers/KbAudioViewer';
import type { MemoryFileRow } from '@/lib/api/memory-files-types';

/**
 * Memory Files — inline preview of one row, reusing the KB viewers.
 *
 * The viewer choice comes from the SAME `pickKbViewer` helper the KB
 * workbench uses, so a MIME that previews in a Work's knowledge base
 * previews identically here. Binary viewers receive the Files download
 * URL (`/api/memory/files/:id/download?source=`) — they fetch it
 * themselves, which the route's `Content-Disposition: attachment` does
 * not affect (that header only steers top-level navigations).
 *
 * `pickKbViewer` returns `'text'` for markdown / plain / unknown MIMEs.
 * Unlike the KB (which stores a rendered body to show instead), Files
 * has only bytes, so this component fetches small text payloads itself
 * and renders them; anything else falls back to a download card.
 */

/** Text payloads above this are not fetched for inline display. */
const TEXT_PREVIEW_MAX_BYTES = 256 * 1024;

/** MIMEs `pickKbViewer` calls `'text'` that really are readable text. */
function isReadableText(mime: string | null): boolean {
    if (!mime) return false;
    const bare = mime.split(';')[0].trim().toLowerCase();
    return (
        bare.startsWith('text/') ||
        bare === 'application/json' ||
        bare === 'application/xml' ||
        bare === 'application/x-yaml'
    );
}

export interface MemoryFilePreviewProps {
    readonly row: MemoryFileRow;
    readonly onClose: () => void;
}

export function MemoryFilePreview({ row, onClose }: MemoryFilePreviewProps) {
    const t = useTranslations('dashboard.memoryPage.files');
    const url = `/api/memory/files/${encodeURIComponent(row.id)}/download?source=${row.source}`;
    const kind = pickKbViewer(row.mime);
    const sizeBytes = row.size ?? 0;

    const [text, setText] = useState<string | null>(null);
    const [textState, setTextState] = useState<'idle' | 'loading' | 'failed'>('idle');

    const wantsText =
        kind === 'text' && isReadableText(row.mime) && sizeBytes <= TEXT_PREVIEW_MAX_BYTES;

    useEffect(() => {
        if (!wantsText) return;
        let cancelled = false;
        setTextState('loading');
        void (async () => {
            try {
                const res = await fetch(url, { cache: 'no-store' });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const body = await res.text();
                if (cancelled) return;
                setText(body.slice(0, TEXT_PREVIEW_MAX_BYTES));
                setTextState('idle');
            } catch {
                if (!cancelled) setTextState('failed');
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [url, wantsText]);

    // Escape closes, matching the rest of the dashboard's overlays.
    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (event.key === 'Escape') onClose();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onClose]);

    return (
        <div
            data-testid="memory-files-preview"
            role="dialog"
            aria-modal="true"
            aria-label={t('previewTitle')}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
            onClick={onClose}
        >
            <div
                className={cn(
                    'flex max-h-[85vh] w-full max-w-3xl flex-col gap-3 overflow-hidden rounded-lg p-4',
                    'border border-card-border dark:border-white/9 bg-card dark:bg-card-primary-dark',
                )}
                onClick={(event) => event.stopPropagation()}
            >
                <div className="flex items-center justify-between gap-3">
                    <span
                        className="truncate text-sm font-semibold text-text dark:text-text-dark"
                        title={row.filename}
                    >
                        {row.filename}
                    </span>
                    <div className="flex shrink-0 items-center gap-2">
                        <a
                            href={url}
                            data-testid="memory-files-preview-download"
                            title={t('download')}
                            className="p-1 rounded text-text-muted dark:text-text-muted-dark hover:text-text dark:hover:text-text-dark transition-colors"
                        >
                            <Download className="w-4 h-4" strokeWidth={1.5} />
                        </a>
                        <button
                            type="button"
                            data-testid="memory-files-preview-close"
                            onClick={onClose}
                            aria-label={t('previewClose')}
                            className="p-1 rounded text-text-muted dark:text-text-muted-dark hover:text-text dark:hover:text-text-dark transition-colors"
                        >
                            <X className="w-4 h-4" strokeWidth={1.5} />
                        </button>
                    </div>
                </div>

                <div
                    className="overflow-auto"
                    data-testid="memory-files-preview-body"
                    data-viewer={kind}
                >
                    {kind === 'pdf' && (
                        <KbPdfViewer url={url} sizeBytes={sizeBytes} filename={row.filename} />
                    )}
                    {kind === 'docx' && (
                        <KbDocxViewer url={url} sizeBytes={sizeBytes} filename={row.filename} />
                    )}
                    {kind === 'xlsx' && (
                        <KbXlsxViewer url={url} sizeBytes={sizeBytes} filename={row.filename} />
                    )}
                    {kind === 'image' && (
                        <KbImageViewer url={url} sizeBytes={sizeBytes} filename={row.filename} />
                    )}
                    {kind === 'video' && (
                        <KbVideoViewer
                            url={url}
                            sizeBytes={sizeBytes}
                            filename={row.filename}
                            mimeType={row.mime ?? 'video/mp4'}
                        />
                    )}
                    {kind === 'audio' && (
                        <KbAudioViewer
                            url={url}
                            sizeBytes={sizeBytes}
                            filename={row.filename}
                            mimeType={row.mime ?? 'audio/mpeg'}
                        />
                    )}
                    {kind === 'text' &&
                        (textState === 'loading' ? (
                            <div className="flex items-center gap-2 py-6 text-xs text-text-muted dark:text-text-muted-dark">
                                <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={1.5} />
                            </div>
                        ) : wantsText && textState !== 'failed' ? (
                            <pre
                                data-testid="memory-files-preview-text"
                                className="whitespace-pre-wrap break-words rounded border border-card-border dark:border-white/9 p-3 text-xs text-text dark:text-text-dark"
                            >
                                {text ?? ''}
                            </pre>
                        ) : (
                            <p
                                data-testid="memory-files-preview-unsupported"
                                className="py-6 text-center text-xs text-text-muted dark:text-text-muted-dark"
                            >
                                {textState === 'failed'
                                    ? t('previewFailed')
                                    : t('previewUnsupported')}
                            </p>
                        ))}
                </div>
            </div>
        </div>
    );
}
