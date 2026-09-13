'use client';

import { useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Hourglass, Monitor, OctagonX, WifiOff } from 'lucide-react';
import type {
    ComputerChannel,
    ComputerNodeOption,
    ComputerSessionHolderView,
} from '@ever-works/contracts';
import { Button } from '@/components/ui/button';
import { ShowDateTime } from '@/components/ui/show-datetime';
import { relativeTimeParts } from '@/components/dashboard/runner-status.shared';
import { ROUTES } from '@/lib/constants';

/**
 * Every state the computer page shows instead of a picture, each with the
 * one thing the owner can do about it. The page decides WHICH state (see
 * `computer-session.shared.ts`); this is the copy and the buttons.
 */

function Card({
    icon,
    title,
    testId,
    children,
}: {
    icon: ReactNode;
    title: string;
    testId: string;
    children?: ReactNode;
}) {
    return (
        <div
            data-testid={testId}
            className="mx-auto flex max-w-xl flex-col items-center gap-3 rounded-xl border border-border/60 bg-card px-6 py-10 text-center dark:border-border-dark/60 dark:bg-card-primary-dark"
        >
            <div className="text-text-muted dark:text-text-muted-dark" aria-hidden>
                {icon}
            </div>
            <h2 className="text-base font-semibold text-text dark:text-text-dark">{title}</h2>
            {children}
        </div>
    );
}

const bodyClass = 'max-w-md text-sm text-text-secondary dark:text-text-secondary-dark';

export function ComputerEmptyState({ agentName }: { agentName: string }) {
    const t = useTranslations('dashboard.computer.empty');
    return (
        <Card
            testId="computer-empty"
            icon={<Monitor className="h-8 w-8" />}
            title={t('title', { agent: agentName })}
        >
            <p className={bodyClass}>{t('body', { agent: agentName })}</p>
            <div className="flex flex-wrap justify-center gap-2">
                <Button size="sm" href={ROUTES.DASHBOARD_SETTINGS_FLEET}>
                    {t('addComputer')}
                </Button>
                <Button
                    size="sm"
                    variant="ghost"
                    href="https://docs.ever.works/docs"
                    target="_blank"
                    rel="noreferrer"
                >
                    {t('howItWorks')}
                </Button>
            </div>
        </Card>
    );
}

export function ComputerOfflineState({
    node,
    onTryAgain,
    onPickAnother,
    now,
}: {
    node: ComputerNodeOption;
    onTryAgain: () => void;
    onPickAnother: () => void;
    now?: number;
}) {
    const t = useTranslations('dashboard.computer.offline');
    const tRelative = useTranslations('dashboard.runner.relative');
    const relative = relativeTimeParts(node.lastHeartbeatAt, now);
    return (
        <Card
            testId="computer-offline"
            icon={<WifiOff className="h-8 w-8" />}
            title={t('title', { node: node.name })}
        >
            <p className={bodyClass}>
                {relative
                    ? t('lastSeen', {
                          relative: tRelative(relative.unit, { value: relative.value }),
                      })
                    : t('lastSeenNever')}
                {node.lastHeartbeatAt ? (
                    <span className="ml-1">
                        (<ShowDateTime value={node.lastHeartbeatAt} />)
                    </span>
                ) : null}
            </p>
            <p className={bodyClass}>{t('hint')}</p>
            <div className="flex flex-wrap justify-center gap-2">
                <Button size="sm" onClick={onTryAgain}>
                    {t('tryAgain')}
                </Button>
                <Button size="sm" variant="ghost" onClick={onPickAnother}>
                    {t('pickAnother')}
                </Button>
            </div>
        </Card>
    );
}

export function ComputerNotAttendedState({
    nodeName,
    abandoned,
    onTryAgain,
    onPickAnother,
}: {
    nodeName: string;
    /** True when a view was asked for and nobody picked it up (vs. known to be off). */
    abandoned?: boolean;
    onTryAgain: () => void;
    onPickAnother: () => void;
}) {
    const t = useTranslations('dashboard.computer.notAttended');
    const tOffline = useTranslations('dashboard.computer.offline');
    const [copied, setCopied] = useState(false);
    const command = t('command');
    return (
        <Card
            testId="computer-not-attended"
            icon={<Hourglass className="h-8 w-8" />}
            title={
                abandoned ? t('abandonedTitle', { node: nodeName }) : t('title', { node: nodeName })
            }
        >
            <p className={bodyClass}>{t('body')}</p>
            <div className="flex items-center gap-2 rounded-md bg-surface-secondary px-3 py-2 font-mono text-xs dark:bg-surface-secondary-dark">
                <code data-testid="computer-attend-command">{command}</code>
                <button
                    type="button"
                    className="rounded border border-border px-1.5 py-0.5 font-sans dark:border-border-dark"
                    onClick={() => {
                        void navigator.clipboard?.writeText(command).then(
                            () => setCopied(true),
                            () => undefined,
                        );
                    }}
                >
                    {copied ? t('copied') : t('copy')}
                </button>
            </div>
            <div className="flex flex-wrap justify-center gap-2">
                <Button size="sm" onClick={onTryAgain}>
                    {tOffline('tryAgain')}
                </Button>
                <Button size="sm" variant="ghost" onClick={onPickAnother}>
                    {tOffline('pickAnother')}
                </Button>
            </div>
        </Card>
    );
}

