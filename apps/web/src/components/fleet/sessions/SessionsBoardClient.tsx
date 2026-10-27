'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useTranslations } from 'next-intl';
import {
    FLEET_SESSION_BOARD_COLUMNS,
    type FleetSessionBoardColumn,
    type FleetSessionBoardResponse,
    type FleetSessionView,
} from '@ever-works/contracts';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { cn } from '@/lib/utils/cn';
import { useNow } from '../health/use-now';
import { SessionCard } from './SessionCard';
import { SessionStateGlyph } from './SessionStateGlyph';
import { sessionsClient } from './sessions.client';
import {
    boardCounts,
    boardMoves,
    buildSessionsQuery,
    columnIndex,
    endedReasonKey,
    filterBoard,
    filterList,
    groupSessionsList,
    type SessionsViewState,
} from './sessions-board.shared';
import { sessionElapsedSlot, sessionGlyph, sessionStateWords } from './sessions-status.shared';

/** The board re-reads this often while visible (FR-43: a move shows within 5 s). */
const POLL_MS = 4_000;

const COLUMN_KEYS: Record<FleetSessionBoardColumn, { title: string; empty: string }> = {
    needs_you: { title: 'needsYou', empty: 'emptyNeedsYou' },
    working: { title: 'working', empty: 'emptyWorking' },
    done: { title: 'done', empty: 'emptyDone' },
    idle: { title: 'idle', empty: 'emptyIdle' },
};

/**
 * Activity → Sessions (FL-05 P3, spec FR-41 … FR-47, FR-52, §5.4, §5.5, §5.13)
 * — every session on the computers the person may see sessions on:
 *
 *  - **Board** — Needs you · Working · Done · Idle, counts in the headers,
 *    most recently moved first; only Needs you and Done cards are tinted (the
 *    card's own rule); a card that changes column moves with a view
 *    transition and the move is announced in a polite live region;
 *  - **List** — live and ended sessions grouped by day or week and by who (an
 *    Agent, you), an ended row with its reason, **Answer** inline for one that
 *    waits.
 *
 * Filters (Agent, computer, kind, state) and the mode live in the address bar
 * (FR-44): this component reports its state through `onStateChange` and the
 * Activity page — the page's single URL writer — writes it. Re-read every 4 s
 * while the tab is visible. Every card and row opens the session (FR-47).
 */
