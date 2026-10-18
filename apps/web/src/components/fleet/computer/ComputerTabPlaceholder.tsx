'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Check, Clock, Copy, Lock, MonitorOff } from 'lucide-react';
import type { FleetComputerTabId, FleetTabConsent } from '../registry';
import { FLEET_PROGRAM_TRACKER_URL } from '../fleet-links';

export type ComputerTabPlaceholderState =
    | { kind: 'not-shipped'; epic: string }
    | { kind: 'switched-off'; epic: string }
    | { kind: 'kind-cannot' }
    | { kind: 'consent-missing'; consent: FleetTabConsent; command: string };

/**
 * Fleet hub (FL-01, FR-18 – FR-20, spec §5.9) — what a computer-page tab
 * shows instead of its content, one sentence each, never a spinner:
 *
 *   - not shipped:     "Logs arrive with FL-08."
 *   - switched off:    "Logs are switched off on this deployment."
 *   - consent missing: "Start the node with --manage on build-01 to use Logs."
 *                      and the exact command, with a copy button (rule 14 —
 *                      the consent is named, never a generic error);
 *   - kind cannot:     "Not available on this kind of computer yet." (R-10)
 *
 * A `status` region (spec §5.13).
 */
export function ComputerTabPlaceholder({
    tab,
    nodeName,
    state,
}: {
    tab: FleetComputerTabId;
    nodeName: string;
    state: ComputerTabPlaceholderState;
}) {
    const t = useTranslations('fleet.computer');
    const [copied, setCopied] = useState(false);
    const label = t(`tabs.${tab}`);

    const copy = async (command: string) => {
        try {
            await navigator.clipboard.writeText(command);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch {
            setCopied(false);
        }
    };

    const Icon =
        state.kind === 'consent-missing' ? Lock : state.kind === 'kind-cannot' ? MonitorOff : Clock;

    return (
        <div
            role="status"
            data-testid={`fleet-computer-placeholder-${tab}`}
            data-state={state.kind}
            className="rounded-xl border border-dashed border-border dark:border-border-dark p-10 flex flex-col items-center text-center gap-3"
        >
            <div className="w-10 h-10 rounded-lg bg-surface-secondary dark:bg-surface-secondary-dark flex items-center justify-center">
                <Icon
                    className="w-5 h-5 text-text-muted dark:text-text-muted-dark"
                    aria-hidden="true"
                />
            </div>
            {state.kind === 'not-shipped' && (
                <>
                    <p className="text-sm font-medium text-text dark:text-text-dark">
                        {t('placeholder.notShipped', { tab: label, epic: state.epic, tabId: tab })}
                    </p>
                    <a
                        href={FLEET_PROGRAM_TRACKER_URL}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-info hover:underline"
                    >
                        {t('placeholder.tracker')}
                    </a>
                </>
            )}
            {state.kind === 'switched-off' && (
                <p className="text-sm font-medium text-text dark:text-text-dark">
                    {t('placeholder.switchedOff', { tab: label, tabId: tab })}
                </p>
            )}
            {state.kind === 'kind-cannot' && (
                <p className="text-sm font-medium text-text dark:text-text-dark">
                    {t('placeholder.kindCannot')}
                </p>
            )}
            {state.kind === 'consent-missing' && (
                <>
                    <p className="text-sm font-medium text-text dark:text-text-dark">
                        {t('placeholder.consentMissing', {
                            flag: `--${state.consent}`,
                            node: nodeName,
                            tab: label,
                        })}
                    </p>
                    <div className="flex items-center gap-2 rounded-md border border-border dark:border-border-dark bg-surface-secondary/60 dark:bg-surface-secondary-dark/60 pl-3 pr-1 py-1">
                        <code
                            className="text-xs font-mono text-text dark:text-text-dark"
                            data-testid="fleet-computer-consent-command"
                        >
                            {state.command}
                        </code>
                        <button
                            type="button"
                            onClick={() => copy(state.command)}
                            className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-text-muted dark:text-text-muted-dark hover:text-text dark:hover:text-text-dark hover:bg-surface-tertiary dark:hover:bg-white/5"
                            aria-label={t('placeholder.copyCommand')}
                            data-testid="fleet-computer-consent-copy"
                        >
                            {copied ? (
                                <Check className="w-3.5 h-3.5 text-success" aria-hidden="true" />
                            ) : (
                                <Copy className="w-3.5 h-3.5" aria-hidden="true" />
                            )}
                            {copied ? t('placeholder.copied') : t('placeholder.copy')}
                        </button>
                    </div>
                </>
            )}
        </div>
    );
}
