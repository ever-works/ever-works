'use client';

import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { formatCountdown } from './computer-session.shared';

/**
 * Agent computers — the prompts around handing control from one view to
 * another, both sides of it:
 *
 *  - {@link ComputerHeldElsewherePrompt} — shown to a view that cannot take
 *    over because another view has control: who, since when, and Request
 *    control; once asked, how long until the request declines on its own,
 *    and afterwards that it was not answered.
 *  - {@link ComputerIncomingRequestPrompt} — shown to the view holding
 *    control when another view asks: Hand over or Keep control, with the
 *    60-second countdown after which it declines on its own. Control never
 *    moves without an explicit Hand over.
 *  - {@link ComputerIdleWarningPrompt} — shown to the view holding control
 *    in the last 30 seconds before an idle give-back: Keep control or Give
 *    back.
 *
 * Each is an inline `alertdialog` over the stage rather than a modal, so it
 * never traps the keyboard of someone who is driving the computer. They are
 * layout only: the page decides when each is shown and what the buttons do.
 */

function ControlPrompt({
    testId,
    label,
    children,
    actions,
}: {
    testId: string;
    label: string;
    children: ReactNode;
    actions: ReactNode;
}) {
    return (
        <div
            role="alertdialog"
            aria-label={label}
            aria-live="assertive"
            data-testid={testId}
            className="absolute left-1/2 top-4 z-30 w-[min(28rem,calc(100%-2rem))] -translate-x-1/2 rounded-lg border border-border bg-surface p-4 text-sm text-text shadow-lg dark:border-border-dark dark:bg-surface-dark dark:text-text-dark"
        >
            <div className="flex flex-col gap-1">{children}</div>
            <div className="mt-3 flex flex-wrap justify-end gap-2">{actions}</div>
        </div>
    );
}

export function ComputerHeldElsewherePrompt({
    nodeName,
    holderIsYou,
    since,
    requestMsLeft,
    declined,
    busy,
    onRequest,
    onKeepWatching,
}: {
    nodeName: string;
    /** The holder is the same person, in another view. */
    holderIsYou: boolean;
    /** Formatted time the holder took control. */
    since: string;
    /** While this view's request waits: ms until it declines on its own. */
    requestMsLeft: number | null;
    /** This view's request ended without a hand-over. */
    declined: boolean;
    busy: boolean;
    onRequest: () => void;
    onKeepWatching: () => void;
}) {
    const t = useTranslations('dashboard.computer.control');
    return (
        <ControlPrompt
            testId="computer-held-elsewhere"
            label={t('promptLabel', { node: nodeName })}
            actions={
                <>
                    {requestMsLeft === null ? (
                        <Button size="sm" onClick={onRequest} disabled={busy}>
                            {t('requestControl')}
                        </Button>
                    ) : null}
                    <Button size="sm" variant="ghost" onClick={onKeepWatching}>
                        {t('keepWatching')}
                    </Button>
                </>
            }
        >
            <p className="font-medium">
                {holderIsYou
                    ? t('heldByYou', { time: since })
                    : t('heldBySomeone', { time: since })}
            </p>
            {requestMsLeft !== null ? (
                <p data-testid="computer-request-waiting">
                    {t('requestWaiting', { countdown: formatCountdown(requestMsLeft) })}
                </p>
            ) : declined ? (
                <p data-testid="computer-request-declined">{t('requestDeclined')}</p>
            ) : (
                <p>{t('heldByBody')}</p>
            )}
        </ControlPrompt>
    );
}

export function ComputerIncomingRequestPrompt({
    nodeName,
    requesterIsYou,
    msLeft,
    busy,
    onHandOver,
    onKeepControl,
}: {
    nodeName: string;
    requesterIsYou: boolean;
    /** Ms until the request declines on its own. */
    msLeft: number;
    busy: boolean;
    onHandOver: () => void;
    onKeepControl: () => void;
}) {
    const t = useTranslations('dashboard.computer.control');
    return (
        <ControlPrompt
            testId="computer-incoming-request"
            label={t('promptLabel', { node: nodeName })}
            actions={
                <>
                    <Button size="sm" onClick={onHandOver} disabled={busy}>
                        {t('handOver')}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={onKeepControl} disabled={busy}>
                        {t('keepControl')}
                    </Button>
                </>
            }
        >
            <p className="font-medium">
                {requesterIsYou
                    ? t('incomingRequestYou', { node: nodeName })
                    : t('incomingRequest', { node: nodeName })}
            </p>
            <p>{t('autoDeclines', { countdown: formatCountdown(msLeft) })}</p>
        </ControlPrompt>
    );
}

export function ComputerIdleWarningPrompt({
    nodeName,
    agentName,
    msLeft,
    waitingSince,
    busy,
    onKeepControl,
    onGiveBack,
}: {
    nodeName: string;
    agentName: string;
    /** Ms until control is given back for inactivity. */
    msLeft: number;
    /** Formatted time the Agent has been paused since. */
    waitingSince: string;
    busy: boolean;
    onKeepControl: () => void;
    onGiveBack: () => void;
}) {
    const t = useTranslations('dashboard.computer.control');
    return (
        <ControlPrompt
            testId="computer-idle-warning"
            label={t('promptLabel', { node: nodeName })}
            actions={
                <>
                    <Button size="sm" onClick={onKeepControl} disabled={busy}>
                        {t('keepControl')}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={onGiveBack} disabled={busy}>
                        {t('giveBackNow')}
                    </Button>
                </>
            }
        >
            <p className="font-medium">
                {t('idleWarning', { countdown: formatCountdown(msLeft) })}
            </p>
            <p>{t('idleWarningBody', { agent: agentName, time: waitingSince })}</p>
        </ControlPrompt>
    );
}