export function SessionsBoardClient({
    initialView,
    initialBoard,
    initialList,
    nodes,
    agents,
    viewerUserId,
    onStateChange,
}: {
    initialView: SessionsViewState;
    initialBoard: FleetSessionBoardResponse | null;
    initialList: FleetSessionView[] | null;
    nodes: ReadonlyArray<{ id: string; name: string }>;
    agents: ReadonlyArray<{ id: string; name: string }>;
    viewerUserId: string | null;
    onStateChange?: (query: string) => void;
}) {
    const t = useTranslations('fleet.sessions');
    const nowMs = useNow(15_000);
    const now = useMemo(() => new Date(nowMs), [nowMs]);
    const [view, setView] = useState<SessionsViewState>(initialView);
    const [board, setBoard] = useState<FleetSessionBoardResponse | null>(initialBoard);
    const [list, setList] = useState<FleetSessionView[] | null>(initialList);
    const [failed, setFailed] = useState(false);
    const [announcement, setAnnouncement] = useState('');
    const previousColumns = useRef(
        initialBoard ? columnIndex(initialBoard) : new Map<string, FleetSessionBoardColumn>(),
    );

    const nodeNames = useMemo(() => new Map(nodes.map((node) => [node.id, node.name])), [nodes]);
    const agentNames = useMemo(
        () => new Map(agents.map((agent) => [agent.id, agent.name])),
        [agents],
    );

    const filters = useMemo(
        () => ({
            ...(view.nodeId ? { nodeId: view.nodeId } : {}),
            ...(view.agentId ? { agentId: view.agentId } : {}),
            ...(view.kind ? { kind: view.kind } : {}),
        }),
        [view.nodeId, view.agentId, view.kind],
    );

    const reload = useCallback(async () => {
        if (view.mode === 'board') {
            const result = await sessionsClient.board(filters);
            if (!result.ok) {
                setFailed(true);
                return;
            }
            setFailed(false);
            const next = result.data;
            const nextColumns = columnIndex(next);
            const moves = boardMoves(previousColumns.current, nextColumns);
            previousColumns.current = nextColumns;
            if (moves.length > 0) {
                const titles = new Map(
                    FLEET_SESSION_BOARD_COLUMNS.flatMap((column) => next.columns[column]).map(
                        (s) => [s.id, s.title],
                    ),
                );
                setAnnouncement(
                    moves
                        .map((move) =>
                            t('board.moved', {
                                title: titles.get(move.id) ?? '',
                                column: t(
                                    `board.${COLUMN_KEYS[move.to].title}` as Parameters<
                                        typeof t
                                    >[0],
                                ),
                            }),
                        )
                        .join(' '),
                );
            }
            // FR-43: a card that changed column moves (view transition where the browser has it).
            const apply = () => setBoard(next);
            const doc = document as Document & {
                startViewTransition?: (callback: () => void) => unknown;
            };
            if (moves.length > 0 && typeof doc.startViewTransition === 'function')
                doc.startViewTransition(apply);
            else apply();
            return;
        }
        const result = await sessionsClient.list({ ...filters, limit: 200 });
        if (!result.ok) {
            setFailed(true);
            return;
        }
        setFailed(false);
        setList(result.data.sessions);
    }, [filters, t, view.mode]);

    useEffect(() => {
        void reload();
        const timer = setInterval(() => {
            if (document.visibilityState === 'visible') void reload();
        }, POLL_MS);
        return () => clearInterval(timer);
    }, [reload]);

    const update = (patch: Partial<SessionsViewState>) => {
        const next = { ...view, ...patch };
        setView(next);
        onStateChange?.(buildSessionsQuery(next));
    };

    const shownBoard = board ? filterBoard(board, view) : null;
    const counts = shownBoard ? boardCounts(shownBoard) : null;
    const total = counts ? counts.needs_you + counts.working + counts.done + counts.idle : 0;
    const shownList = list ? filterList(list, view) : null;

    const card = (session: FleetSessionView) => (
        <div
            key={session.id}
            style={{ viewTransitionName: `fleet-session-${session.id}` } as CSSProperties}
        >
            <SessionCard
                session={session}
                nodeName={nodeNames.get(session.nodeId) ?? '…'}
                viewerUserId={viewerUserId}
                now={now}
                agentName={session.agentId ? (agentNames.get(session.agentId) ?? null) : null}
                onAnswered={() => void reload()}
            />
        </div>
    );

    return (
        <section
            className="space-y-4"
            data-testid="fleet-sessions-board"
            data-mode={view.mode}
            aria-labelledby="fleet-sessions-heading"
        >
            <h2 id="fleet-sessions-heading" className="sr-only">
                {t('board.heading')}
            </h2>
            <div className="flex flex-wrap items-center gap-2" data-testid="fleet-sessions-toolbar">
                <div className="flex items-center gap-0.5 rounded-lg border border-border dark:border-border-dark p-0.5">
                    {(['board', 'list'] as const).map((mode) => (
                        <button
                            key={mode}
                            type="button"
                            aria-pressed={view.mode === mode}
                            onClick={() => update({ mode })}
                            data-testid={`fleet-sessions-mode-${mode}`}
                            className={cn(
                                'px-2.5 py-1 rounded-md text-xs font-medium',
                                view.mode === mode
                                    ? 'bg-card dark:bg-card-primary-dark text-text dark:text-text-dark shadow-sm'
                                    : 'text-text-muted dark:text-text-muted-dark',
                            )}
                        >
                            {mode === 'board' ? t('board.toggleBoard') : t('board.toggleList')}
                        </button>
                    ))}
                </div>
                <select
                    aria-label={t('board.filterAgent')}
                    value={view.agentId ?? ''}
                    onChange={(event) => update({ agentId: event.target.value || null })}
                    className="rounded-md border border-border dark:border-border-dark bg-background dark:bg-background-dark px-2 py-1 text-xs"
                    data-testid="fleet-sessions-filter-agent"
                >
                    <option value="">{t('board.allAgents')}</option>
                    {agents.map((agent) => (
                        <option key={agent.id} value={agent.id}>
                            {agent.name}
                        </option>
                    ))}
                </select>
                <select
                    aria-label={t('board.filterComputer')}
                    value={view.nodeId ?? ''}
                    onChange={(event) => update({ nodeId: event.target.value || null })}
                    className="rounded-md border border-border dark:border-border-dark bg-background dark:bg-background-dark px-2 py-1 text-xs"
                    data-testid="fleet-sessions-filter-node"
                >
                    <option value="">{t('board.allComputers')}</option>
                    {nodes.map((node) => (
                        <option key={node.id} value={node.id}>
                            {node.name}
                        </option>
                    ))}
                </select>
                <select
                    aria-label={t('board.filterKind')}
                    value={view.kind ?? ''}
                    onChange={(event) =>
                        update({
                            kind:
                                event.target.value === 'owner' || event.target.value === 'agent'
                                    ? event.target.value
                                    : null,
                        })
                    }
                    className="rounded-md border border-border dark:border-border-dark bg-background dark:bg-background-dark px-2 py-1 text-xs"
                    data-testid="fleet-sessions-filter-kind"
                >
                    <option value="">{t('board.allKinds')}</option>
                    <option value="owner">{t('kinds.owner')}</option>
                    <option value="agent">{t('kinds.agent')}</option>
                </select>
                <select
                    aria-label={t('board.filterState')}
                    value={view.state ?? ''}
                    onChange={(event) => {
                        const value = event.target.value;
                        update({
                            state:
                                value === 'needs_you' ||
                                value === 'working' ||
                                value === 'done' ||
                                value === 'idle' ||
                                value === 'ended'
                                    ? value
                                    : null,
                        });
                    }}
                    className="rounded-md border border-border dark:border-border-dark bg-background dark:bg-background-dark px-2 py-1 text-xs"
                    data-testid="fleet-sessions-filter-state"
                >
                    <option value="">{t('board.allStates')}</option>
                    <option value="needs_you">{t('board.needsYou')}</option>
                    <option value="working">{t('board.working')}</option>
                    <option value="done">{t('board.done')}</option>
                    <option value="idle">{t('board.idle')}</option>
                    {view.mode === 'list' && <option value="ended">{t('states.ended')}</option>}
                </select>
                {view.mode === 'list' && (
                    <div className="flex items-center gap-0.5 rounded-lg border border-border dark:border-border-dark p-0.5">
                        {(['day', 'week'] as const).map((grouping) => (
                            <button
                                key={grouping}
                                type="button"
                                aria-pressed={view.grouping === grouping}
                                onClick={() => update({ grouping })}
                                className={cn(
                                    'px-2 py-1 rounded-md text-xs',
                                    view.grouping === grouping
                                        ? 'bg-card dark:bg-card-primary-dark text-text dark:text-text-dark shadow-sm'
                                        : 'text-text-muted dark:text-text-muted-dark',
                                )}
                            >
                                {grouping === 'day' ? t('list.day') : t('list.week')}
                            </button>
                        ))}
                    </div>
                )}
            </div>

            {failed && (
                <p role="alert" className="text-sm text-danger">
                    {t('board.loadFailed')}
                </p>
            )}

            <p className="sr-only" aria-live="polite" data-testid="fleet-sessions-live-region">
                {announcement}
            </p>

            {view.mode === 'board' && shownBoard && total === 0 && !view.state && (
                <div
                    className="rounded-lg border border-dashed border-border dark:border-border-dark p-6 text-center space-y-3"
                    data-testid="fleet-sessions-empty"
                >
                    <p className="text-sm text-text-muted dark:text-text-muted-dark">
                        {t('board.empty')}
                    </p>
                    <Link
                        href={ROUTES.DASHBOARD_FLEET_COMPUTERS}
                        className="text-sm text-primary hover:underline"
                    >
                        {t('board.newSession')}
                    </Link>
                </div>
            )}

            {view.mode === 'board' && shownBoard && (total > 0 || view.state) && (
                <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                    {FLEET_SESSION_BOARD_COLUMNS.map((column) => (
                        <section
                            key={column}
                            aria-labelledby={`fleet-sessions-column-${column}`}
                            className="space-y-2 min-w-0"
                            data-testid={`fleet-sessions-column-${column}`}
                        >
                            <h3
                                id={`fleet-sessions-column-${column}`}
                                className="text-xs font-semibold uppercase tracking-wide text-text-muted dark:text-text-muted-dark"
                            >
                                {t(`board.${COLUMN_KEYS[column].title}` as Parameters<typeof t>[0])}{' '}
                                ({counts?.[column] ?? 0})
                            </h3>
                            {shownBoard.columns[column].length === 0 ? (
                                <p className="text-xs text-text-muted dark:text-text-muted-dark">
                                    {t(
                                        `board.${COLUMN_KEYS[column].empty}` as Parameters<
                                            typeof t
                                        >[0],
                                    )}
                                </p>
                            ) : (
                                <div className="space-y-2">
                                    {shownBoard.columns[column].map(card)}
                                </div>
                            )}
                        </section>
                    ))}
                </div>
            )}

            {view.mode === 'list' && shownList && (
                <div className="space-y-4" data-testid="fleet-sessions-list">
                    {shownList.length === 0 && (
                        <p className="text-sm text-text-muted dark:text-text-muted-dark">
                            {t('board.empty')}
                        </p>
                    )}
                    {groupSessionsList(shownList, view.grouping).map((group) => {
                        const who =
                            group.whoKey === 'you'
                                ? t('list.you')
                                : group.whoKey === 'shell'
                                  ? t('list.shells')
                                  : (agentNames.get(group.whoKey) ?? t('list.anAgent'));
                        return (
                            <section key={`${group.period}|${group.whoKey}`} className="space-y-1">
                                <h3 className="text-xs font-semibold uppercase tracking-wide text-text-muted dark:text-text-muted-dark">
                                    {t(
                                        view.grouping === 'day'
                                            ? 'list.dayHeading'
                                            : 'list.weekHeading',
                                        {
                                            period: group.period,
                                            who,
                                            count: group.sessions.length,
                                        },
                                    )}
                                </h3>
                                <ul className="divide-y divide-border dark:divide-border-dark">
                                    {group.sessions.map((session) => {
                                        const words = sessionStateWords(session);
                                        const reason = endedReasonKey(session);
                                        const elapsed = sessionElapsedSlot(session, now);
                                        return (
                                            <li
                                                key={session.id}
                                                className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5 text-sm"
                                            >
                                                <SessionStateGlyph glyph={sessionGlyph(session)} />
                                                <Link
                                                    href={ROUTES.DASHBOARD_FLEET_SESSION(
                                                        session.id,
                                                    )}
                                                    className="min-w-0 truncate font-medium text-text dark:text-text-dark hover:underline"
                                                >
                                                    {session.title}
                                                </Link>
                                                <span className="text-xs text-text-muted dark:text-text-muted-dark">
                                                    {words.qualifier
                                                        ? t('states.withQualifier', {
                                                              state: t(`states.${words.key}`),
                                                              qualifier: t(
                                                                  `states.${words.qualifier}`,
                                                              ),
                                                          })
                                                        : t(`states.${words.key}`)}
                                                    {reason
                                                        ? ` · ${t(`list.reasons.${reason}`, { code: session.exitCode ?? 0 })}`
                                                        : ''}
                                                </span>
                                                <span className="text-xs text-text-muted dark:text-text-muted-dark">
                                                    {nodeNames.get(session.nodeId) ?? '…'}
                                                </span>
                                                {elapsed && (
                                                    <span className="text-xs tabular-nums text-text-muted dark:text-text-muted-dark">
                                                        {t(`card.${elapsed.key}`, {
                                                            span: elapsed.span,
                                                        })}
                                                    </span>
                                                )}
                                                {session.state === 'needs_you' && (
                                                    <Link
                                                        href={ROUTES.DASHBOARD_FLEET_SESSION(
                                                            session.id,
                                                        )}
                                                        className="ml-auto text-xs font-medium text-primary hover:underline"
                                                    >
                                                        {t('list.answer')}
                                                    </Link>
                                                )}
                                            </li>
                                        );
                                    })}
                                </ul>
                            </section>
                        );
                    })}
                </div>
            )}
        </section>
    );
}
