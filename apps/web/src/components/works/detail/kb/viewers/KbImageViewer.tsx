'use client';

import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils/cn';
import { formatBytes } from './KbPdfViewer';
import { MediaSizeFallback } from './MediaSizeFallback';

/**
 * Spec §14.5 — images render inline up to 10 MiB. Tighter than the
 * PDF/DOCX 30 MiB cap because a 30 MiB image would lock the browser
 * for a noticeable beat while decoding.
 */
export const KB_IMAGE_INLINE_MAX_BYTES = 10 * 1024 * 1024;

interface KbImageViewerProps {
    url: string;
    sizeBytes: number;
    filename: string;
    /**
     * Optional explicit alt text. Defaults to the filename so screen
     * readers always announce something; callers with richer doc
     * metadata (e.g. the KB doc title) can override.
     */
    alt?: string;
    maxInlineBytes?: number;
}

/**
 * EW-641 Phase 1B/d row 12 — inline image viewer for KB uploads.
 *
 * Renders a native `<img>` below the cap, download fallback above.
 * Uses `loading="lazy"` so a tree-pane preview cluster doesn't
 * fetch every image up-front, and `decoding="async"` so a large
 * JPEG doesn't block paint.
 *
 * Selectors locked for Playwright A14 (one acceptance covers all
 * §14.5 viewers): `kb-image-viewer` (with `data-mode={"inline"|
 * "download"}` + `data-size-bytes`), `kb-image-element`,
 * `kb-image-download-fallback`, `kb-image-download-link`.
 */
export function KbImageViewer({
    url,
    sizeBytes,
    filename,
    alt,
    maxInlineBytes = KB_IMAGE_INLINE_MAX_BYTES,
}: KbImageViewerProps) {
    const t = useTranslations('dashboard.workDetail.kb.image');
    const overCap = sizeBytes > maxInlineBytes;

    return (
        <section
            data-testid="kb-image-viewer"
            data-mode={overCap ? 'download' : 'inline'}
            data-size-bytes={sizeBytes}
            aria-label={t('label')}
            className="flex flex-col gap-2"
        >
            {overCap ? (
                <MediaSizeFallback
                    testIdPrefix="kb-image"
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
                    {/* eslint-disable-next-line @next/next/no-img-element --
                        next/image would require a remotePatterns allowlist for
                        every storage backend (S3 / R2 / local / proxy). The KB
                        proxy URL is short-lived so we render a plain <img>. */}
                    <img
                        data-testid="kb-image-element"
                        src={url}
                        alt={alt ?? filename}
                        loading="lazy"
                        decoding="async"
                        className="mx-auto h-auto max-h-[36rem] w-auto max-w-full rounded"
                    />
                </div>
            )}
        </section>
    );
}
