'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle, Loader2 } from 'lucide-react';
import type { AppUpstreamStateResponse } from '@ever-works/contracts';
import { browserApiFetch } from '@/lib/api/browser-api';
import { retryUpstreamReadinessAction } from '@/app/actions/dashboard/works';
import { Link, useRouter } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils/cn';

/** Poll every 5 s while the repository is being prepared … (APW-01 T24) */
export const APP_SOURCE_PREPARING_POLL_MS = 5_000;
/** … at most 240 times (20 minutes — past the 15-minute readiness deadline). */
export const APP_SOURCE_PREPARING_POLL_MAX = 240;
/** Poll every 30 s while the setup pull request waits to be merged … */
export const APP_SOURCE_WAITING_POLL_MS = 30_000;
/** … at most 120 times (one hour). */
export const APP_SOURCE_WAITING_POLL_MAX = 120;

/** The `failedReasons.*` leaves that have their own copy (spec §6.4). */
const FAILED_REASON_LEAVES = new Set([
    'works_yml_unparseable',
    'works_yml_other_kind',
    'push_rejected',
    'provider_unsupported',
    'too_large_for_private_copy',
    'uses_lfs',
]);

export type AppSourceFailureCopy =
    | { kind: 'access' }
    | { kind: 'setupPrClosed' }
    | { kind: 'other'; leaf: string };

/**
 * Spec §6.4's "Failed reasons" rules: the card never shows a raw code. A
 * leading `handler_failed:` is stripped, `too_large` reads as
 * `too_large_for_private_copy`, `access_revoked` and `setup_pull_request_closed`
 * get their own rows, and every other or unknown code uses the generic line.
 */
export function appSourceFailureCopy(
    readiness: AppUpstreamStateResponse['readiness'],
): AppSourceFailureCopy {
    const raw =
        readiness.reason === 'handler_failed' && readiness.handlerReason?.code
            ? readiness.handlerReason.code
            : (readiness.reason ?? '');
    let code = String(raw).replace(/^handler_failed:/, '');
    if (code === 'too_large') code = 'too_large_for_private_copy';
    if (code === 'access_revoked') return { kind: 'access' };
    if (code === 'setup_pull_request_closed') return { kind: 'setupPrClosed' };
    return { kind: 'other', leaf: FAILED_REASON_LEAVES.has(code) ? code : 'other' };
}

export interface AppSourceStatusCardProps {
    workId: string;
    initialState: AppUpstreamStateResponse;
    /** Whether a Blueprint is being applied (the "Applying the {name} Blueprint" row). */
    blueprintName?: string | null;
}

/**
 * APW-01 T24 — the App source status card (spec §6.4): above the Overview tiles
 * while the App Work is not ready, gone once it is.
 *
 * Polls the Upstream read through the BFF route — every 5 s while preparing (at
 * most 240 times) and every 30 s while the setup pull request waits (at most 120
 * times) — and stops on a terminal state and on unmount. Reaching `ready`
 * refreshes the page so the rest of the Overview follows.
 */
