'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils/cn';
import { CheckCircle2, AlertCircle, Loader2, ExternalLink, Clock } from 'lucide-react';

interface DeployStatus {
    deploymentState:
        | 'INITIALIZING'
        | 'QUEUED'
        | 'BUILDING'
        | 'READY'
        | 'ERROR'
        | 'CANCELED'
        | string
        | null;
    deploymentStartedAt: string | null;
    website: string | null;
    deployProvider: string | null;
}

interface DeployProgressPanelProps {
    workId: string;
    /** Initial isDeploying signal from the server-rendered parent. Used to
     *  decide whether to mount the panel at all and start polling. */
    isDeploying: boolean;
}

const TERMINAL_STATES = new Set(['READY', 'ERROR', 'CANCELED', 'TIMEOUT']);

/**
 * Live deploy progress panel (EW-610 — MVP).
 *
 * Polls `/api/works/:id/deploy/status` every 3s while a deploy is in
 * flight (`isDeploying` from the parent OR the polled state is non-terminal).
 * Surfaces:
 *   - the current platform-side `deploymentState` with a colored badge
 *   - elapsed time since `deploymentStartedAt`
 *   - a link to the deployed website once `READY`
 *   - a link to the GitHub Actions runs page on `ERROR` so the user can
 *     drill into the workflow logs without needing to know which repo
 *
 * Out of scope for this MVP (tracked separately):
 *   - per-step GitHub Actions workflow run timeline (needs new Octokit
 *     calls + a new platform endpoint to surface them).
 *   - "retry imagePullSecret" button when the pod is `ImagePullBackOff`.
 *   - tailing `kubectl logs` of the deployed pod.
 */
// Inline state labels keep this MVP self-contained — these strings are
// the canonical deployment-state enum names plus a short user-facing
// description. They live here (not in i18n catalogs) so adding a new
// state on the platform side doesn't require touching 20 locale files.
const STATE_LABELS: Record<string, { title: string; message: string }> = {
    INITIALIZING: {
        title: 'Initializing deploy',
        message: 'Setting up your deploy environment.',
    },
    QUEUED: {
        title: 'Queued',
        message: 'Waiting for the deploy workflow runner to pick up the job.',
    },
    BUILDING: {
        title: 'Building',
        message: 'Building your container image and pushing to the registry.',
    },
    READY: { title: 'Deployed successfully', message: 'Your website is live.' },
    ERROR: {
        title: 'Deploy failed',
        message:
            'The deploy workflow finished with an error. Check the GitHub Actions logs on the website repository for details.',
    },
    CANCELED: { title: 'Deploy canceled', message: 'The deploy was canceled.' },
    TIMEOUT: {
        title: 'Deploy timed out',
        message: 'The deploy took too long to finish. The cluster may still be rolling out.',
    },
    UNKNOWN: { title: 'Status unknown', message: 'No recent deploy activity yet.' },
};

