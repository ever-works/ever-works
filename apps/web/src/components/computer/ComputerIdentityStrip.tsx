'use client';

import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import type { ComputerChannel, ComputerQuality } from '@ever-works/contracts';
import { cn } from '@/lib/utils/cn';

interface Props {
    agentName: string;
    nodeName: string;
    /** `09:41:07` in the machine's own time, or null before the first stats. */
    clock: string | null;
    clockStale: boolean;
    channel: ComputerChannel;
    quality: ComputerQuality;
    lowered: boolean;
    live: 'live' | 'connecting' | 'ended';
    /** The node picker trigger, rendered in place of the plain node name. */
    nodeSlot?: ReactNode;
}

/**
 * Agent · computer · the computer's own clock · channel · quality · LIVE.
 * The LIVE indicator carries its word and a title, never colour alone, and
 * the strip names what is captured — the Agent's own browser, not a desktop.
 */
export function ComputerIdentityStrip({
    agentName,
    nodeName,
    clock,
    clockStale,
    channel,
    quality,
    lowered,
    live,
    nodeSlot,
}: Props) {
    const t = useTranslations('dashboard.computer');
    const clockText = clock ?? '—:—:—';
    return (
        <div
            data-testid="computer-identity-strip"
            className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border/60 px-4 py-2 text-xs text-text-secondary dark:border-border-dark/60 dark:text-text-secondary-dark"
        >
            <span className="font-medium text-text dark:text-text-dark">{agentName}</span>
            <span aria-hidden>·</span>
            {nodeSlot ?? <span>{nodeName}</span>}
            <span aria-hidden>·</span>
            <span
                data-testid="computer-node-clock"
                className={cn('font-mono', clockStale && 'text-warning')}
            >
                {clockStale && clock
                    ? t('localTimeStale', { time: clockText })
                    : t('localTime', { time: clockText })}
            </span>
            <span aria-hidden>·</span>
            <span>{channel === 'terminal' ? t('channelTerminal') : t('channelScreen')}</span>
            {channel === 'screen' ? (
                <>
                    <span aria-hidden>·</span>
                    <span className={cn(lowered && 'text-warning')}>{t(`quality.${quality}`)}</span>
                    <span aria-hidden>·</span>
                    <span className="truncate">{t('capturingBrowser', { agent: agentName })}</span>
                </>
            ) : (
                <span className="rounded border border-border px-1 text-[10px] uppercase dark:border-border-dark">
                    {t('terminalReadOnly')}
                </span>
            )}
            <span
                data-testid="computer-live-badge"
                title={t('liveBadgeTitle', { node: nodeName })}
                className={cn(
                    'ml-auto inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
                    live === 'live' && 'bg-danger/10 text-danger',
                    live === 'connecting' && 'bg-text-muted/10 text-text-muted',
                    live === 'ended' && 'bg-text-muted/10 text-text-muted',
                )}
            >
                <span
                    className={cn(
                        'h-1.5 w-1.5 rounded-full',
                        live === 'live' ? 'bg-current' : 'border border-current',
                    )}
                />
                {live === 'live'
                    ? t('liveBadge')
                    : live === 'connecting'
                      ? t('connectingBadge')
                      : t('endedBadge')}
            </span>
        </div>
    );
}
