'use client';

import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils/cn';
import { formatBytes } from './KbPdfViewer';
import { MediaSizeFallback } from './MediaSizeFallback';

/**
 * Spec §14.5 — video renders inline up to 100 MiB. Above that the
 * browser would stream the whole file as a `<video>` source while
 * the operator scrubs, blowing through their egress allowance. Show
 * a download link so they can pull the file once and seek locally.
 */
export const KB_VIDEO_INLINE_MAX_BYTES = 100 * 1024 * 1024;

interface KbVideoViewerProps {
    url: string;
    sizeBytes: number;
    filename: string;
    /** MIME type — used as the `type` attr on `<source>`. */
    mimeType: string;
    /** Optional poster image URL. */
    poster?: string;
    maxInlineBytes?: number;
}

/**
 * EW-641 Phase 1B/d row 12 — inline video viewer for KB uploads.
 *
 * Renders a native `<video controls>` below the cap, download
 * fallback above. `preload="metadata"` keeps the initial fetch
 * cheap — only the moov atom + first frame, not the whole file.
 *
 * Selectors locked for Playwright A14: `kb-video-viewer` (with
 * `data-mode` + `data-size-bytes`), `kb-video-element`,
 * `kb-video-download-fallback`, `kb-video-download-link`.
 */
export function KbVideoViewer({
    url,
    sizeBytes,
    filename,
    mimeType,
    poster,
    maxInlineBytes = KB_VIDEO_INLINE_MAX_BYTES,
}: KbVideoViewerProps) {
    const t = useTranslations('dashboard.workDetail.kb.video');
    const overCap = sizeBytes > maxInlineBytes;

    return (
        <section
            data-testid="kb-video-viewer"
            data-mode={overCap ? 'download' : 'inline'}
            data-size-bytes={sizeBytes}
            aria-label={t('label')}
            className="flex flex-col gap-2"
        >
            {overCap ? (
                <MediaSizeFallback
                    testIdPrefix="kb-video"
                    url={url}
                    filename={filename}
                    sizeBytes={sizeBytes}
                    maxInlineBytes={maxInlineBytes}
                    title={t('tooLargeTitle')}
                    body={t('tooLargeBody', {
                        size: formatBytes(sizeBytes),
                        cap: formatBytes(maxInlineBytes),
                    })}
                    download={t('download')}
                />
            ) : (
                <div
                    className={cn(
                        'rounded-md border border-border dark:border-border-dark',
                        'bg-card dark:bg-card-primary-dark/40 p-2',
                    )}
                >
                    <video
                        data-testid="kb-video-element"
                        controls
                        preload="metadata"
                        poster={poster}
                        className="mx-auto h-auto max-h-[36rem] w-full rounded"
                    >
                        <source src={url} type={mimeType} />
                        {t('unsupported')}
                    </video>
                </div>
            )}
        </section>
    );
}
