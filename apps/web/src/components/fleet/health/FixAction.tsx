'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Check, Copy } from 'lucide-react';
import {
    FLEET_NODE_CLEAR_QUARANTINE_COMMAND,
    FLEET_NODE_UPGRADE_COMMAND,
    type ComputerStateAction,
} from '@ever-works/contracts';
import { Button } from '@/components/ui/button';
import { ROUTES } from '@/lib/constants';
import { clearFleetNodeModelThrottleAction } from '@/app/actions/settings/fleet';

/** The existing, audited clear — injectable so the component is testable without a server. */
export type ClearModelThrottle = (
    nodeId: string,
    provider: string | null,
) => Promise<{ success: boolean; error: string | null }>;

export interface FixActionProps {
    nodeId: string;
    nodeName: string;
    action: ComputerStateAction | null;
    /** Where "Change limits" leads. The computer page's settings tab once FL-01 ships it. */
    limitsHref?: string;
    /** Called after a successful clear, so the caller can refetch. */
    onDone?: () => void;
    clearModelThrottle?: ClearModelThrottle;
}

/** Which hint introduces a command the owner runs on the machine. */
function commandHintKey(command: string): 'clearQuarantine' | 'upgrade' | 'startWithConsent' {
    if (command === FLEET_NODE_CLEAR_QUARANTINE_COMMAND) return 'clearQuarantine';
    if (command === FLEET_NODE_UPGRADE_COMMAND) return 'upgrade';
    return 'startWithConsent';
}

/**
 * Computer health (FL-03) — the ONE fix a computer's state offers (FR-8), in
 * the form the platform can honestly offer it:
 *
 *   - **Clear limit now** — a button over the existing, audited
 *     `clear-model-throttle` route; the state changes on the next check-in.
 *   - **A machine command** (lift a quarantine, upgrade the node) — shown with
 *     a copy button and never a run button: only that computer's keyboard can
 *     do it (spec S4: "nothing is offered that the platform cannot do").
 *   - **Change limits** — a link to where the limits are edited.
 *
 * Wake arrives with FL-03's wake phase and renders nothing here until then.
 */
export function FixAction({
    nodeId,
    nodeName,
    action,
    limitsHref = ROUTES.DASHBOARD_SETTINGS_FLEET,
    onDone,
    clearModelThrottle = clearFleetNodeModelThrottleAction,
}: FixActionProps) {
    const t = useTranslations('fleet.fixCommands');
    const [pending, setPending] = useState(false);
    const [outcome, setOutcome] = useState<'cleared' | 'failed' | null>(null);
    const [copied, setCopied] = useState<'copied' | 'failed' | null>(null);

    if (!action) return null;

    if (action.kind === 'clear-model-throttle') {
        const onClick = async () => {
            setPending(true);
            setOutcome(null);
            try {
                const result = await clearModelThrottle(nodeId, action.provider ?? null);
                setOutcome(result.success ? 'cleared' : 'failed');
                if (result.success) onDone?.();
            } catch {
                setOutcome('failed');
            } finally {
                setPending(false);
            }
        };
        return (
            <span
                className="inline-flex flex-wrap items-center gap-2"
                data-testid="fleet-fix-clear-limit"
            >
                <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={onClick}
                    disabled={pending}
                    loading={pending}
                >
                    {pending
                        ? t('clearing')
                        : action.provider
                          ? t('clearLimitNow')
                          : t('clearLimitsNow')}
                </Button>
                {outcome ? (
                    <span
                        role="status"
                        className={
                            outcome === 'cleared' ? 'text-xs text-success' : 'text-xs text-danger'
                        }
                    >
                        {outcome === 'cleared' ? t('cleared') : t('clearFailed')}
                    </span>
                ) : null}
            </span>
        );
    }

    if (action.kind === 'copy-command') {
        const onCopy = async () => {
            try {
                await navigator.clipboard.writeText(action.command);
                setCopied('copied');
            } catch {
                setCopied('failed');
            }
        };
        return (
            <span className="block space-y-1" data-testid="fleet-fix-command">
                <span className="block text-xs text-text-muted dark:text-text-muted-dark">
                    {t(commandHintKey(action.command), { name: nodeName })}
                </span>
                <span className="flex items-center gap-2">
                    <code className="min-w-0 flex-1 truncate rounded bg-surface-hover px-2 py-1 font-mono text-xs dark:bg-surface-hover-dark">
                        {action.command}
                    </code>
                    <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={onCopy}
                        aria-label={t('copy')}
                    >
                        {copied === 'copied' ? (
                            <Check className="h-3.5 w-3.5" aria-hidden />
                        ) : (
                            <Copy className="h-3.5 w-3.5" aria-hidden />
                        )}
                        <span className="sr-only">{t('copy')}</span>
                    </Button>
                </span>
                {copied ? (
                    <span
                        role="status"
                        className="block text-xs text-text-muted dark:text-text-muted-dark"
                    >
                        {copied === 'copied' ? t('copied') : t('copyFailed')}
                    </span>
                ) : null}
            </span>
        );
    }

    if (action.kind === 'change-limits') {
        return (
            <span className="inline-flex" data-testid="fleet-fix-change-limits">
                <Button href={limitsHref} variant="secondary" size="sm">
                    {t('changeLimits')}
                </Button>
            </span>
        );
    }

    // `wake` — FL-03's wake phase renders its panel; nothing is offered before it exists.
    return null;
}
