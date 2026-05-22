'use client';

import { cn } from '@/lib/utils/cn';
import { Button } from '@/components/ui/button';
import { formatBytes } from './KbPdfViewer';

interface MediaSizeFallbackProps {
    /** Test-id prefix — `kb-image` / `kb-video` / `kb-audio`. */
    testIdPrefix: string;
    url: string;
    filename: string;
    sizeBytes: number;
    maxInlineBytes: number;
    title: string;
    body: string;
    download: string;
}

/**
 * EW-641 Phase 1B/d row 12 — shared download-fallback card for the
 * image / video / audio viewers. Mirrors the PDF + DOCX + XLSX
 * fallback shape so the e2e selectors stay consistent across all
 * five §14.5 viewers.
 */
export function MediaSizeFallback({
    testIdPrefix,
    url,
    filename,
    sizeBytes,
    maxInlineBytes,
    title,
    body,
    download,
}: MediaSizeFallbackProps) {
    const sizeLabel = formatBytes(sizeBytes);
    const capLabel = formatBytes(maxInlineBytes);
    return (
        <div
            data-testid={`${testIdPrefix}-download-fallback`}
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
                        data-testid={`${testIdPrefix}-download-link`}
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
