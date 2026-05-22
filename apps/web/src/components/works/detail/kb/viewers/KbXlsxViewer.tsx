'use client';

import dynamic from 'next/dynamic';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils/cn';
import { Button } from '@/components/ui/button';
import { formatBytes } from './KbPdfViewer';

/**
 * Spec §14.5 — XLSX uses a tighter 5 MiB inline cap because parsing
 * a workbook on the main thread costs more wall-clock time than
 * iframe-rendering a PDF or HTML-converting a DOCX. Anything larger
 * renders as a download fallback so the operator doesn't watch the
 * Workbench freeze for 5+ seconds.
 */
export const KB_XLSX_INLINE_MAX_BYTES = 5 * 1024 * 1024;

const KbXlsxViewerCanvas = dynamic(
    () =>
        import('./KbXlsxViewerCanvas').then((m) => ({
            default: m.KbXlsxViewerCanvas,
        })),
    { ssr: false },
);

interface KbXlsxViewerProps {
    /** Pre-signed URL to the XLSX bytes in storage. */
    url: string;
    /** File size in bytes — drives the inline-vs-download decision. */
    sizeBytes: number;
    /** Original filename for the download anchor + iframe title. */
    filename: string;
    /**
     * Override the inline cap (defaults to {@link KB_XLSX_INLINE_MAX_BYTES}).
     * Tests use a smaller value so the fallback path is exercisable
     * without a 5 MiB fake file.
     */
    maxInlineBytes?: number;
}

/**
 * EW-641 Phase 1B/d row 11 — XLSX grid viewer.
 *
 * Mirrors the row 9 PDF + row 10 DOCX viewers' size-cap pattern:
 *  - `sizeBytes <= maxInlineBytes` (5 MiB default per spec §14.5):
 *    lazy-loads `KbXlsxViewerCanvas` via `next/dynamic`. The canvas
 *    fetches the workbook, runs `exceljs.xlsx.load(arrayBuffer)`,
 *    and renders the active sheet as a sortable `<table>`. Sheet
 *    tabs let the operator switch between worksheets.
 *  - `sizeBytes > maxInlineBytes`: download-fallback card with a
 *    direct `<a download>` anchor.
 *
 * Selectors locked for Playwright A14 (one acceptance covers all
 * three viewer size caps):
 *  - `data-testid="kb-xlsx-viewer"` (root) + `data-mode={"inline"|"download"}`
 *    + `data-size-bytes`
 *  - `data-testid="kb-xlsx-download-fallback"` (over-cap card)
 *  - `data-testid="kb-xlsx-download-link"` (download anchor)
 *  - canvas-side selectors live in `KbXlsxViewerCanvas.tsx`.
 */
export function KbXlsxViewer({
    url,
    sizeBytes,
    filename,
    maxInlineBytes = KB_XLSX_INLINE_MAX_BYTES,
}: KbXlsxViewerProps) {
    const t = useTranslations('dashboard.workDetail.kb.xlsx');
    const overCap = sizeBytes > maxInlineBytes;

    return (
        <section
            data-testid="kb-xlsx-viewer"
            data-mode={overCap ? 'download' : 'inline'}
            data-size-bytes={sizeBytes}
            aria-label={t('label')}
            className="flex flex-col gap-2"
        >
            {overCap ? (
                <KbXlsxDownloadFallback
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
                <KbXlsxViewerCanvas url={url} filename={filename} />
            )}
        </section>
    );
}

interface KbXlsxDownloadFallbackProps {
    url: string;
    filename: string;
    sizeLabel: string;
    capLabel: string;
    title: string;
    body: string;
    download: string;
}

function KbXlsxDownloadFallback({
    url,
    filename,
    sizeLabel,
    capLabel,
    title,
    body,
    download,
}: KbXlsxDownloadFallbackProps) {
    return (
        <div
            data-testid="kb-xlsx-download-fallback"
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
                        data-testid="kb-xlsx-download-link"
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
