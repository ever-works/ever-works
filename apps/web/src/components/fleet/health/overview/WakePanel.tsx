'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
    FLEET_WAKE_CHECK_AFTER_MS,
    type FleetNodeWakeAvailability,
    type FleetNodeWakeResult,
    type FleetNodeWakeStatus,
    type FleetWakeUnavailableReason,
} from '@ever-works/contracts';
import { Button } from '@/components/ui/button';
import { SHORTCUT_PRIORITY } from '@/lib/keyboard/shortcut-registry';
import { useShortcut } from '@/lib/hooks/use-shortcut';
import { cn } from '@/lib/utils/cn';
import { relativeTimeParts } from '@/components/dashboard/runner-status.shared';
import { useNow } from '../use-now';

/** What a wake or a status read answered: the data, or the hint to show. */
export type WakeOutcome<T> = { ok: true; data: T } | { ok: false; error: string };

export interface WakePanelProps {
    node: { id: string; name: string };
    /** The health read's `wake`: whether THIS viewer can wake it, and why not. */
    availability: FleetNodeWakeAvailability;
    /** Send the wake (`POST /nodes/:id/wake`). */
    sendWake: (nodeId: string) => Promise<WakeOutcome<FleetNodeWakeResult>>;
    /** Ask whether it came back (`GET /nodes/:id/wake`). */
    readStatus: (nodeId: string) => Promise<WakeOutcome<FleetNodeWakeStatus>>;
    /** The computer answered: the page reads its health again. */
    onBack?: () => void;
    /** Injectable timers (tests use fake ones). */
    setTimer?: (callback: () => void, ms: number) => unknown;
    clearTimer?: (handle: unknown) => void;
}

// Module-level, so the defaults keep one identity across renders: the timer
// cleanup below runs only on unmount, never because a parent re-rendered.
const defaultSetTimer = (callback: () => void, ms: number): unknown => setTimeout(callback, ms);
const defaultClearTimer = (handle: unknown): void => clearTimeout(handle as ReturnType<typeof setTimeout>);

/**
 * Where a wake is:
 *  - `idle` — nothing sent (or a refusal to show);
 *  - `sending` — asking the sibling;
 *  - `listening` — sent through `via`, watching for the computer's next beat;
 *  - `not-yet` — the 20 s check found nothing, still listening to 60 s;
 *  - `back` — it checked in after the wake;
 *  - `no-answer` — 60 s and nothing: it may be powered off or on another network.
 */
export type WakePhase = 'idle' | 'sending' | 'listening' | 'not-yet' | 'back' | 'no-answer';

const REASON_KEYS = {
    'no-sibling': 'noSibling',
    'no-hardware-address': 'noHardwareAddress',
    'rate-limited': 'rateLimited',
    'not-allowed': 'notAllowed',
    'kill-switch': 'killSwitch',
} as const satisfies Record<Exclude<FleetWakeUnavailableReason, 'not-offline'>, string>;

/**
 * Computer health, second phase (FL-03, spec S7, §5.5, U4, U6, U7) — Wake an
 * offline computer through a sibling on its network.
 *
 * Shown only for an offline computer (the health read says `not-offline`
 * otherwise and the page renders nothing). Disabled, the button carries its
 * reason (`aria-describedby`): no online computer on its network, no hardware
 * address reported, already tried 3 times, the viewer outside the `machines`
 * family, or all computers stopped. Pressed, it sends through the sibling and
 * then asks at 20 s and 60 s whether the computer checked in (FR-26): "back",
 * "has not answered yet", or "has not answered — it may be powered off or on
 * another network" with Try again. `W` presses it.
 */
