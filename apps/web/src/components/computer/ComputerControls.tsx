'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Keyboard, MoreHorizontal, RefreshCw } from 'lucide-react';
import {
    COMPUTER_QUALITIES,
    type ComputerChannel,
    type ComputerQuality,
} from '@ever-works/contracts';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { cn } from '@/lib/utils/cn';

interface Props {
    channel: ComputerChannel;
    servableChannels: readonly ComputerChannel[];
    quality: ComputerQuality;
    bandwidth: string;
    canRefresh: boolean;
    onChannel: (channel: ComputerChannel) => void;
    onQuality: (quality: ComputerQuality) => void;
    onRefresh: () => void;
    onOpenProfile: () => void;
    onCopyLink: () => void;
    onEndSession: () => void;
    onOpenShortcuts: () => void;
    linkCopied: boolean;
}

/**
 * Channel switch, quality, refresh and the `⋯` menu (own logins and files,
 * copy link, bandwidth used, end session). Watching only: there is no take
 * over control on this surface yet, and none is rendered.
 */
export function ComputerControls({
    channel,
    servableChannels,
    quality,
    bandwidth,
    canRefresh,
    onChannel,
    onQuality,
    onRefresh,
    onOpenProfile,
    onCopyLink,
    onEndSession,
    onOpenShortcuts,
    linkCopied,
}: Props) {
    const t = useTranslations('dashboard.computer');
    const [menuOpen, setMenuOpen] = useState(false);
    const menuRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        if (!menuOpen) return;
        const onKey = (event: KeyboardEvent) => {
            if (event.key === 'Escape') setMenuOpen(false);
        };
        const onClick = (event: MouseEvent) => {
            if (menuRef.current && !menuRef.current.contains(event.target as Node))
                setMenuOpen(false);
        };
        document.addEventListener('keydown', onKey);
        document.addEventListener('mousedown', onClick);
        return () => {
            document.removeEventListener('keydown', onKey);
            document.removeEventListener('mousedown', onClick);
        };
    }, [menuOpen]);

    return (
        <div data-testid="computer-controls" className="flex flex-wrap items-center gap-2">
            <div
                role="group"
                aria-label={t('channelLabel')}
                className="inline-flex overflow-hidden rounded-md border border-border dark:border-border-dark"
            >
                {(['screen', 'terminal'] as const).map((option) => {
                    const available = servableChannels.includes(option);
                    return (
                        <button
                            key={option}
                            type="button"
                            aria-pressed={channel === option}
                            disabled={!available}
                            onClick={() => onChannel(option)}
                            className={cn(
                                'px-3 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-40',
                                channel === option
                                    ? 'bg-surface-secondary font-medium dark:bg-surface-secondary-dark'
                                    : 'hover:bg-surface-hover dark:hover:bg-surface-hover-dark',
                            )}
                        >
                            {option === 'screen' ? t('channelScreen') : t('channelTerminal')}
                        </button>
                    );
                })}
            </div>

            {channel === 'screen' ? (
                <div className="w-32">
                    <Select
                        size="xs"
                        aria-label={t('qualityLabel')}
                        data-testid="computer-quality"
                        value={quality}
                        onValueChange={(value) => onQuality(value as ComputerQuality)}
                    >
                        {COMPUTER_QUALITIES.map((option) => (
                            <option key={option} value={option}>
                                {t(`quality.${option}`)}
                            </option>
                        ))}
                    </Select>
                </div>
            ) : null}

            <Button size="sm" variant="ghost" onClick={onRefresh} disabled={!canRefresh}>
                <RefreshCw className="mr-1 h-3.5 w-3.5" aria-hidden />
                {t('refresh')}
            </Button>

            <span className="text-xs text-text-muted dark:text-text-muted-dark">{t('noCost')}</span>

            <div ref={menuRef} className="relative ml-auto">
                <Button
                    size="sm"
                    variant="ghost"
                    aria-label={t('moreActions')}
                    aria-expanded={menuOpen}
                    onClick={() => setMenuOpen((open) => !open)}
                >
                    <MoreHorizontal className="h-4 w-4" aria-hidden />
                </Button>
                {menuOpen ? (
                    <div
                        role="menu"
                        data-testid="computer-more-menu"
                        className="absolute bottom-full right-0 z-40 mb-1 w-64 rounded-lg border border-border bg-surface p-1 text-sm shadow-lg dark:border-border-dark dark:bg-surface-dark"
                    >
                        <button
                            type="button"
                            role="menuitem"
                            className="block w-full rounded px-2 py-1.5 text-left hover:bg-surface-hover dark:hover:bg-surface-hover-dark"
                            onClick={() => {
                                setMenuOpen(false);
                                onOpenProfile();
                            }}
                        >
                            {t('profile.action')}
                        </button>
                        <button
                            type="button"
                            role="menuitem"
                            className="block w-full rounded px-2 py-1.5 text-left hover:bg-surface-hover dark:hover:bg-surface-hover-dark"
                            onClick={onCopyLink}
                        >
                            {linkCopied ? t('linkCopied') : t('copyLink')}
                        </button>
                        <button
                            type="button"
                            role="menuitem"
                            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-surface-hover dark:hover:bg-surface-hover-dark"
                            onClick={() => {
                                setMenuOpen(false);
                                onOpenShortcuts();
                            }}
                        >
                            <Keyboard className="h-3.5 w-3.5" aria-hidden />
                            {t('shortcuts.open')}
                        </button>
                        <p
                            className="px-2 py-1.5 text-xs text-text-muted dark:text-text-muted-dark"
                            data-testid="computer-bandwidth"
                        >
                            {t('bandwidthUsed', { value: bandwidth })}
                        </p>
                        <button
                            type="button"
                            role="menuitem"
                            className="block w-full rounded px-2 py-1.5 text-left text-danger hover:bg-surface-hover dark:hover:bg-surface-hover-dark"
                            onClick={() => {
                                setMenuOpen(false);
                                onEndSession();
                            }}
                        >
                            {t('endSession')}
                        </button>
                    </div>
                ) : null}
            </div>
        </div>
    );
}