export function DeployProgressPanel({ workId, isDeploying }: DeployProgressPanelProps) {
    const t = useTranslations('dashboard.workDetail.deploy.progress');
    const [status, setStatus] = useState<DeployStatus | null>(null);
    const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const [elapsedSeconds, setElapsedSeconds] = useState<number | null>(null);

    // Decide whether to keep polling: start when `isDeploying` is true,
    // continue until we observe a terminal state from the server. This
    // catches the case where the parent's `isDeploying` resets to false
    // before the platform reports READY/ERROR.
    const shouldPoll =
        isDeploying || (status?.deploymentState && !TERMINAL_STATES.has(status.deploymentState));

    useEffect(() => {
        if (!shouldPoll) {
            if (intervalRef.current) {
                clearInterval(intervalRef.current);
                intervalRef.current = null;
            }
            return;
        }

        const poll = async () => {
            try {
                const res = await fetch(`/api/works/${workId}/deploy/status`);
                if (res.ok) {
                    setStatus(await res.json());
                }
            } catch {
                // Silently ignore polling errors — the panel falls back to
                // its last-known good state. The next tick will recover.
            }
        };

        poll();
        intervalRef.current = setInterval(poll, 3000);

        return () => {
            if (intervalRef.current) {
                clearInterval(intervalRef.current);
                intervalRef.current = null;
            }
        };
    }, [shouldPoll, workId]);

    // Elapsed time ticker — independent of the poll cadence so the
    // counter visibly moves every second.
    useEffect(() => {
        if (!status?.deploymentStartedAt) {
            setElapsedSeconds(null);
            return;
        }
        const startedAt = new Date(status.deploymentStartedAt).getTime();
        const tick = () => {
            setElapsedSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
        };
        tick();
        const interval = setInterval(tick, 1000);
        return () => clearInterval(interval);
    }, [status?.deploymentStartedAt]);

    if (!isDeploying && !status) return null;
    if (!status) {
        return (
            <div className="rounded-lg bg-surface dark:bg-surface-dark border border-border dark:border-border-dark p-6">
                <div className="flex items-center gap-3">
                    <Loader2 className="w-5 h-5 animate-spin text-primary" />
                    <span className="text-sm text-text dark:text-text-dark">
                        {t('loadingStatus')}
                    </span>
                </div>
            </div>
        );
    }

    const stateKey = (status.deploymentState ?? 'UNKNOWN').toUpperCase();
    const isReady = stateKey === 'READY';
    const isError = stateKey === 'ERROR' || stateKey === 'TIMEOUT';
    const isCanceled = stateKey === 'CANCELED';
    const isInFlight = !isReady && !isError && !isCanceled && stateKey !== 'UNKNOWN';

    return (
        <div className="rounded-lg bg-surface dark:bg-surface-dark border border-border dark:border-border-dark p-6">
            <div className="flex items-start gap-4">
                <div
                    className={cn(
                        'shrink-0 w-10 h-10 rounded-full flex items-center justify-center',
                        isReady && 'bg-success/10 dark:bg-success-dark/10',
                        isError && 'bg-error/10 dark:bg-error-dark/10',
                        isInFlight && 'bg-primary/10 dark:bg-primary-dark/10',
                        (isCanceled || stateKey === 'UNKNOWN') &&
                            'bg-surface-secondary dark:bg-surface-secondary-dark',
                    )}
                >
                    {isReady && <CheckCircle2 className="w-5 h-5 text-success" />}
                    {isError && <AlertCircle className="w-5 h-5 text-error" />}
                    {isInFlight && <Loader2 className="w-5 h-5 animate-spin text-primary" />}
                    {(isCanceled || stateKey === 'UNKNOWN') && (
                        <Clock className="w-5 h-5 text-text-muted dark:text-text-muted-dark" />
                    )}
                </div>

                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                        <h3 className="text-sm font-semibold text-text dark:text-text-dark">
                            {(STATE_LABELS[stateKey] || STATE_LABELS.UNKNOWN).title}
                        </h3>
                        <span
                            className={cn(
                                'text-xs px-2 py-0.5 rounded-full font-medium',
                                isReady && 'bg-success/10 text-success',
                                isError && 'bg-error/10 text-error',
                                isInFlight && 'bg-primary/10 text-primary',
                                (isCanceled || stateKey === 'UNKNOWN') &&
                                    'bg-surface-secondary text-text-muted',
                            )}
                        >
                            {stateKey}
                        </span>
                        {elapsedSeconds !== null && isInFlight && (
                            <span className="text-xs text-text-muted dark:text-text-muted-dark">
                                {formatElapsed(elapsedSeconds)}
                            </span>
                        )}
                    </div>

                    <p className="text-sm text-text-secondary dark:text-text-secondary-dark mt-1">
                        {(STATE_LABELS[stateKey] || STATE_LABELS.UNKNOWN).message}
                    </p>

                    {isReady && status.website && (
                        <a
                            href={status.website}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1.5 mt-3 text-sm text-primary hover:text-primary/80 font-medium"
                        >
                            {t('openWebsite')}
                            <ExternalLink className="w-3.5 h-3.5" />
                        </a>
                    )}
                </div>
            </div>
        </div>
    );
}

function formatElapsed(seconds: number) {
    if (seconds < 60) return `${seconds}s`;
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}m ${secs}s`;
}
