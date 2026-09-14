'use client';

import { useTranslations } from 'next-intl';
import { Search } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { useCommandPalette } from './CommandPaletteProvider';
import { useIsMac } from './hooks/use-is-mac';

/**
 * The top-bar "Search…" control. Opens the same palette as `Ctrl/Cmd+K`, so
 * an operator who never learns the shortcut is not left without it. Below
 * 768 px it collapses to the search icon. Renders nothing outside the
 * dashboard shell.
 */
export function CommandPaletteTrigger({ className }: { className?: string }) {
    const t = useTranslations('dashboard.commandPalette');
    const palette = useCommandPalette();
    const isMac = useIsMac();

    if (!palette) return null;

    return (
        <button
            type="button"
            data-testid="command-palette-trigger"
            aria-haspopup="dialog"
            aria-expanded={palette.open}
            onClick={() => palette.openPalette('trigger')}
            className={cn(
                'inline-flex shrink-0 items-center gap-2 rounded-md border text-sm transition-colors',
                'border-border dark:border-border-dark',
                'bg-surface dark:bg-surface-secondary-dark',
                'text-text-muted dark:text-text-muted-dark',
                'hover:text-text dark:hover:text-text-dark',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2',
                'h-11 w-11 justify-center md:h-8 md:w-auto md:min-w-56 md:justify-start md:px-2.5',
                className,
            )}
        >
            <Search className="h-4 w-4 shrink-0" aria-hidden="true" />
            {/* Visually hidden on small screens, but always the button's accessible name. */}
            <span className="sr-only md:not-sr-only md:flex-1 md:text-left">{t('trigger')}</span>
            <kbd
                aria-hidden="true"
                className={cn(
                    'hidden rounded border px-1.5 py-0.5 font-sans text-[11px] leading-none md:inline',
                    'border-border dark:border-border-dark',
                    'bg-white dark:bg-surface-dark',
                )}
            >
                {isMac ? t('triggerHintMac') : t('triggerHintOther')}
            </kbd>
        </button>
    );
}
