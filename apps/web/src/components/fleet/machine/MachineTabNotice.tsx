'use client';

import { useTranslations } from 'next-intl';
import { AlertCircle, Lock, PowerOff, WifiOff } from 'lucide-react';
import type { FleetLinkError } from '@ever-works/contracts';
import { Button } from '@/components/ui/button';

/**
 * Machine actions (FL-09, spec §5.9, U1–U4) — what a machine tab shows when
 * the computer did not answer with a list: offline ("build-01 is offline —
 * Try again"), the consent the machine lacks (the exact command), the family
 * the viewer is outside of, the stop banner, or the first line the tool
 * printed. Always a `status` region with one sentence and one way forward.
 */
export function MachineTabNotice({
    error,
    machine,
    family,
    onRetry,
    testId,
}: {
    error: FleetLinkError;
    machine: string;
    /** The tab's family word ("services", "Docker", "processes") for the permission sentence. */
    family: string;
    onRetry?: () => void;
    testId: string;
}) {
    const t = useTranslations('fleet.actions.states');
    const Icon =
        error.code === 'unreachable'
            ? WifiOff
            : error.code === 'kill_switch'
              ? PowerOff
              : error.code === 'permission_denied' || error.code === 'consent_missing'
                ? Lock
                : AlertCircle;
    const sentence = (() => {
        switch (error.code) {
            case 'unreachable':
                return t('offline', { name: machine });
            case 'consent_missing':
                return t('consentMissing', { name: machine, family });
            case 'permission_denied':
                return t('permissionDenied', { name: machine, family });
            case 'kill_switch':
                return t('killSwitch');
            case 'unsupported_on_node':
                return t('unsupported', { name: machine });
            case 'not_found':
                return t('notFound');
            default:
                return t('failed', { name: machine, family });
        }
    })();
    const detail =
        error.code === 'consent_missing'
            ? 'ever-works-node start --manage'
            : error.code === 'operation_failed' || error.code === 'unsupported_on_node'
              ? error.hint
              : null;

    return (
        <div
            role="status"
            data-testid={testId}
            data-code={error.code}
            className="rounded-xl border border-dashed border-border dark:border-border-dark p-8 flex flex-col items-center text-center gap-3"
        >
            <Icon className="h-6 w-6 text-text-muted dark:text-text-muted-dark" aria-hidden />
            <p className="text-sm text-text dark:text-text-dark">{sentence}</p>
            {detail ? (
                <code className="max-w-full break-all rounded bg-surface-secondary dark:bg-surface-secondary-dark px-2 py-1 font-mono text-xs">
                    {detail}
                </code>
            ) : null}
            {onRetry && error.code !== 'permission_denied' && error.code !== 'consent_missing' ? (
                <Button type="button" variant="secondary" size="sm" onClick={onRetry}>
                    {t('tryAgain')}
                </Button>
            ) : null}
        </div>
    );
}
