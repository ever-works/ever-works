'use client';

import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils/cn';
import { formatBytes } from './KbPdfViewer';
import { MediaSizeFallback } from './MediaSizeFallback';

/**
 * Spec §14.5 — audio renders inline up to 50 MiB. Smaller than video
 * because the typical KB audio asset (podcast snippet, voice memo)
 * is a few-MB MP3; anything larger is usually a raw recording the
 * operator would rather download than stream.
 */
export const KB_AUDIO_INLINE_MAX_BYTES = 50 * 1024 * 1024;

interface KbAudioViewerProps {
    url: string;
    sizeBytes: number;
    filename: string;
    mimeType: string;
    maxInlineBytes?: number;
}

/**
 * EW-641 Phase 1B/d row 12 — inline audio viewer for KB uploads.
 *
 * Renders a native `<audio controls>` below the cap, download
 * fallback above. `preload="metadata"` keeps the initial fetch
 * minimal — just the header for duration display.
 *
 * Selectors locked for Playwright A14: `kb-audio-viewer` (with
 * `data-mode` + `data-size-bytes`), `kb-audio-element`,
 * `kb-audio-download-fallback`, `kb-audio-download-link`.
 */
export function KbAudioViewer({
    url,
    sizeBytes,
    filename,
    mimeType,
    maxInlineBytes = KB_AUDIO_INLINE_MAX_BYTES,
}: KbAudioViewerProps) {
    const t = useTranslations('dashboard.workDetail.kb.audio');
    const overCap = sizeBytes > maxInlineBytes;

    return (
        <section
            data-testid="kb-audio-viewer"
            data-mode={overCap ? 'download' : 'inline'}
            data-size-bytes={sizeBytes}
            aria-label={t('label')}
            className="flex flex-col gap-2"
        >
            {overCap ? (
                <MediaSizeFallback
                    testIdPrefix="kb-audio"
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
                        'bg-card dark:bg-card-primary-dark/40 p-3',
                    )}
                >
                    <audio
                        data-testid="kb-audio-element"
                        controls
                        preload="metadata"
                        className="w-full"
                    >
                        <source src={url} type={mimeType} />
                        {t('unsupported')}
                    </audio>
                </div>
            )}
        </section>
    );
}
