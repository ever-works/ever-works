'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Hand } from 'lucide-react';
import type {
    ComputerControlStateView,
    FleetDesktopControlAvailability,
} from '@ever-works/contracts';
import { Button } from '@/components/ui/button';
import { formatCountdown, idleWarningMs, msUntil } from '../../computer/computer-session.shared';
import { desktopControlStatus } from './desktop.shared';

/**
 * Desktop view & control (FL-07 P2, FR-36, FR-37, FR-42) — the control strip
 * under a live desktop:
 *
 * ```
 * ✋ YOU  You have control of build-01.   Gives back in 9:41 without input   [Extend] [Give back control]
 * Not sent: Ctrl/⌘+C · Ctrl/⌘+X · … · Ctrl+Alt+Delete · ⌘/Win
 * ```
 *
 * Taking control is explicit: a button, then a confirmation naming the
 * computer and what control means (CONTRACTS §2.2 `confirm`). When the
 * computer cannot be controlled the button stays off and the strip says why
 * (the owner has not allowed it on the machine, macOS Accessibility…). Another
 * person's hold offers Request control; a request to this view offers Hand
 * over or Keep control, with the minute after which it declines on its own.
 * Layout only: the tab decides what each button does.
 */
export function DesktopControlBar({
    nodeName,
    state,
    availability,
    busy,
    nowMs,
    serverOffsetMs,
    refusal,
    onTake,
    onRequest,
    onGiveBack,
    onKeep,
    onExtend,
    onAnswer,
}: {
    nodeName: string;
    state: ComputerControlStateView | null;
    availability: FleetDesktopControlAvailability | undefined;
    busy: boolean;
    nowMs: number;
    serverOffsetMs: number;
    refusal: string | null;
    onTake: () => void;
    onRequest: () => void;
    onGiveBack: () => void;
    onKeep: () => void;
    onExtend: () => void;
    onAnswer: (decision: 'hand-over' | 'keep') => void;
}) {
    const t = useTranslations('fleet.desktop.control');
    // What the confirmation will do once accepted: take control, or ask for it (a hand-over gives it).
    const [confirming, setConfirming] = useState<'take' | 'request' | null>(null);
    const status = desktopControlStatus(state);
    const controlling = status === 'controlling';
    const canTake = Boolean(availability?.available && state?.canControl);
    const idleLeft = idleWarningMs(state, nowMs, serverOffsetMs);
    const idleAt = controlling ? msUntil(state?.holder?.idleAt, nowMs, serverOffsetMs) : null;
    const requestLeft = state?.request
        ? msUntil(state.request.expiresAt, nowMs, serverOffsetMs)
        : null;
    const incoming = controlling && state?.request && !state.request.you && (requestLeft ?? 0) > 0;
    const waiting = !controlling && state?.request?.you && (requestLeft ?? 0) > 0;

    return (
        <div
            className={`flex flex-col gap-2 rounded-md border px-3 py-2 text-sm ${
                controlling ? 'border-amber-500 bg-amber-50 dark:bg-amber-950/30' : 'border-border'
            }`}
            data-testid="desktop-control"
        >
            <div className="flex flex-wrap items-center gap-2">
                {controlling ? (
                    <span
                        className="inline-flex items-center gap-1 rounded bg-amber-500 px-2 py-0.5 text-xs font-bold text-white"
                        data-testid="desktop-control-you"
                    >
                        <Hand className="h-3 w-3" aria-hidden="true" />
                        {t('you')}
                    </span>
                ) : null}
                <span role="status" data-testid="desktop-control-status">
                    {t(`status.${status}`, { name: nodeName })}
                </span>
                {controlling && idleAt !== null ? (
                    <span className="text-xs text-muted-foreground">
                        {t('idleIn', { countdown: formatCountdown(idleAt) })}
                    </span>
                ) : null}
                <span className="ml-auto flex flex-wrap gap-2">
                    {controlling ? (
                        <>
                            {state?.holder && !state.holder.extended ? (
                                <Button
                                    type="button"
                                    size="sm"
                                    variant="secondary"
                                    disabled={busy}
                                    onClick={onExtend}
                                >
                                    {t('extend')}
                                </Button>
                            ) : null}
                            <Button
                                type="button"
                                size="sm"
                                variant="danger"
                                disabled={busy}
                                onClick={onGiveBack}
                                data-testid="desktop-control-give-back"
                            >
                                {t('giveBack')}
                            </Button>
                        </>
                    ) : status === 'other' ? (
                        <Button
                            type="button"
                            size="sm"
                            variant="secondary"
                            disabled={busy || Boolean(waiting) || !availability?.available}
                            onClick={() => setConfirming('request')}
                        >
                            {waiting
                                ? t('requestWaiting', {
                                      countdown: formatCountdown(requestLeft ?? 0),
                                  })
                                : t('request')}
                        </Button>
                    ) : (
                        <Button
                            type="button"
                            size="sm"
                            disabled={busy || !canTake}
                            onClick={() => setConfirming('take')}
                            data-testid="desktop-control-take"
                        >
                            {t('take')}
                        </Button>
                    )}
                </span>
            </div>

            {!controlling && availability && !availability.available && availability.hint ? (
                <p
                    className="text-xs text-muted-foreground"
                    data-testid="desktop-control-unavailable"
                >
                    {availability.hint}
                </p>
            ) : null}
            {!controlling && state && !state.canControl && availability?.available ? (
                <p className="text-xs text-muted-foreground">
                    {t('notInAudience', { name: nodeName })}
                </p>
            ) : null}
            {refusal ? (
                <p className="text-xs text-destructive" role="alert">
                    {refusal}
                </p>
            ) : null}

            {confirming && !controlling ? (
                <div
                    role="alertdialog"
                    aria-label={t('confirm.title', { name: nodeName })}
                    className="rounded-md border border-border p-3"
                >
                    <p className="font-medium">{t('confirm.title', { name: nodeName })}</p>
                    <p className="mt-1 text-muted-foreground">
                        {t('confirm.body', { name: nodeName })}
                    </p>
                    <div className="mt-2 flex gap-2">
                        <Button
                            type="button"
                            size="sm"
                            disabled={busy}
                            onClick={() => {
                                const act = confirming;
                                setConfirming(null);
                                if (act === 'request') onRequest();
                                else onTake();
                            }}
                            data-testid="desktop-control-confirm"
                        >
                            {t('confirm.yes')}
                        </Button>
                        <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            onClick={() => setConfirming(null)}
                        >
                            {t('confirm.no')}
                        </Button>
                    </div>
                </div>
            ) : null}

            {incoming ? (
                <div
                    role="alertdialog"
                    aria-label={t('incoming', { name: nodeName })}
                    className="rounded-md border border-amber-500 p-3"
                >
                    <p className="font-medium">{t('incoming', { name: nodeName })}</p>
                    <p className="text-xs text-muted-foreground">
                        {t('autoDeclines', { countdown: formatCountdown(requestLeft ?? 0) })}
                    </p>
                    <div className="mt-2 flex gap-2">
                        <Button
                            type="button"
                            size="sm"
                            disabled={busy}
                            onClick={() => onAnswer('hand-over')}
                        >
                            {t('handOver')}
                        </Button>
                        <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            disabled={busy}
                            onClick={() => onAnswer('keep')}
                        >
                            {t('keepControl')}
                        </Button>
                    </div>
                </div>
            ) : null}

            {controlling && idleLeft !== null ? (
                <div
                    role="alertdialog"
                    aria-label={t('idleWarning', { countdown: formatCountdown(idleLeft) })}
                    className="rounded-md border border-amber-500 p-3"
                >
                    <p className="font-medium">
                        {t('idleWarning', { countdown: formatCountdown(idleLeft) })}
                    </p>
                    <div className="mt-2 flex gap-2">
                        <Button type="button" size="sm" disabled={busy} onClick={onKeep}>
                            {t('keepControl')}
                        </Button>
                        <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            disabled={busy}
                            onClick={onGiveBack}
                        >
                            {t('giveBack')}
                        </Button>
                    </div>
                </div>
            ) : null}

            {controlling ? (
                <p className="text-xs text-muted-foreground" data-testid="desktop-control-blocked">
                    {t('blocked', { list: (availability?.blockedShortcuts ?? []).join(' · ') })}
                </p>
            ) : null}
        </div>
    );
}
