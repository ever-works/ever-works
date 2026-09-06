'use client';

import { useTranslations } from 'next-intl';
import { AlertTriangle, ShieldAlert } from 'lucide-react';
import type { FleetKillSwitchState } from '@/lib/api/fleet';
import { useKillSwitchPolling } from '@/lib/hooks/use-kill-switch-polling';

interface FleetKillSwitchBannerProps {
    /** First paint from the server page; the banner keeps polling afterwards. */
    initial: FleetKillSwitchState | null;
    initialError: string | null;
}

function formatSince(value: string | null): string {
    if (!value) return '';
    try {
        return new Date(value).toLocaleString(undefined, {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
        });
    } catch {
        return value;
    }
}

/**
 * Panic controls (EW-778) — the banner that says the platform is STOPPED.
 *
 * Three states, three different sentences, because they ask for three
 * different responses from whoever is reading:
 *
 *   - `stopped`    — an operator threw the switch. Shows the reason and
 *                    the time; nothing the reader does here will start
 *                    work until it is cleared.
 *   - `unverified` — the API could not READ the flag and is refusing
 *                    dispatch on that basis (fail-closed). Nobody threw
 *                    the switch; the reader should not go looking for
 *                    who did. Usually "migration not run yet".
 *   - `unknown`    — this PAGE could not reach the API for the flag at
 *                    all. Rendered muted: it says nothing about dispatch.
 *
 * Polled every 30s so an operator throwing the switch is visible without
 * a reload. Renders nothing while the flag is clear.
 */
export function FleetKillSwitchBanner({ initial, initialError }: FleetKillSwitchBannerProps) {
    const t = useTranslations('dashboard.settings.fleet.killSwitch');
    const { state, error } = useKillSwitchPolling(initial, initialError);

    if (state?.stopped) {
        const unverified = state.unverified === true;
        return (
            <div
                role="alert"
                className="flex items-start gap-3 p-4 bg-danger/10 border border-danger/30 rounded-lg"
                data-testid="fleet-kill-switch-banner"
                data-variant={unverified ? 'unverified' : 'stopped'}
            >
                <ShieldAlert className="w-5 h-5 text-danger flex-shrink-0 mt-0.5" />
                <div className="space-y-1">
                    <p className="text-sm font-semibold text-text dark:text-text-dark">
                        {unverified ? t('unverifiedTitle') : t('stoppedTitle')}
                    </p>
                    <p className="text-sm text-text-muted dark:text-text-muted-dark">
                        {unverified ? t('unverifiedBody') : t('stoppedBody')}
                    </p>
                    {!unverified && state.reason && (
                        <p
                            className="text-sm text-text dark:text-text-dark"
                            data-testid="fleet-kill-switch-reason"
                        >
                            {t('reason', { reason: state.reason })}
                        </p>
                    )}
                    {!unverified && state.since && (
                        <p
                            className="text-xs text-text-muted dark:text-text-muted-dark"
                            data-testid="fleet-kill-switch-since"
                        >
                            {t('since', { since: formatSince(state.since) })}
                        </p>
                    )}
                </div>
            </div>
        );
    }

    if (!state && error) {
        return (
            <div
                className="flex items-start gap-2 p-3 bg-warning/10 border border-warning/20 rounded-lg"
                data-testid="fleet-kill-switch-banner"
                data-variant="unknown"
            >
                <AlertTriangle className="w-5 h-5 text-warning flex-shrink-0 mt-0.5" />
                <div>
                    <p className="text-sm font-medium text-text dark:text-text-dark">
                        {t('unknownTitle')}
                    </p>
                    <p className="text-sm text-text-muted dark:text-text-muted-dark">
                        {t('unknownBody', { error })}
                    </p>
                </div>
            </div>
        );
    }

    return null;
}
