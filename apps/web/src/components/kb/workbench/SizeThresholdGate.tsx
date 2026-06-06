'use client';

import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils/cn';
import { Button } from '@/components/ui/button';
import { formatBytes } from '@/components/works/detail/kb/viewers/KbPdfViewer';

/**
 * EW-641 slice D — per-format size gate that sits between the
 * workbench viewer dispatcher (`KbDocumentViewerSwitch`) and the
 * actual viewer component.
 *
 * Why a wrapper instead of overriding each viewer's `maxInlineBytes`
 * prop: the individual viewers (`KbPdfViewer`, `KbDocxViewer`, etc.)
 * already enforce their own caps for the public-facing detail page,
 * but slice D's spec calls for a SECOND tier of per-MIME caps that
 * apply to the OPERATOR workbench (where downloading a 400 MiB PDF
 * over the React tree is unacceptable even if the public viewer
 * would inline it). We render the gate as the OUTER guard so it can
 * short-circuit BEFORE the dynamically-imported viewer canvas
 * payload is fetched, keeping the heavy `mammoth` / `exceljs` /
 * iframe code out of the network panel for over-cap docs.
 *
 * Threshold table (spec §14.5 + slice D extras):
 *  - PDF: 50 MiB
 *  - DOCX: 25 MiB
 *  - XLSX: 15 MiB
 *  - PPTX: 50 MiB
 *  - image/*: 10 MiB
 *  - video/*: 500 MiB
 *  - audio/*: 100 MiB
 *  - text/html (embedded HTML): 5 MiB
 *
 * Render path:
 *  - `fileSize === undefined` → render children. We don't know the
 *    size yet (e.g. doc detail page hasn't fetched the upload row);
 *    trust the underlying viewer to decide.
 *  - `fileSize > threshold[mimeType]` (or its `*` prefix) → render
 *    a download banner with the size + cap copy and an `<a download>`
 *    link to the supplied `downloadUrl`.
 *  - Otherwise → render children.
 *
 * Selectors locked:
 *  - `data-testid="kb-workbench-size-gate"` on the root span when
 *    the gate is in pass-through mode (so e2e can assert the gate
 *    was traversed without blocking).
 *  - `data-testid="kb-workbench-size-blocked"` on the download
 *    banner card when blocked.
 *  - `data-testid="kb-workbench-size-blocked-download"` on the
 *    anchor inside the banner.
 */

export const KB_WORKBENCH_SIZE_THRESHOLDS: Readonly<Record<string, number>> = {
    'application/pdf': 50 * 1024 * 1024,
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 25 * 1024 * 1024,
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 15 * 1024 * 1024,
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 50 * 1024 * 1024,
    'image/*': 10 * 1024 * 1024,
    'video/*': 500 * 1024 * 1024,
    'audio/*': 100 * 1024 * 1024,
    'text/html': 5 * 1024 * 1024,
};

export interface SizeThresholdGateProps {
    /** File size in bytes — when undefined the gate passes through. */
    fileSize?: number;
    /** MIME type — matched against the threshold table. */
    mimeType?: string;
    /**
     * Download URL surfaced on the "too large" banner. Caller is
     * expected to point this at the row-21a download proxy
     * (`/api/works/:id/kb/uploads/:uploadId/download`).
     */
    downloadUrl?: string;
    /** Optional filename for the `<a download="...">` attribute. */
    filename?: string;
    children: ReactNode;
}

/**
 * Match a MIME type against the threshold table. Tries an exact
 * match first, then the `image/*` / `video/*` / `audio/*` prefix
 * forms.
 */
export function resolveSizeThreshold(mimeType: string | undefined): number | undefined {
    if (!mimeType) return undefined;
    const bare = mimeType.split(';')[0].trim().toLowerCase();
    if (bare.length === 0) return undefined;
    const exact = KB_WORKBENCH_SIZE_THRESHOLDS[bare];
    if (typeof exact === 'number') return exact;
    const slashIdx = bare.indexOf('/');
    if (slashIdx <= 0) return undefined;
    const prefix = `${bare.slice(0, slashIdx)}/*`;
    return KB_WORKBENCH_SIZE_THRESHOLDS[prefix];
}

export function SizeThresholdGate({
    fileSize,
    mimeType,
    downloadUrl,
    filename,
    children,
}: SizeThresholdGateProps) {
    const t = useTranslations('dashboard.workDetail.kb.workbench.viewer.sizeBlocked');
    if (fileSize === undefined) {
        return (
            <span data-testid="kb-workbench-size-gate" data-mode="passthrough">
                {children}
            </span>
        );
    }
    const cap = resolveSizeThreshold(mimeType);
    if (cap === undefined || fileSize <= cap) {
        return (
            <span
                data-testid="kb-workbench-size-gate"
                data-mode="passthrough"
                data-size-bytes={fileSize}
            >
                {children}
            </span>
        );
    }
    const sizeLabel = formatBytes(fileSize);
    const capLabel = formatBytes(cap);
    return (
        <div
            data-testid="kb-workbench-size-blocked"
            data-mime-type={mimeType ?? ''}
            data-size-bytes={fileSize}
            data-cap-bytes={cap}
            data-size-label={sizeLabel}
            data-cap-label={capLabel}
            className={cn(
                'flex flex-col gap-2 rounded-md border border-dashed p-4 text-center',
                'border-border bg-card/30 dark:border-border-dark dark:bg-card-primary-dark/20',
            )}
        >
            <p className="text-sm font-medium text-text dark:text-text-dark">{t('title')}</p>
            <p className="text-xs text-text-muted dark:text-text-muted-dark/70">
                {t('description', { size: sizeLabel, cap: capLabel })}
            </p>
            {downloadUrl ? (
                <div>
                    <Button asChild type="button" size="sm" variant="secondary">
                        <a
                            data-testid="kb-workbench-size-blocked-download"
                            href={downloadUrl}
                            download={filename}
                            rel="noopener noreferrer"
                        >
                            {t('download')} ({sizeLabel})
                        </a>
                    </Button>
                </div>
            ) : null}
        </div>
    );
}
