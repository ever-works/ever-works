'use client';

import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils/cn';
import { Button } from '@/components/ui/button';

/**
 * EW-641 slice D — default branch of `KbDocumentViewerSwitch` when
 * the upload's MIME type doesn't match any of the wired viewers.
 *
 * The dispatcher tries (in order) PDF, DOCX, XLSX/CSV, PPTX, image,
 * video, audio, and embedded HTML. Anything else (application/zip,
 * application/octet-stream, exotic vendor MIMEs) lands here. We do
 * NOT try to embed the file blindly — the operator gets a clear
 * "no inline preview" message and a direct download link instead.
 *
 * Selectors locked: `kb-workbench-unsupported-viewer` on the root,
 * `kb-workbench-unsupported-download` on the anchor.
 */
export interface UnsupportedFormatBannerProps {
    mimeType?: string;
    filename?: string;
    downloadUrl?: string;
}

export function UnsupportedFormatBanner({
    mimeType,
    filename,
    downloadUrl,
}: UnsupportedFormatBannerProps) {
    const t = useTranslations('dashboard.workDetail.kb.workbench.viewer.unsupported');
    return (
        <div
            data-testid="kb-workbench-unsupported-viewer"
            data-mime-type={mimeType ?? ''}
            className={cn(
                'flex flex-col gap-2 rounded-md border border-dashed p-4 text-center',
                'border-border bg-card/30 dark:border-border-dark dark:bg-card-primary-dark/20',
            )}
        >
            <p className="text-sm font-medium text-text dark:text-text-dark">{t('title')}</p>
            <p className="text-xs text-text-muted dark:text-text-muted-dark/70">
                {t('description', { mime: mimeType ?? '' })}
            </p>
            {downloadUrl ? (
                <div>
                    <Button asChild type="button" size="sm" variant="secondary">
                        <a
                            data-testid="kb-workbench-unsupported-download"
                            href={downloadUrl}
                            download={filename}
                            rel="noopener noreferrer"
                        >
                            {t('download')}
                        </a>
                    </Button>
                </div>
            ) : null}
        </div>
    );
}
