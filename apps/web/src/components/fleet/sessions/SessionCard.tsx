'use client';

import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Bot, Folder, TerminalSquare } from 'lucide-react';
import { isFleetSessionLive, type FleetSessionView } from '@ever-works/contracts';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { cn } from '@/lib/utils/cn';
import { providerKey } from './sessions.shared';
import {
    sessionCardBody,
    sessionElapsedSlot,
    sessionGlyph,
    sessionStateWords,
    sessionTint,
    isAnswerable,
    isSessionUnread,
    statusSourceNote,
} from './sessions-status.shared';
import { SessionStateGlyph } from './SessionStateGlyph';
import { SessionAttentionBox } from './SessionAttentionBox';
import { SessionTaskChip } from '../tasks/SessionTaskChip';
import { CleanUpButton } from './CleanUpButton';
import { PrPill } from './PrPill';
import { canCleanUp } from './session-git.shared';
import { SessionGitLine } from './SessionGitLine';
import { SessionCostChip } from './SessionCostChip';
import { sessionCostChipModel } from '../usage/usage.shared';

/**
 * The footer slots other epics fill (CONTRACTS §4.8, R-22), in their order:
 * `computer` (always, this card) · `gitLine` · `prPill` (FL-06) · `taskChip`
 * (FL-15) · `elapsed` (always, this card) · `cost` (FL-20) · `cleanUp`
 * (FL-06). An empty slot renders nothing; no epic adds a slot outside this list.
 */
export interface SessionCardSlots {
    gitLine?: ReactNode;
    prPill?: ReactNode;
    taskChip?: ReactNode;
    cost?: ReactNode;
    cleanUp?: ReactNode;
}

const TINT_CLASS: Record<'warm' | 'green' | 'neutral', string> = {
    warm: 'border-warning/50 bg-warning/5 dark:bg-warning/10',
    green: 'border-success/40 bg-success/5 dark:bg-success/10',
    neutral: 'border-border dark:border-border-dark bg-card dark:bg-card-primary-dark',
};

/**
 * Sessions on computers (FL-04 P1b compact layout) completed by FL-05
 * (CONTRACTS R-22, §4.8; spec FR-20 … FR-23, FR-53):
 *
 *  - **header** — who (an Agent or a shell/CLI icon) · title (bold while
 *    unread — never a badge) · the state glyph and the state in words;
 *  - **body** — the last user line and the last agent line (2-line clamp,
 *    redacted on the machine), or the attention prompt in an amber box
 *    (`attentionSlot` carries P2's answer buttons), or the ended line;
 *  - **footer** — the §4.8 slots in order (computer · gitLine · prPill ·
 *    taskChip · elapsed · cost · cleanUp), then FL-04's who-started-it and
 *    folder, and `footerSlots` (kept for FL-04's callers).
 *
 * Tint: warm while it needs you, green for a successful finish, neutral
 * otherwise (FR-21). The status source is named when it is not the CLI's own
 * hooks (FR-23). The row menu (Open / Rename / End) is passed in.
 */