export function WakePanel({
    node,
    availability,
    sendWake,
    readStatus,
    onBack,
    setTimer = defaultSetTimer,
    clearTimer = defaultClearTimer,
}: WakePanelProps) {
    const t = useTranslations('fleet.wake');
    const tHealth = useTranslations('fleet.health');
    const reasonId = useId();
    const now = useNow();
    const [phase, setPhase] = useState<WakePhase>('idle');
    const [via, setVia] = useState<string | null>(availability.via?.name ?? null);
    const [error, setError] = useState<string | null>(null);
    const timers = useRef<unknown[]>([]);
    const alive = useRef(true);

    // The latest clear, read through a ref so neither the unmount cleanup nor
    // the checkpoints depend on the caller passing a stable function.
    const clearTimerRef = useRef(clearTimer);
    useEffect(() => {
        clearTimerRef.current = clearTimer;
    });
    const clearAll = useCallback(() => {
        for (const handle of timers.current) clearTimerRef.current(handle);
        timers.current = [];
    }, []);

    useEffect(() => {
        alive.current = true;
        return () => {
            alive.current = false;
            clearAll();
        };
    }, [clearAll]);

    const check = useCallback(
        async (final: boolean) => {
            const status = await readStatus(node.id);
            if (!alive.current) return;
            if (status.ok && status.data.answered) {
                clearAll();
                setPhase('back');
                onBack?.();
                return;
            }
            setPhase(final ? 'no-answer' : 'not-yet');
        },
        [clearAll, node.id, onBack, readStatus],
    );

    const busy = phase === 'sending' || phase === 'listening' || phase === 'not-yet';
    const enabled = availability.available && !busy;

    const wake = useCallback(async () => {
        if (!enabled) return;
        clearAll();
        setError(null);
        setPhase('sending');
        const result = await sendWake(node.id);
        if (!alive.current) return;
        if (!result.ok) {
            setError(result.error);
            setPhase('idle');
            return;
        }
        setVia(result.data.via.name);
        setPhase('listening');
        const checkpoints = result.data.checkAfterMs.length > 0 ? result.data.checkAfterMs : FLEET_WAKE_CHECK_AFTER_MS;
        checkpoints.forEach((ms, index) => {
            timers.current.push(setTimer(() => void check(index === checkpoints.length - 1), ms));
        });
    }, [check, clearAll, enabled, node.id, sendWake, setTimer]);

    useShortcut(
        {
            id: 'fleet.computer.wake',
            scope: 'fleet-computer',
            priority: SHORTCUT_PRIORITY.screen,
            enabled,
        },
        (event) =>
            event.key.toLowerCase() === 'w' && !event.ctrlKey && !event.metaKey && !event.altKey,
        () => void wake(),
    );

    if (availability.reason === 'not-offline' && phase === 'idle') return null;

    const disabledReason =
        !availability.available && availability.reason && availability.reason !== 'not-offline'
            ? t(`reasons.${REASON_KEYS[availability.reason]}`, { name: node.name })
            : null;
    const lastAttempt = availability.lastWakeAttemptAt
        ? relativeTimeParts(availability.lastWakeAttemptAt, now)
        : null;

    let line: string | null = null;
    if (phase === 'sending' || phase === 'listening') {
        line = t('waking', { via: via ?? '…', name: node.name });
    } else if (phase === 'not-yet') {
        line = t('notYet', { name: node.name });
    } else if (phase === 'back') {
        line = t('back', { name: node.name });
    } else if (phase === 'no-answer') {
        line = t('noAnswer', { name: node.name });
    } else if (error) {
        line = t('failed', { hint: error });
    } else if (disabledReason) {
        line = disabledReason;
    } else if (availability.via) {
        line = t('canWakeFrom', { via: availability.via.name });
    } else if (availability.available) {
        line = t('canWake');
    }

    return (
        <section
            aria-label={t('regionLabel', { name: node.name })}
            className="flex flex-wrap items-center gap-2"
            data-testid="fleet-wake-panel"
            data-phase={phase}
        >
            <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={!enabled}
                onClick={() => void wake()}
                aria-describedby={reasonId}
                aria-keyshortcuts={enabled ? 'W' : undefined}
                aria-busy={busy ? 'true' : undefined}
                data-testid="fleet-wake-button"
            >
                {phase === 'no-answer' || (error && phase === 'idle') ? t('tryAgain') : t('button')}
            </Button>
            <span
                id={reasonId}
                className={cn(
                    'text-xs text-text-muted dark:text-text-muted-dark',
                    error && phase === 'idle' && 'text-danger dark:text-danger',
                )}
                aria-live="polite"
                role={error && phase === 'idle' ? 'alert' : undefined}
                data-testid="fleet-wake-line"
            >
                {line}
            </span>
            {lastAttempt && phase === 'idle' ? (
                <span className="text-xs text-text-muted dark:text-text-muted-dark">
                    {t('lastAttempt', {
                        relative: tHealth(`relative.${lastAttempt.unit}`, { value: lastAttempt.value }),
                    })}
                </span>
            ) : null}
        </section>
    );
}
