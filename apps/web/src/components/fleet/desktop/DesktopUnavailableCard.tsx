'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Monitor } from 'lucide-react';
import type { FleetDesktopBlocker } from '@ever-works/contracts';
import { Button } from '@/components/ui/button';
import {
    DESKTOP_BLOCKER_KEYS,
    desktopBlockerCommand,
    desktopBlockerRetries,
    desktopBlockerSettingsPath,
} from './desktop.shared';

function formatLastSeen(iso: string | null): string | null {
    if (!iso) return null;
    const at = new Date(iso);
    return Number.isNaN(at.getTime()) ? null : at.toLocaleString();
}

/**
 * Desktop view & control (FL-07, spec §5.4, U1 … U10, U18) — why this
 * computer cannot show its desktop, with the ONE reason and its fix: the exact
 * command to run on the machine (with a copy button) or the settings path to
 * follow there. Never a spinner, never an inert control.
 *
 * ```
 *                     build-01 cannot show its desktop yet
 *       The screen helper is not installed on it. Run this on build-01:
 *           ever-works-node helper install                          [copy]
 *       You can still watch the Agent's browser on this computer.
 *                                                        [ Try again ]
 * ```
 */
export function DesktopUnavailableCard({
    nodeName,
    blocker,
    hint,
    lastSeen,
    browserSourceAvailable,
    onRetry,
}: {
    nodeName: string;
    blocker: FleetDesktopBlocker;
    hint: string | null;
    lastSeen: string | null;
    browserSourceAvailable: boolean;
    onRetry?: () => void;
}) {
    const t = useTranslations('fleet.desktop.unavailable');
    const key = DESKTOP_BLOCKER_KEYS[blocker];
    const command = desktopBlockerCommand(blocker);
    const settingsPath = desktopBlockerSettingsPath(blocker);
    const [copied, setCopied] = useState(false);

    const copy = async () => {
        if (!command) return;
        try {
            await navigator.clipboard.writeText(command);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch {
            // the command stays on screen to copy by hand
        }
    };

    return (
        <section
            className="mx-auto flex max-w-2xl flex-col items-center gap-3 rounded-lg border border-border p-8 text-center"
            data-testid="desktop-unavailable"
            data-blocker={blocker}
            aria-live="polite"
        >
            <Monitor className="h-8 w-8 text-muted-foreground" aria-hidden="true" />
            <h2 className="text-lg font-semibold">{t(`${key}.title`, { name: nodeName })}</h2>
            <p className="text-sm text-muted-foreground">
                {t(`${key}.body`, { name: nodeName, lastSeen: formatLastSeen(lastSeen) ?? t('never') })}
            </p>
            {command ? (
                <div className="flex w-full items-center justify-between gap-2 rounded-md bg-muted px-3 py-2 font-mono text-sm">
                    <code data-testid="desktop-unavailable-command">{command}</code>
                    <Button type="button" size="sm" variant="secondary" onClick={copy}>
                        {copied ? t('copied') : t('copy')}
                    </Button>
                </div>
            ) : null}
            {settingsPath ? (
                <p className="text-sm" data-testid="desktop-unavailable-settings">
                    {t('settingsOn', { name: nodeName, path: settingsPath })}
                </p>
            ) : null}
            {hint && !command && !settingsPath ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
            {browserSourceAvailable && blocker !== 'permission-denied' && blocker !== 'kill-switch' ? (
                <p className="text-sm text-muted-foreground">{t('browserStill')}</p>
            ) : null}
            {onRetry && desktopBlockerRetries(blocker) ? (
                <Button type="button" variant="secondary" onClick={onRetry}>
                    {t('tryAgain')}
                </Button>
            ) : null}
        </section>
    );
}
