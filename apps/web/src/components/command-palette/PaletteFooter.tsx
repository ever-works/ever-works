'use client';

import { useTranslations } from 'next-intl';
import { AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils/cn';

/** The one notice the footer shows, most urgent first. */
export type PaletteBanner = 'offline' | 'throttled' | 'timeout' | 'error' | 'partial' | 'tooShort';

const BANNER_KEYS = {
    offline: 'banner.offline',
    throttled: 'banner.throttled',
    timeout: 'banner.timeout',
    error: 'banner.error',
    partial: 'banner.partial',
    tooShort: 'tooShort',
} as const satisfies Record<PaletteBanner, string>;

interface PaletteFooterProps {
    banner: PaletteBanner | null;
    hasFilter: boolean;
    isMac: boolean;
}

function Hint({ keys, label }: { keys: string; label: string }) {
    return (
        <span className="inline-flex items-center gap-1">
            <kbd
                className={cn(
                    'rounded border px-1 py-0.5 font-sans text-[10px] leading-none',
                    'border-border dark:border-border-dark',
                )}
            >
                {keys}
            </kbd>
            <span>{label}</span>
        </span>
    );
}

/**
 * Keyboard hints plus the single state notice: offline, throttled, timed out,
 * failed, partial results, or "keep typing". The hints are hidden on small
 * screens, where the palette is touch-first.
 */
export function PaletteFooter({ banner, hasFilter, isMac }: PaletteFooterProps) {
    const t = useTranslations('dashboard.commandPalette');

    return (
        <div
            className={cn(
                'border-t px-3 py-2 text-xs',
                'border-border dark:border-border-dark',
                'text-text-muted dark:text-text-muted-dark',
            )}
        >
            {banner ? (
                <p
                    data-testid="command-palette-banner"
                    data-banner={banner}
                    className={cn(
                        'mb-1.5 flex items-center gap-1.5',
                        banner === 'tooShort'
                            ? ''
                            : 'text-text-secondary dark:text-text-secondary-dark',
                    )}
                >
                    {banner === 'tooShort' ? null : (
                        <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    )}
                    {t(BANNER_KEYS[banner])}
                </p>
            ) : null}
            <div className="hidden flex-wrap items-center gap-x-4 gap-y-1 md:flex">
                <Hint keys="↑↓" label={t('footer.navigate')} />
                <Hint keys="↵" label={t('footer.open')} />
                <Hint keys={isMac ? '⌘↵' : 'Ctrl ↵'} label={t('footer.newTab')} />
                {hasFilter ? (
                    <Hint keys="⇧⇥" label={t('footer.removeFilter')} />
                ) : (
                    <Hint keys="⇥" label={t('footer.filterGroup')} />
                )}
                <Hint keys="esc" label={t('footer.close')} />
            </div>
        </div>
    );
}
