'use client';

import type { KbDocumentDto } from '@ever-works/contracts';
import { KbPdfViewer } from '@/components/works/detail/kb/viewers/KbPdfViewer';
import { KbDocxViewer } from '@/components/works/detail/kb/viewers/KbDocxViewer';
import { KbXlsxViewer } from '@/components/works/detail/kb/viewers/KbXlsxViewer';
import { KbImageViewer } from '@/components/works/detail/kb/viewers/KbImageViewer';
import { KbVideoViewer } from '@/components/works/detail/kb/viewers/KbVideoViewer';
import { KbAudioViewer } from '@/components/works/detail/kb/viewers/KbAudioViewer';
import { SizeThresholdGate } from './SizeThresholdGate';
import { UnsupportedFormatBanner } from './UnsupportedFormatBanner';

/**
 * EW-641 slice D — workbench viewer dispatcher.
 *
 * The route catch-all page (`[locale]/(dashboard)/works/[id]/kb/[...path]/page.tsx`)
 * branches on the doc's `mimeType` field; for any non-Markdown value
 * it hands the doc + upload metadata off to this component which
 * mounts the matching inline viewer.
 *
 * Why a thin switch component and not inline logic in the route:
 *  - The route is a React Server Component; the viewers all need
 *    `'use client'` because they touch the DOM. Wrapping them in a
 *    single client switch keeps the page server-rendered AND avoids
 *    forcing every individual viewer mount to be its own client
 *    boundary in the tree.
 *  - Keeps the route file short — page concerns (fetch + 404) stay
 *    separate from per-MIME UI choices.
 *  - Slice E can add a 7th viewer (e.g. a CAD preview) by editing
 *    this switch in one place.
 *
 * Branch table (matches the existing `pickKbViewer` helper but extends
 * with PPTX, CSV/TSV, and embedded HTML — slice D's scope):
 *   text/markdown | null         → render `null` (caller mounts editor)
 *   application/pdf              → `<KbPdfViewer>`
 *   …wordprocessingml.document   → `<KbDocxViewer>`
 *   …spreadsheetml.sheet | …macroEnabled.12 | text/csv | text/tab-separated-values
 *                                → `<KbXlsxViewer>` (CSV/TSV render via
 *                                  the sheet viewer because exceljs accepts
 *                                  them as flat workbooks; the size gate
 *                                  still applies)
 *   …presentationml.presentation → `<UnsupportedFormatBanner>` for now
 *                                  (no PPTX viewer ships in this slice —
 *                                  graceful download fallback)
 *   image/*                      → `<KbImageViewer>`
 *   video/*                      → `<KbVideoViewer>`
 *   audio/*                      → `<KbAudioViewer>`
 *   text/html                    → `<UnsupportedFormatBanner>` (an inline
 *                                  iframe sandbox lands in slice E)
 *   anything else                → `<UnsupportedFormatBanner>`
 *
 * Each non-null branch is wrapped in `<SizeThresholdGate>` so the
 * operator-side per-MIME caps apply before the viewer's own size
 * decision runs.
 */

const PDF_MIME = 'application/pdf';
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const XLSM_MIME = 'application/vnd.ms-excel.sheet.macroEnabled.12';
const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const CSV_MIME = 'text/csv';
const TSV_MIME = 'text/tab-separated-values';
const HTML_MIME = 'text/html';

export interface KbDocumentViewerSwitchProps {
    workId: string;
    document: KbDocumentDto;
    /**
     * Upload-row carry. The caller (the route page) fetches the
     * `KbUploadDto` when `doc.sourceUploadId` is set and forwards
     * the bits we need. Keeping these as plain props (instead of
     * the full DTO) means the switch doesn't have to know about
     * `KbUploadDto` and stays usable in tests with a fake doc.
     */
    mimeType?: string;
    fileSize?: number;
    filename?: string;
    /**
     * Direct download URL — the row-21a proxy. When the gate
     * blocks the viewer or the unsupported branch fires, this is
     * the link surfaced on the banner. The route page builds it.
     */
    downloadUrl?: string;
}

export function KbDocumentViewerSwitch({
    document,
    mimeType,
    fileSize,
    filename,
    downloadUrl,
}: KbDocumentViewerSwitchProps) {
    // The route page is responsible for ONLY mounting the switch for
    // non-Markdown docs, but we re-check here so a stray render
    // (e.g. a tree-row prefetch race) doesn't show the unsupported
    // banner over a perfectly good markdown body.
    const bare = (mimeType ?? '').split(';')[0].trim().toLowerCase();
    if (bare.length === 0 || bare === 'text/markdown' || bare === 'text/plain') {
        return null;
    }

    const resolvedFilename = filename ?? document.title ?? document.path;
    const url = downloadUrl ?? '';

    const gateProps = {
        fileSize,
        mimeType: bare,
        downloadUrl: url,
        filename: resolvedFilename,
    };

    if (bare === PDF_MIME) {
        return (
            <SizeThresholdGate {...gateProps}>
                <KbPdfViewer url={url} sizeBytes={fileSize ?? 0} filename={resolvedFilename} />
            </SizeThresholdGate>
        );
    }
    if (bare === DOCX_MIME) {
        return (
            <SizeThresholdGate {...gateProps}>
                <KbDocxViewer url={url} sizeBytes={fileSize ?? 0} filename={resolvedFilename} />
            </SizeThresholdGate>
        );
    }
    if (bare === XLSX_MIME || bare === XLSM_MIME || bare === CSV_MIME || bare === TSV_MIME) {
        return (
            <SizeThresholdGate {...gateProps}>
                <KbXlsxViewer url={url} sizeBytes={fileSize ?? 0} filename={resolvedFilename} />
            </SizeThresholdGate>
        );
    }
    if (bare === PPTX_MIME) {
        // PPTX viewer is not in this slice; render a graceful
        // "preview unavailable" banner that still surfaces the
        // download link.
        return (
            <SizeThresholdGate {...gateProps}>
                <UnsupportedFormatBanner
                    mimeType={bare}
                    filename={resolvedFilename}
                    downloadUrl={url}
                />
            </SizeThresholdGate>
        );
    }
    if (bare.startsWith('image/')) {
        return (
            <SizeThresholdGate {...gateProps}>
                <KbImageViewer url={url} sizeBytes={fileSize ?? 0} filename={resolvedFilename} />
            </SizeThresholdGate>
        );
    }
    if (bare.startsWith('video/')) {
        return (
            <SizeThresholdGate {...gateProps}>
                <KbVideoViewer
                    url={url}
                    sizeBytes={fileSize ?? 0}
                    filename={resolvedFilename}
                    mimeType={bare}
                />
            </SizeThresholdGate>
        );
    }
    if (bare.startsWith('audio/')) {
        return (
            <SizeThresholdGate {...gateProps}>
                <KbAudioViewer
                    url={url}
                    sizeBytes={fileSize ?? 0}
                    filename={resolvedFilename}
                    mimeType={bare}
                />
            </SizeThresholdGate>
        );
    }
    if (bare === HTML_MIME) {
        // Embedded HTML rendering needs a sandboxed iframe surface
        // we don't have yet; fall back to the unsupported banner.
        return (
            <SizeThresholdGate {...gateProps}>
                <UnsupportedFormatBanner
                    mimeType={bare}
                    filename={resolvedFilename}
                    downloadUrl={url}
                />
            </SizeThresholdGate>
        );
    }

    return (
        <UnsupportedFormatBanner mimeType={bare} filename={resolvedFilename} downloadUrl={url} />
    );
}
