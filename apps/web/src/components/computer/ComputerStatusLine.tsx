'use client';

import { useTranslations } from 'next-intl';
import type { ComputerChannel, ComputerQuality } from '@ever-works/contracts';
import type { ComputerStallState } from './computer-session.shared';

interface Props {
    agentName: string;
    nodeName: string;
    channel: ComputerChannel;
    stall: ComputerStallState;
    /** Set when the machine lowered the owner's chosen quality. */
    lowered: { tier: ComputerQuality; chosen: ComputerQuality } | null;
    /** True while this view holds control of the computer. */
    controlling?: boolean;
    /** One more sentence about control: how long it lasts, or that it was released automatically. */
    controlNote?: string | null;
}

/**
 * The mode in prose — never only a colour or an icon — plus the two
 * sentences that change what the owner should conclude from the picture:
 * a stale picture is not stalled work, and a lowered quality comes back on
 * its own. The line is a polite live region, so a mode change is announced.
 * In control, the sentence says so and that the Agent's own input is paused.
 */
export function ComputerStatusLine({
    agentName,
    nodeName,
    channel,
    stall,
    lowered,
    controlling = false,
    controlNote = null,
}: Props) {
    const t = useTranslations('dashboard.computer');
    const mode = controlling
        ? t('modeControlling', { agent: agentName })
        : channel === 'terminal'
          ? t('terminalOnNode', { node: nodeName })
          : t('modeWatching', { agent: agentName });
    return (
        <div
            data-testid="computer-status-line"
            role="status"
            aria-live="polite"
            className="text-sm text-text dark:text-text-dark"
        >
            <span data-testid="computer-mode-sentence">{mode}</span>
            {controlNote ? <span className="ml-1">{controlNote}</span> : null}
            {stall === 'stalled' || stall === 'auto-refresh' ? (
                <span className="ml-1">{t('stall.staleNote')}</span>
            ) : null}
            {lowered ? (
                <span className="ml-1 text-warning">
                    {t('quality.autoLowered', {
                        tier: t(`quality.${lowered.tier}`),
                        chosen: t(`quality.${lowered.chosen}`),
                    })}
                </span>
            ) : null}
        </div>
    );
}