export function ComputerCannotShowState({
    agentName,
    nodeName,
    channel,
    reason,
    alternative,
    onWatchChannel,
    onPickAnother,
}: {
    agentName: string;
    nodeName: string;
    channel: ComputerChannel;
    reason: string;
    alternative: ComputerChannel | null;
    onWatchChannel: (channel: ComputerChannel) => void;
    onPickAnother: () => void;
}) {
    const t = useTranslations('dashboard.computer.cannotShow');
    const tOffline = useTranslations('dashboard.computer.offline');
    const variant =
        channel === 'terminal' || reason === 'no-terminal'
            ? 'noTerminal'
            : reason === 'no-display'
              ? 'noDisplay'
              : 'noBrowser';
    return (
        <Card
            testId="computer-cannot-show"
            icon={<OctagonX className="h-8 w-8" />}
            title={t(`${variant}Title`, { node: nodeName })}
        >
            <p className={bodyClass}>{t(`${variant}Body`, { agent: agentName, node: nodeName })}</p>
            <div className="flex flex-wrap justify-center gap-2">
                {alternative ? (
                    <Button size="sm" onClick={() => onWatchChannel(alternative)}>
                        {alternative === 'terminal'
                            ? t('watchTerminalInstead')
                            : t('watchScreenInstead')}
                    </Button>
                ) : null}
                <Button size="sm" variant="ghost" onClick={onPickAnother}>
                    {tOffline('pickAnother')}
                </Button>
            </div>
        </Card>
    );
}

export function ComputerUnwatchableState({
    nodeName,
    reason,
    onPickAnother,
}: {
    nodeName: string;
    reason: 'paused' | 'disabled' | 'draining' | 'cluster';
    onPickAnother: () => void;
}) {
    const t = useTranslations('dashboard.computer.unwatchable');
    const tOffline = useTranslations('dashboard.computer.offline');
    return (
        <Card
            testId="computer-unwatchable"
            icon={<OctagonX className="h-8 w-8" />}
            title={t('title', { node: nodeName })}
        >
            <p className={bodyClass}>{t(reason, { node: nodeName })}</p>
            <Button size="sm" variant="ghost" onClick={onPickAnother}>
                {tOffline('pickAnother')}
            </Button>
        </Card>
    );
}

export function ComputerStoppedBanner({
    reason,
    since,
}: {
    reason: string | null;
    since: string | null;
}) {
    const t = useTranslations('dashboard.computer.stopped');
    return (
        <div
            data-testid="computer-stopped"
            role="alert"
            className="mx-auto max-w-2xl rounded-lg border border-danger/30 bg-danger/5 px-4 py-3 text-sm"
        >
            <p className="font-medium text-danger">
                {reason
                    ? t('banner', { reason, time: since ?? '—' })
                    : t('bannerNoReason', { time: since ?? '—' })}
            </p>
            <p className="text-text-secondary dark:text-text-secondary-dark">{t('body')}</p>
        </div>
    );
}

export function ComputerOverLimitState({
    nodeName,
    scope,
    limit,
    sessions,
    onPickAnother,
}: {
    nodeName: string;
    scope: 'node' | 'organization';
    limit: number;
    sessions: ComputerSessionHolderView[];
    onPickAnother: () => void;
}) {
    const t = useTranslations('dashboard.computer.overLimit');
    return (
        <Card
            testId="computer-over-limit"
            icon={<Monitor className="h-8 w-8" />}
            title={
                scope === 'node'
                    ? t('title', { node: nodeName, count: limit })
                    : t('titleOrganization', { count: limit })
            }
        >
            {sessions.length > 0 ? (
                <ul className="text-sm text-text-secondary dark:text-text-secondary-dark">
                    {sessions.map((session) => (
                        <li key={session.sessionId}>
                            {t('rowWatching', { time: session.since ?? '—' })}
                        </li>
                    ))}
                </ul>
            ) : null}
            <p className={bodyClass}>{t('body')}</p>
            <Button size="sm" variant="ghost" onClick={onPickAnother}>
                {t('pickAnother')}
            </Button>
        </Card>
    );
}

export function ComputerConnectingState({
    nodeName,
    slow,
    onCancel,
}: {
    nodeName: string;
    slow: boolean;
    onCancel: () => void;
}) {
    const t = useTranslations('dashboard.computer.connecting');
    return (
        <div
            data-testid="computer-connecting"
            role="status"
            className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-sm text-white"
        >
            <span
                className="h-5 w-5 animate-spin rounded-full border-2 border-white/30 border-t-white"
                aria-hidden
            />
            <span className="font-medium">{t('title')}</span>
            <span className="text-white/75">
                {slow ? t('slow', { node: nodeName }) : t('subtitle', { node: nodeName })}
            </span>
            <button
                type="button"
                onClick={onCancel}
                className="mt-2 rounded border border-white/30 px-3 py-1 text-xs hover:bg-white/10"
            >
                {t('cancel')}
            </button>
        </div>
    );
}

export function ComputerMessageState({
    testId,
    title,
    body,
    actionLabel,
    onAction,
}: {
    testId: string;
    title: string;
    body?: string | null;
    actionLabel?: string;
    onAction?: () => void;
}) {
    return (
        <Card testId={testId} icon={<Monitor className="h-8 w-8" />} title={title}>
            {body ? <p className={bodyClass}>{body}</p> : null}
            {actionLabel && onAction ? (
                <Button size="sm" onClick={onAction}>
                    {actionLabel}
                </Button>
            ) : null}
        </Card>
    );
}