export function SessionCard({
    session,
    nodeName,
    viewerUserId,
    now,
    menu,
    footerSlots,
    slots,
    attentionSlot,
    agentName,
    onAnswered,
}: {
    session: FleetSessionView;
    nodeName: string;
    viewerUserId?: string | null;
    now: Date;
    menu?: ReactNode;
    footerSlots?: ReactNode;
    /** CONTRACTS §4.8 named footer slots (FL-06, FL-15, FL-20). */
    slots?: SessionCardSlots;
    /** FL-05 P2: the answer controls inside the amber box. */
    attentionSlot?: ReactNode;
    /** The Agent's name for its lines ("Nina: …"); the CLI's name otherwise. */
    agentName?: string | null;
    /** FL-05 P2: called once an answer from this card went through (the list re-reads). */
    onAnswered?: () => void;
}) {
    const t = useTranslations('fleet.sessions');
    const glyph = sessionGlyph(session);
    const words = sessionStateWords(session);
    const stateText = words.qualifier
        ? t('states.withQualifier', { state: t(`states.${words.key}`), qualifier: t(`states.${words.qualifier}`) })
        : t(`states.${words.key}`);
    const tint = sessionTint(session);
    const unread = isSessionUnread(session);
    const body = sessionCardBody(session);
    const elapsed = sessionElapsedSlot(session, now);
    const source = statusSourceNote(session);
    const providerName = t(`providers.${providerKey(session.provider)}`);
    const who = session.kind === 'agent' ? (agentName?.trim() || t('card.agentFallback')) : providerName;
    const startedBy = session.startedBy.startsWith('agent:')
        ? t('tab.startedByAgent')
        : session.userId === viewerUserId
          ? t('tab.startedByYou')
          : t('tab.startedByOther');
    const KindIcon = session.kind === 'agent' ? Bot : TerminalSquare;
    // FR-52: on a focused card, 1–9 answer a numbered option, A / D allow / deny.
    const shortcutsRef = useRef<((key: string) => boolean) | null>(null);
    const onCardKeyDown = (event: KeyboardEvent<HTMLElement>) => {
        if (event.target !== event.currentTarget || event.metaKey || event.ctrlKey || event.altKey) return;
        if (shortcutsRef.current?.(event.key)) event.preventDefault();
    };
    const answerBox =
        attentionSlot ??
        (body.kind === 'attention' && isAnswerable(body.attention) ? (
            <SessionAttentionBox
                session={session}
                attention={body.attention}
                nodeName={nodeName}
                shortcutsRef={shortcutsRef}
                {...(onAnswered ? { onAnswered } : {})}
            />
        ) : null);

    return (
        <article
            className={cn('rounded-lg border px-3 py-2.5 space-y-1.5', TINT_CLASS[tint])}
            data-testid="fleet-session-card"
            data-session-id={session.id}
            data-state={session.state}
            data-tint={tint}
            data-unread={unread ? 'true' : undefined}
            tabIndex={0}
            onKeyDown={onCardKeyDown}
            aria-label={t('a11y.cardFull', {
                who,
                title: session.title,
                state: stateText,
                node: nodeName,
            })}
        >
            <header className="flex items-center gap-2 min-w-0">
                <KindIcon className="w-3.5 h-3.5 shrink-0 text-text-muted dark:text-text-muted-dark" aria-hidden="true" />
                <Link
                    href={ROUTES.DASHBOARD_FLEET_SESSION(session.id)}
                    className={cn(
                        'min-w-0 truncate text-sm text-text dark:text-text-dark hover:underline',
                        unread ? 'font-semibold' : 'font-medium',
                    )}
                    data-testid="fleet-session-card-title"
                >
                    {session.title}
                </Link>
                <span
                    className="ml-auto flex items-center gap-1.5 shrink-0 text-xs text-text-muted dark:text-text-muted-dark"
                    data-testid="fleet-session-card-state"
                >
                    <SessionStateGlyph glyph={glyph} />
                    <span>{stateText}</span>
                    <span className="hidden sm:inline">· {providerName}</span>
                    {menu}
                </span>
            </header>

            <div className="text-xs text-text-muted dark:text-text-muted-dark space-y-0.5" data-testid="fleet-session-card-body">
                {body.kind === 'attention' && (
                    <div
                        role="group"
                        aria-label={body.attention.prompt || stateText}
                        className="rounded-md border border-warning/50 bg-warning/10 px-2.5 py-1.5 text-text dark:text-text-dark space-y-1.5"
                        data-testid="fleet-session-card-attention"
                    >
                        <p className="line-clamp-2 break-words">{body.attention.prompt || t('card.needsYouNoPrompt')}</p>
                        {answerBox}
                        {source === 'fromScreen' && (
                            <p className="text-[11px] text-text-muted dark:text-text-muted-dark">{t('card.fromScreen')}</p>
                        )}
                    </div>
                )}
                {body.kind === 'exited' && <p>{t('card.exited', { code: body.code })}</p>}
                {body.kind === 'unconfirmed' && <p>{t('card.unconfirmed', { node: nodeName })}</p>}
                {body.kind === 'lines' && (
                    <>
                        {body.userLine && <p className="line-clamp-2 break-words">{t('card.you', { text: body.userLine })}</p>}
                        {body.agentLine && (
                            <p className="line-clamp-2 break-words text-text dark:text-text-dark">
                                {t('card.agent', { who, text: body.agentLine })}
                            </p>
                        )}
                    </>
                )}
            </div>

            <footer className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-muted dark:text-text-muted-dark">
                <span data-slot="computer">{nodeName}</span>
                {/* FL-06 (spec FR-6, FR-8): the checkout's git line and its pull request fill these slots. */}
                {(slots?.gitLine || session.git) && (
                    <span data-slot="gitLine">
                        {slots?.gitLine ?? <SessionGitLine git={session.git} now={now} pill={false} />}
                    </span>
                )}
                {(slots?.prPill || session.git?.gitLine?.pr) && (
                    <span data-slot="prPill">{slots?.prPill ?? <PrPill pr={session.git?.gitLine?.pr ?? null} />}</span>
                )}
                {/* FL-15 P1 (spec FR-10): the Task this session's Run works on fills the taskChip slot. */}
                {(slots?.taskChip || session.task) && (
                    <span data-slot="taskChip">
                        {slots?.taskChip ?? (session.task ? <SessionTaskChip task={session.task} /> : null)}
                    </span>
                )}
                {elapsed && (
                    <span data-slot="elapsed" className="tabular-nums">
                        {t(`card.${elapsed.key}`, { span: elapsed.span })}
                    </span>
                )}
                {/* FL-20 (spec FR-10): the session's model work at list price fills the cost slot. */}
                {(slots?.cost || sessionCostChipModel(session)) && (
                    <span data-slot="cost">
                        {slots?.cost ?? <SessionCostChip costCents={session.costCents} tokens={session.tokens} />}
                    </span>
                )}
                {/* FL-06 (spec FR-25, S11): Clean up once the pull request is merged or closed. */}
                {slots?.cleanUp ? (
                    <span data-slot="cleanUp">{slots.cleanUp}</span>
                ) : session.git &&
                  canCleanUp({
                      kind: session.git.kind,
                      state: session.git.state,
                      pr: session.git.gitLine?.pr,
                      sessionLive: isFleetSessionLive(session.state),
                  }) ? (
                    <span data-slot="cleanUp">
                        <CleanUpButton checkoutId={session.git.checkoutId} branch={session.git.branch} nodeName={nodeName} />
                    </span>
                ) : null}
                {source === 'fromScreen' && body.kind !== 'attention' && <span>{t('card.fromScreen')}</span>}
                {session.agentRunId && (
                    <Link
                        href={ROUTES.DASHBOARD_AGENT_SESSION(session.agentRunId)}
                        className="hover:underline"
                        data-testid="fleet-session-card-run"
                    >
                        {t('card.openRun')}
                    </Link>
                )}
                <span>{startedBy}</span>
                <span className="inline-flex items-center gap-1 min-w-0">
                    <Folder className="w-3 h-3 shrink-0" aria-hidden="true" />
                    <span className="truncate font-mono" title={session.cwd}>
                        {session.cwd}
                    </span>
                </span>
                {footerSlots}
            </footer>
        </article>
    );
}
