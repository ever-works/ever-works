'use client';

import dynamic from 'next/dynamic';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils/cn';
import { Button } from '@/components/ui/button';

/**
 * Spec §14.5 (inline-viewer size thresholds): PDFs above 30 MiB
 * render as a download fallback instead of the inline canvas. The
 * threshold is exposed as a prop so tests don't have to allocate
 * 30 MiB Files / strings.
 */
export const KB_PDF_INLINE_MAX_BYTES = 30 * 1024 * 1024;

const KbPdfViewerCanvas = dynamic(
    () =>
        import('./KbPdfViewerCanvas').then((m) => ({
            default: m.KbPdfViewerCanvas,
        })),
    { ssr: false },
);

interface KbPdfViewerProps {
    /** Pre-signed URL pointing at the PDF bytes in storage. */
    url: string;
    /** File size in bytes (drives the inline-vs-download decision). */
    sizeBytes: number;
    /** Original filename — used in the download fallback + iframe title. */
    filename: string;
    /**
     * Override the inline cap (defaults to {@link KB_PDF_INLINE_MAX_BYTES}).
     * Tests use a smaller value so the fallback path is exercisable
     * without allocating 30 MiB; product code leaves it default.
     */
    maxInlineBytes?: number;
}

/**
 * EW-641 Phase 1B/d row 9 — PDF inline viewer for Knowledge Base
 * uploads.
 *
 * Decides between two presentations:
 *  - `sizeBytes <= maxInlineBytes` (default 30 MiB per spec §14.5):
 *    lazy-loads {@link KbPdfViewerCanvas} via `next/dynamic` so the
 *    PDF surface only ships when actually needed. Renders inside the
 *    Workbench editor pane.
 *  - `sizeBytes > maxInlineBytes`: renders a download-fallback card
 *    with a direct link (operator clicks → browser saves; never
 *    streams 100 MiB through the React tree).
 *
 * Selectors locked for Playwright A14 (PDF render + size-cap):
 *  - `data-testid="kb-pdf-viewer"` (root) + `data-mode` attribute
 *    that is either `inline` or `download` so the e2e assertion is
 *    a single selector check.
 *  - `data-testid="kb-pdf-download-fallback"` (fallback wrapper)
 *  - `data-testid="kb-pdf-download-link"` (the download anchor)
 *  - `data-testid="kb-pdf-iframe"` (inline canvas — lives in the
 *    lazy-loaded `KbPdfViewerCanvas`).
 */
export function KbPdfViewer({
    url,
    sizeBytes,
    filename,
    maxInlineBytes = KB_PDF_INLINE_MAX_BYTES,
}: KbPdfViewerProps) {
    const t = useTranslations('dashboard.workDetail.kb.pdf');
    const overCap = sizeBytes > maxInlineBytes;

    return (
        <section
            data-testid="kb-pdf-viewer"
            data-mode={overCap ? 'download' : 'inline'}
            data-size-bytes={sizeBytes}
            aria-label={t('label')}
            className="flex flex-col gap-2"
        >
            {overCap ? (
                <KbPdfDownloadFallback
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
                <KbPdfViewerCanvas url={url} title={filename} />
            )}
        </section>
    );
}

interface KbPdfDownloadFallbackProps {
    url: string;
    filename: string;
    sizeLabel: string;
    capLabel: string;
    title: string;
    body: string;
    download: string;
}

function KbPdfDownloadFallback({
    url,
    filename,
    sizeLabel,
    capLabel,
    title,
    body,
    download,
}: KbPdfDownloadFallbackProps) {
    return (
        <div
            data-testid="kb-pdf-download-fallback"
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
                        data-testid="kb-pdf-download-link"
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

/**
 * Pretty-prints byte counts as `12.3 MB`. Matches the convention used
 * by the items-import progress component (`Math.round * 10 / 10`),
 * with `Bytes` / `KB` / `MB` / `GB` units. Stays inside ASCII so the
 * Playwright `expect(text).toContain('30 MB')` assertion is stable.
 */
export function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round((bytes / 1024) * 10) / 10} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
    return `${Math.round((bytes / (1024 * 1024 * 1024)) * 10) / 10} GB`;
}
