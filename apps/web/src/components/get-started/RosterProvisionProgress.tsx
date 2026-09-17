'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle, Check, CircleDashed, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { getRosterState } from '@/app/actions/onboarding/roster';
import type { RosterStateResponse } from '@/lib/api/onboarding';
import type { LaneOutcome, RosterLaneResult } from '@ever-works/contracts/api';
import { RosterIntroduction } from './RosterIntroduction';

/** How often the panel asks what happened, while a run is still going. */
export const ROSTER_POLL_INTERVAL_MS = 2_000;
/** After this the panel stops asking and says so, rather than spinning forever. */
export const ROSTER_STALL_AFTER_MS = 150_000;

const IN_FLIGHT = new Set(['queued', 'creating', 'binding']);

export interface RosterProvisionProgressProps {
    readonly runId: string;
    /** Injected by specs; production polls for itself. */
    readonly initialState?: RosterStateResponse;
    readonly onRetry?: () => void;
    readonly onFinished?: () => void;
}

/**
 * AW-20 P1 — what provisioning is doing, lane by lane.
 *
 * The panel exists because a half-finished roster is the normal unhappy
 * case, not an exception: a plan runs out of seats on the third lane, a
 * name is taken, one skill will not attach. A spinner that resolves into
 * "something went wrong" would leave the user with agents they cannot
 * see and no way to finish the job. So every lane names its own outcome,
 * while the run is still going, and every terminal state offers the one
 * action that moves it forward.
 *
 * Polling stops at a terminal state, and stops after
 * {@link ROSTER_STALL_AFTER_MS} regardless: a panel that polls forever is
 * indistinguishable from one that is working, and only one of those is
 * honest.
 */