export function AppSourceStatusCard({
    workId,
    initialState,
    blueprintName,
}: AppSourceStatusCardProps) {
    const t = useTranslations('dashboard.workDetail.appSource');
    const router = useRouter();
    const [state, setState] = useState(initialState);
    const [retrying, setRetrying] = useState(false);
    const [retryLimited, setRetryLimited] = useState(false);
    const [retryFailed, setRetryFailed] = useState(false);
    const polls = useRef(0);
    // Read through a ref so a router object that is not referentially stable
    // can never restart the poll (and with it the 240 / 120 cap).
    const routerRef = useRef(router);
    useEffect(() => {
        routerRef.current = router;
    }, [router]);

    useEffect(() => {
        setState(initialState);
    }, [initialState]);

    const readinessState = state.readiness.state;
    const pollMs =
        readinessState === 'preparing'
            ? APP_SOURCE_PREPARING_POLL_MS
            : readinessState === 'waiting_for_setup_pr'
              ? APP_SOURCE_WAITING_POLL_MS
              : null;
    const pollMax =
        readinessState === 'preparing'
            ? APP_SOURCE_PREPARING_POLL_MAX
            : APP_SOURCE_WAITING_POLL_MAX;

    const refresh = useCallback(async () => {
        try {
            const response = await browserApiFetch(`/api/works/${workId}/upstream`);
            if (!response.ok) return null;
            const next = (await response.json()) as AppUpstreamStateResponse;
            setState(next);
            return next;
        } catch {
            return null;
        }
    }, [workId]);

    useEffect(() => {
        if (pollMs === null) return;
        polls.current = 0;
        const interval = window.setInterval(async () => {
            if (polls.current >= pollMax) {
                window.clearInterval(interval);
                return;
            }
            polls.current += 1;
            const next = await refresh();
            if (next && next.readiness.state === 'ready') {
                window.clearInterval(interval);
                routerRef.current.refresh();
            }
        }, pollMs);
        return () => window.clearInterval(interval);
    }, [pollMs, pollMax, refresh]);

    if (readinessState === 'ready') return null;

    const relation = state.relation;
    const workRepo = `${state.dataRepository.owner}/${state.dataRepository.repo}`;
    const upstreamRepo = state.upstream
        ? `${state.upstream.owner}/${state.upstream.repo}`
        : workRepo;
    const outOfRetries =
        retryLimited || (state.readiness as { manualRetriesLeft?: number }).manualRetriesLeft === 0;

    const onRetry = async () => {
        setRetrying(true);
        setRetryFailed(false);
        try {
            const result = await retryUpstreamReadinessAction(workId);
            if (result.success) {
                setState((prev) => ({
                    ...prev,
                    readiness: { ...prev.readiness, state: 'preparing' },
                }));
            } else if (result.code === 'retry_limit_reached') {
                setRetryLimited(true);
            } else {
                setRetryFailed(true);
            }
        } catch {
            // A thrown action (network, server error) is a failure the member
            // must see, not a spinner that silently stops.
            setRetryFailed(true);
        } finally {
            setRetrying(false);
        }
    };

    const retryButton = (
        <div className="space-y-1">
            <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={onRetry}
                disabled={retrying || outOfRetries}
                loading={retrying}
                data-testid="app-source-retry"
            >
                {t('tryAgain')}
            </Button>
            {outOfRetries && (
                <p
                    className="text-xs text-text-muted dark:text-text-muted-dark"
                    data-testid="app-source-retry-limit"
                >
                    {t('retryLimit')}
                </p>
            )}
            {retryFailed && (
                <p className="text-xs text-red-600 dark:text-red-400">{t('retryFailed')}</p>
            )}
        </div>
    );

    let title: string;
    let body: string | null = null;
    let actions: ReactNode = null;
    let tone: 'progress' | 'warning' = 'progress';

    if (readinessState === 'preparing') {
        if (blueprintName) {
            title = t('preparing.blueprintTitle', { name: blueprintName });
            body = t('preparing.blueprintBody');
        } else if (relation === 'fork') {
            title = t('preparing.forkTitle');
            body = t('preparing.forkBody', { fullName: workRepo });
        } else if (relation === 'private-copy') {
            title = t('preparing.copyTitle');
            body = t('preparing.copyBody', { upstream: upstreamRepo, fullName: workRepo });
        } else {
            title = t('preparing.linkTitle');
            body = t('preparing.linkBody', { fullName: workRepo });
        }
    } else if (readinessState === 'waiting_for_setup_pr') {
        title = t('waitingForSetupPr');
        actions = state.readiness.setupPullRequestUrl ? (
            <a
                href={state.readiness.setupPullRequestUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="text-sm font-medium underline"
                data-testid="app-source-open-pr"
            >
                {t('openPullRequest')}
            </a>
        ) : null;
    } else if (readinessState === 'timed_out') {
        tone = 'warning';
        title = t('timedOut');
        actions = (
            <div className="flex flex-wrap items-start gap-3">
                {retryButton}
                <a
                    href={state.dataRepository.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="text-sm font-medium underline"
                >
                    {t('openOnGitHub')}
                </a>
            </div>
        );
    } else {
        tone = 'warning';
        const failure = appSourceFailureCopy(state.readiness);
        if (failure.kind === 'access') {
            title = t('failedAccess');
            actions = (
                <div className="flex flex-wrap items-start gap-3">
                    <Link
                        href={ROUTES.DASHBOARD_SETTINGS_CONNECTIONS}
                        className="text-sm font-medium underline"
                    >
                        {t('reconnectGitHub')}
                    </Link>
                    {retryButton}
                </div>
            );
        } else if (failure.kind === 'setupPrClosed') {
            title = t('setupPrClosed');
            actions = retryButton;
        } else {
            title = t('failedOther', {
                reason: t(`failedReasons.${failure.leaf}` as 'failedReasons.other'),
            });
            actions = retryButton;
        }
    }

    return (
        <section
            data-testid="app-source-status"
            data-state={readinessState}
            className={cn(
                'rounded-lg border p-4 space-y-2',
                tone === 'warning'
                    ? 'border-amber-300 bg-amber-50/60 dark:border-amber-700 dark:bg-amber-900/10'
                    : 'border-card-border bg-card dark:border-border-secondary-dark dark:bg-transparent',
            )}
        >
            <div className="flex items-start gap-2">
                {tone === 'warning' ? (
                    <AlertTriangle className="mt-0.5 h-4 w-4 text-amber-600" aria-hidden="true" />
                ) : (
                    <Loader2
                        className="mt-0.5 h-4 w-4 animate-spin text-text-secondary"
                        aria-hidden="true"
                    />
                )}
                <div className="space-y-1">
                    <h3
                        className="text-sm font-semibold text-text dark:text-text-dark"
                        role="status"
                    >
                        {title}
                    </h3>
                    {body && (
                        <p className="text-sm text-text-secondary dark:text-text-secondary-dark">
                            {body}
                        </p>
                    )}
                </div>
            </div>
            {actions}
        </section>
    );
}
