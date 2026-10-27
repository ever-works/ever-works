'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Folder, Laptop } from 'lucide-react';
import {
    isFleetSessionLive,
    type FleetCheckoutView,
    type FleetSessionView,
} from '@ever-works/contracts';
import { Link, useRouter } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import type { Task } from '@/lib/api/tasks';
import { cn } from '@/lib/utils/cn';
import { TaskPrPill } from '@/components/tasks/TaskPrPill';
import { GitLine } from '../checkouts/GitLine';
import { FLEET_TONE_DOT_CLASS } from '../fleet-hub.shared';
import { useNow } from '../health/use-now';
import { SessionEndDialog } from '../sessions/SessionEndDialog';
import { sessionElapsed, sessionStateGlyph } from '../sessions/sessions.shared';
import { taskComputerAgo } from './task-fleet-block.shared';

/**
 * Tasks on computers (FL-15 P1, spec FR-9, §5.1) — the **Computer** block's
 * four states: empty ("No session on a computer yet"), live (computer ·
 * Agent · state glyph and elapsed, Open / End), ended ("ended 2 h ago", the
 * checkout and the pull request kept), and offline (the computer dimmed with
 * its age). Every part is a link: the computer page, the Agent, the session
 * page, the checkout's computer tab, the pull request.
 */
export function TaskFleetBlock({
    task,
    session,
    nodeName,
    nodeOnline,
    nodeLastSeenAt,
    agentName,
    checkout,
}: {
    task: Task;
    session: FleetSessionView | null;
    nodeName: string | null;
    nodeOnline: boolean;
    nodeLastSeenAt: string | null;
    agentName: string | null;
    checkout: FleetCheckoutView | null;
}) {
    const t = useTranslations('fleet.taskHandoff.block');
    const tStates = useTranslations('fleet.sessions.states');
    const router = useRouter();
    const now = useNow(30_000);
    const [ending, setEnding] = useState(false);

    const node = nodeName ?? t('unknownNode');
    const agent = agentName ?? t('unknownAgent');
    const live = session ? isFleetSessionLive(session.state) : false;

    const renderSession = (current: FleetSessionView) => {
        const glyph = sessionStateGlyph(current.state);
        const elapsed = sessionElapsed(current, new Date(now));
        const endedAgo = current.endedAt ? taskComputerAgo(current.endedAt, now) : null;
        const lastSeenAgo = nodeLastSeenAt ? taskComputerAgo(nodeLastSeenAt, now) : null;
        return (
            <div className="space-y-2 text-sm">
                <div
                    className={cn(
                        'flex flex-wrap items-center gap-x-2 gap-y-1',
                        !nodeOnline && 'opacity-70',
                    )}
                >
                    <Link
                        href={ROUTES.DASHBOARD_FLEET_COMPUTER(current.nodeId)}
                        className="font-medium text-text dark:text-text-dark hover:underline"
                    >
                        {node}
                    </Link>
                    <span className="text-text-muted">·</span>
                    {current.agentId ? (
                        <Link
                            href={ROUTES.DASHBOARD_AGENT(current.agentId)}
                            className="hover:underline"
                        >
                            {agent}
                        </Link>
                    ) : (
                        <span>{agent}</span>
                    )}
                    <span className="text-text-muted">·</span>
                    {live ? (
                        <span
                            className="inline-flex items-center gap-1.5"
                            data-testid="task-fleet-state"
                        >
                            <span
                                className={cn(
                                    'h-2 w-2 rounded-full',
                                    FLEET_TONE_DOT_CLASS[glyph.tone],
                                )}
                                aria-hidden="true"
                            />
                            {tStates(glyph.key)}
                            {elapsed && (
                                <span className="tabular-nums text-text-muted">{elapsed}</span>
                            )}
                        </span>
                    ) : (
                        <span className="text-text-muted" data-testid="task-fleet-state">
                            {endedAgo ? t('endedAgo', { ago: endedAgo }) : t('ended')}
                        </span>
                    )}
                    <span className="ml-auto flex items-center gap-2">
                        <Link
                            href={ROUTES.DASHBOARD_FLEET_SESSION(current.id)}
                            className="text-xs text-primary hover:underline"
                            data-testid="task-fleet-open"
                        >
                            {t('open')}
                        </Link>
                        {live && (
                            <button
                                type="button"
                                onClick={() => setEnding(true)}
                                className="text-xs text-danger hover:underline"
                                data-testid="task-fleet-end"
                            >
                                {t('end')}
                            </button>
                        )}
                    </span>
                </div>
                {!nodeOnline && (
                    <p className="text-xs text-text-muted dark:text-text-muted-dark">
                        {lastSeenAgo
                            ? t('offlineAgo', { node, ago: lastSeenAgo })
                            : t('offline', { node })}
                    </p>
                )}
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-muted dark:text-text-muted-dark">
                    <span className="inline-flex items-center gap-1 min-w-0">
                        <Folder className="h-3 w-3 shrink-0" aria-hidden="true" />
                        {checkout ? (
                            <Link
                                href={ROUTES.DASHBOARD_FLEET_COMPUTER(checkout.nodeId, 'checkouts')}
                                className="truncate font-mono hover:underline"
                                title={checkout.path}
                            >
                                {checkout.path}
                            </Link>
                        ) : (
                            <span className="truncate font-mono" title={current.cwd}>
                                {current.cwd}
                            </span>
                        )}
                    </span>
                    {checkout && <GitLine line={checkout.gitLine} branch={checkout.branch} />}
                    {task.prNumber != null ? <TaskPrPill task={task} /> : <span>{t('noPr')}</span>}
                </div>
            </div>
        );
    };

    return (
        <section
            className="rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-5 space-y-3"
            data-testid="task-fleet-section"
            data-state={session ? (live ? 'live' : 'ended') : 'empty'}
        >
            <h2 className="flex items-center gap-2 text-sm font-medium text-text dark:text-text-dark">
                <Laptop className="h-4 w-4" aria-hidden="true" />
                {t('title')}
            </h2>
            {session ? (
                renderSession(session)
            ) : (
                <p className="text-sm text-text-muted dark:text-text-muted-dark">{t('empty')}</p>
            )}
            {session && live && (
                <SessionEndDialog
                    open={ending}
                    onOpenChange={setEnding}
                    session={session}
                    nodeName={node}
                    agentName={agentName}
                    onEnded={() => router.refresh()}
                />
            )}
        </section>
    );
}
