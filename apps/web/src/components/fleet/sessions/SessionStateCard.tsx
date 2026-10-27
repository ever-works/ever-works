'use client';

import { useLocale, useTranslations } from 'next-intl';
import { AlertTriangle, PlugZap, ShieldOff, WifiOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { CopyCommand } from '../link/CopyCommand';
import { relativeTime } from '../fleet-hub.shared';
import type { SessionsTabCard } from './sessions.shared';

/**
 * Sessions on computers (FL-04 P1b, spec §5.1, U1 … U4, U6) — the one card the
 * Sessions tab leads with when the computer cannot take a new session right
 * now, in words: the consent missing (the exact command, copyable), the
 * session daemon down (the node's own diagnosis, and Retry), the computer
 * offline (since when — its sessions are still listed below), or the
 * eight-session limit. Never a spinner, never an inert button.
 */
export function SessionStateCard({
    card,
    nodeName,
    onRetry,
}: {
    card: SessionsTabCard | { kind: 'limit'; count: number };
    nodeName: string;
    onRetry?: () => void;
}) {
    const t = useTranslations('fleet.sessions');
    const locale = useLocale();
    if (card.kind === 'none') return null;

    const frame =
        'rounded-xl border border-border dark:border-border-dark bg-card dark:bg-card-primary-dark p-4 flex gap-3';
    if (card.kind === 'consent-missing') {
        return (
            <div
                role="status"
                className={frame}
                data-testid="fleet-sessions-card"
                data-card="consent-missing"
            >
                <ShieldOff className="w-5 h-5 shrink-0 text-warning" aria-hidden="true" />
                <div className="space-y-2 min-w-0">
                    <p className="text-sm font-medium text-text dark:text-text-dark">
                        {t('states.consentManage')}
                    </p>
                    <p className="text-xs text-text-muted dark:text-text-muted-dark">
                        {t('states.consentCommand', { node: nodeName })}
                    </p>
                    <CopyCommand command={card.command} testId="fleet-sessions-consent-command" />
                </div>
            </div>
        );
    }
    if (card.kind === 'daemon-down') {
        return (
            <div
                role="status"
                className={frame}
                data-testid="fleet-sessions-card"
                data-card="daemon-down"
            >
                <PlugZap className="w-5 h-5 shrink-0 text-danger" aria-hidden="true" />
                <div className="space-y-2 min-w-0">
                    <p className="text-sm font-medium text-text dark:text-text-dark">
                        {card.reason
                            ? t('states.daemonDown', { node: nodeName, reason: card.reason })
                            : t('states.daemonDownNoReason', { node: nodeName })}
                    </p>
                    <p className="text-xs text-text-muted dark:text-text-muted-dark">
                        {t('states.daemonDownBody', { node: nodeName })}
                    </p>
                    {onRetry && (
                        <Button
                            size="sm"
                            variant="secondary"
                            onClick={onRetry}
                            data-testid="fleet-sessions-retry"
                        >
                            {t('states.retry')}
                        </Button>
                    )}
                </div>
            </div>
        );
    }
    if (card.kind === 'offline') {
        const relative = relativeTime(card.lastSeen, new Date(), locale);
        return (
            <div
                role="status"
                className={frame}
                data-testid="fleet-sessions-card"
                data-card="offline"
            >
                <WifiOff
                    className="w-5 h-5 shrink-0 text-text-muted dark:text-text-muted-dark"
                    aria-hidden="true"
                />
                <p className="text-sm text-text dark:text-text-dark">
                    {relative
                        ? t('states.offline', { node: nodeName, relative })
                        : t('states.offlineNever', { node: nodeName })}
                </p>
            </div>
        );
    }
    return (
        <div role="status" className={frame} data-testid="fleet-sessions-card" data-card="limit">
            <AlertTriangle className="w-5 h-5 shrink-0 text-warning" aria-hidden="true" />
            <p className="text-sm text-text dark:text-text-dark">
                {t('limits.sessions', { node: nodeName, count: card.count })}
            </p>
        </div>
    );
}
