'use client';

import dynamic from 'next/dynamic';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils/cn';
import { Button } from '@/components/ui/button';
import { formatBytes } from './KbPdfViewer';

/**
 * Spec §14.5 — DOCX shares the 30 MiB inline cap with PDF. Anything
 * larger renders as a download fallback instead of converting on the
 * client (a 100 MiB DOCX would block the main thread for seconds).
 */
export const KB_DOCX_INLINE_MAX_BYTES = 30 * 1024 * 1024;

const KbDocxViewerCanvas = dynamic(
    () =>
        import('./KbDocxViewerCanvas').then((m) => ({
            default: m.KbDocxViewerCanvas,
        })),
    { ssr: false },
);

interface KbDocxViewerProps {
    /** Pre-signed URL to the DOCX bytes in storage. */
    url: string;
    /** File size in bytes (drives the inline-vs-download decision). */
    sizeBytes: number;
    /** Original filename for the download anchor + iframe title. */
    filename: string;
    /**
     * Test seam — override the cap so the fallback path is
     * exercisable without 30 MiB of fake bytes. Production code
     * leaves it at the default.
     */
    maxInlineBytes?: number;
}

/**
 * EW-641 Phase 1B/d row 10 — DOCX read-only viewer.
 *
 * Mirrors the row 9 PDF viewer's size-cap pattern:
 *  - `sizeBytes <= maxInlineBytes` (default 30 MiB per spec §14.5):
 *    lazy-loads `KbDocxViewerCanvas` via `next/dynamic`. The canvas
 *    fetches the DOCX, runs it through `mammoth/mammoth.browser`,
 *    sanitises the resulting HTML, and renders inline.
 *  - `sizeBytes > maxInlineBytes`: download-fallback card with a
 *    direct `<a download>` anchor — operator clicks → browser saves.
 *
 * Selectors locked for Playwright A14 (one acceptance covers PDF +
 * DOCX size caps together):
 *  - `data-testid="kb-docx-viewer"` (root) + `data-mode={"inline"|"download"}`
 *    + `data-size-bytes`
 *  - `data-testid="kb-docx-download-fallback"` (over-cap card)
 *  - `data-testid="kb-docx-download-link"` (download anchor)
 *  - canvas-side selectors live in `KbDocxViewerCanvas.tsx`.
 */
export function KbDocxViewer({
    url,
    sizeBytes,
    filename,
    maxInlineBytes = KB_DOCX_INLINE_MAX_BYTES,
}: KbDocxViewerProps) {
    const t = useTranslations('dashboard.workDetail.kb.docx');
    const overCap = sizeBytes > maxInlineBytes;

    return (
        <section
            data-testid="kb-docx-viewer"
            data-mode={overCap ? 'download' : 'inline'}
            data-size-bytes={sizeBytes}
            aria-label={t('label')}
            className="flex flex-col gap-2"
        >
            {overCap ? (
                <KbDocxDownloadFallback
                    url={url}
                    filename={filename}
                    sizeLabel={formatBytes(sizeBytes)}
                    capLabel={formatBytes(maxInlineBytes)}
                    title={t('tooLargeTitle')}
                    body={t('tooLargeBody', {
                        size: formatBytes(sizeBytes),
                        cap: formatBytes(maxInlineBytes),
                    })}
                    download={t('download')}
                />
            ) : (
                <KbDocxViewerCanvas url={url} filename={filename} />
            )}
        </section>
    );
}

interface KbDocxDownloadFallbackProps {
    url: string;
    filename: string;
    sizeLabel: string;
    capLabel: string;
    title: string;
    body: string;
    download: string;
}

function KbDocxDownloadFallback({
    url,
    filename,
    sizeLabel,
    capLabel,
    title,
    body,
    download,
}: KbDocxDownloadFallbackProps) {
    return (
        <div
            data-testid="kb-docx-download-fallback"
            data-size-label={sizeLabel}
            data-cap-label={capLabel}
            className={cn(
                'flex flex-col gap-2 rounded-md border border-dashed p-4 text-center',
                'border-border bg-card/30 dark:border-border-dark dark:bg-card-primary-dark/20',
            )}
        >
            <p className="text-sm font-medium text-text dark:text-text-dark">{title}</p>
            <p className="text-xs text-text-muted dark:text-text-muted-dark/70">{body}</p>
            <div>
                <Button asChild type="button" size="sm" variant="secondary">
                    <a
                        data-testid="kb-docx-download-link"
                        href={url}
                        download={filename}
                        rel="noopener noreferrer"
                    >
                        {download} ({sizeLabel})
                    </a>
                </Button>
            </div>
        </div>
    );
}