export function RosterProvisionProgress({
    runId,
    initialState,
    onRetry,
    onFinished,
}: RosterProvisionProgressProps) {
    const t = useTranslations('onboarding.provisioning');
    const [state, setState] = useState<RosterStateResponse | null>(initialState ?? null);
    const [stalled, setStalled] = useState(false);
    const [introOpen, setIntroOpen] = useState(false);
    const finishedRef = useRef(false);

    const record = state?.provisioning ?? null;
    const runState = record?.runId === runId ? record.state : (state?.state ?? 'queued');
    const inFlight = IN_FLIGHT.has(runState);

    const poll = useCallback(async () => {
        const result = await getRosterState();
        if (result.success && result.data) setState(result.data);
    }, []);

    useEffect(() => {
        if (initialState || !inFlight || stalled) return;
        let cancelled = false;
        const startedAt = Date.now();
        const timer = setInterval(() => {
            if (cancelled) return;
            if (Date.now() - startedAt >= ROSTER_STALL_AFTER_MS) {
                setStalled(true);
                clearInterval(timer);
                return;
            }
            void poll();
        }, ROSTER_POLL_INTERVAL_MS);
        return () => {
            cancelled = true;
            clearInterval(timer);
        };
    }, [inFlight, initialState, poll, stalled]);

    useEffect(() => {
        if (inFlight || finishedRef.current) return;
        finishedRef.current = true;
        onFinished?.();
    }, [inFlight, onFinished]);

    const lanes: readonly RosterLaneResult[] = record?.lanes ?? [];
    const done = lanes.filter(
        (lane) => lane.outcome === 'created' || lane.outcome === 'reused',
    ).length;
    const total = lanes.length;

    // Declared here rather than at module scope so they keep next-intl's
    // inferred key typing: a message key that does not exist is a compile
    // error, not a MISSING_MESSAGE in front of a new user.
    const headline = (): string => {
        if (stalled) return t('stalledTitle');
        if (runState === 'failed') return t('failedTitle');
        if (runState === 'ready') return t('readyTitle');
        return t('working');
    };

    /**
     * What one lane's row says. A lane still `pending` while the run is in
     * flight is being worked on; the same lane after the run ended was
     * never reached — different facts, different words.
     */
    const outcomeLabel = (lane: RosterLaneResult): string => {
        if (lane.outcome === 'created') {
            return lane.finalName
                ? t('renamed', { finalName: lane.finalName, requestedName: lane.requestedName })
                : t('outcomes.created');
        }
        if (lane.outcome === 'reused') return t('outcomes.reused');
        if (lane.outcome === 'skippedNoSeat') return t('outcomes.skippedNoSeat');
        if (lane.outcome === 'failed') {
            switch (lane.failureReason) {
                case 'nameUnavailable':
                    return t('failures.nameUnavailable');
                case 'noSeat':
                    return t('failures.noSeat');
                case 'permissionDenied':
                    return t('failures.permissionDenied');
                case 'timedOut':
                    return t('failures.timedOut');
                default:
                    return t('failures.unknown');
            }
        }
        if (runState === 'binding') return t('outcomes.binding');
        if (IN_FLIGHT.has(runState)) return t('outcomes.working');
        return t('outcomes.pending');
    };

    return (
        <div
            className="space-y-5 max-w-3xl"
            aria-live="polite"
            data-testid="roster-provision-progress"
        >
            <header>
                <h3 className="text-lg font-semibold text-text dark:text-text-dark">
                    {headline()}
                </h3>
                <p
                    className="mt-1 text-sm text-text-muted dark:text-text-muted-dark tabular-nums"
                    data-testid="roster-provision-counter"
                >
                    {t('progress', { done, total })}
                </p>
            </header>

            <ul className="space-y-1.5" data-testid="roster-provision-lanes">
                {lanes.map((lane) => (
                    <li
                        key={lane.laneKey}
                        data-testid={`roster-provision-lane-${lane.laneKey}`}
                        className="flex items-center justify-between gap-3 rounded-lg border border-border dark:border-border-dark px-3 py-2 text-sm"
                    >
                        <span className="flex items-center gap-2 text-text dark:text-text-dark">
                            <OutcomeIcon outcome={lane.outcome} />
                            {lane.finalName ?? lane.requestedName}
                        </span>
                        <span className="text-xs text-text-muted dark:text-text-muted-dark text-right">
                            {outcomeLabel(lane)}
                        </span>
                    </li>
                ))}
            </ul>

            {inFlight && !stalled ? (
                <p className="text-xs text-text-muted dark:text-text-muted-dark">{t('hint')}</p>
            ) : null}

            {stalled ? (
                <div className="space-y-2" data-testid="roster-provision-stalled">
                    <p className="text-sm text-text dark:text-text-dark">{t('stalledTitle')}</p>
                    <p className="text-xs text-text-muted dark:text-text-muted-dark">
                        {t('stalledBody', { done, total })}
                    </p>
                    <div className="flex gap-2">
                        <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => {
                                setStalled(false);
                                void poll();
                            }}
                        >
                            {t('keepWaiting')}
                        </Button>
                        <Button size="sm" onClick={() => onRetry?.()}>
                            {t('retry')}
                        </Button>
                    </div>
                </div>
            ) : null}

            {!inFlight && !stalled && runState === 'partial' ? (
                <div className="space-y-2" data-testid="roster-provision-partial">
                    <p className="text-sm text-text dark:text-text-dark">
                        {t('partialTitle', { done, total })}
                    </p>
                    <p className="text-xs text-text-muted dark:text-text-muted-dark">
                        {t('partialBody', { remaining: Math.max(0, total - done) })}
                    </p>
                    <div className="flex gap-2">
                        <Button size="sm" variant="secondary" onClick={() => onRetry?.()}>
                            {t('finishNow')}
                        </Button>
                    </div>
                </div>
            ) : null}

            {!inFlight && !stalled && runState === 'failed' ? (
                <div className="space-y-2" data-testid="roster-provision-failed">
                    <p className="text-sm text-text dark:text-text-dark">{t('failedTitle')}</p>
                    <p className="text-xs text-text-muted dark:text-text-muted-dark">
                        {t('failedBody')}
                    </p>
                    <Button size="sm" onClick={() => onRetry?.()}>
                        {t('retry')}
                    </Button>
                </div>
            ) : null}

            {!inFlight && !stalled && (runState === 'ready' || runState === 'partial') ? (
                <Button
                    size="sm"
                    data-testid="roster-provision-open-intro"
                    onClick={() => setIntroOpen(true)}
                >
                    {t('meetThem')}
                </Button>
            ) : null}

            <RosterIntroduction
                open={introOpen}
                agents={state?.agents ?? []}
                onClose={() => setIntroOpen(false)}
            />
        </div>
    );
}

function OutcomeIcon({ outcome }: { readonly outcome: LaneOutcome }) {
    if (outcome === 'created' || outcome === 'reused') {
        return <Check className="h-4 w-4 shrink-0" aria-hidden />;
    }
    if (outcome === 'skippedNoSeat') {
        return <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />;
    }
    if (outcome === 'failed') return <X className="h-4 w-4 shrink-0" aria-hidden />;
    return <CircleDashed className="h-4 w-4 shrink-0 animate-pulse" aria-hidden />;
}
