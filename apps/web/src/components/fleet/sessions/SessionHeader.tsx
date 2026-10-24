'use client';

import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { ArrowLeft, Bot, Folder, Keyboard, TerminalSquare } from 'lucide-react';
import { isFleetSessionLive, type FleetSessionView } from '@ever-works/contracts';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { cn } from '@/lib/utils/cn';
import { Button } from '@/components/ui/button';
import { FLEET_TONE_DOT_CLASS } from '../fleet-hub.shared';
import { providerKey, sessionElapsed, sessionStateGlyph } from './sessions.shared';
import { notifyReplaced, sessionGlyph, sessionStateWords, statusSourceNote } from './sessions-status.shared';
import { SessionStateGlyph } from './SessionStateGlyph';

/**
 * Sessions on computers (FL-04 P1b, spec §5.4) — the session page's header:
 * `← build-01 · Sessions`, then icon · title · state · computer · kind · CLI ·
 * folder · who started it · how long, and the acts (Take the keyboard / Watch
 * only, Rename, End… or Restart, Copy link, the shortcut sheet). Two empty
 * slots wait for siblings: FL-06's git line and FL-05's attention line.
 */
export function SessionHeader({
    session,
    nodeName,
    viewerUserId,
    now,
    role,
    canDrive,
    onTakeKeyboard,
    onWatchOnly,
    onRename,
    onEnd,
    onRestart,
    onCopyLink,
    onShortcuts,
    gitSlot,
    attentionSlot,
    actionsSlot,
}: {
    session: FleetSessionView;
    nodeName: string;
    viewerUserId: string | null;
    now: Date;
    role: 'viewer' | 'driver';
    canDrive: boolean;
    onTakeKeyboard: () => void;
    onWatchOnly: () => void;
    onRename: () => void;
    onEnd: () => void;
    onRestart: () => void;
    onCopyLink: () => void;
    onShortcuts: () => void;
    gitSlot?: ReactNode;
    attentionSlot?: ReactNode;
    /** FL-06 (spec §5.2): **Actions ▾**, beside End. */
    actionsSlot?: ReactNode;
}) {
    const t = useTranslations('fleet.sessions');
    const glyph = sessionStateGlyph(session.state);
    const live = isFleetSessionLive(session.state);
    const elapsed = sessionElapsed(session, now);
    const who = session.startedBy.startsWith('agent:')
        ? t('detail.startedByAgent')
        : session.userId === viewerUserId
          ? t('detail.startedByYou')
          : t('detail.startedByOther');
    const KindIcon = session.kind === 'agent' ? Bot : TerminalSquare;
    // FL-05: the state in words with its reason or outcome, and where the status comes from (FR-11, §5.10).
    const words = sessionStateWords(session);
    const stateText = words.qualifier
        ? t('states.withQualifier', { state: t(`states.${words.key}`), qualifier: t(`states.${words.qualifier}`) })
        : t(`states.${glyph.key}`);
    const statusGlyph = sessionGlyph(session);
    const sourceNote = statusSourceNote(session, { detail: true });
    const providerName = t(`providers.${providerKey(session.provider)}`);

    return (
        <header className="space-y-3" data-testid="fleet-session-header">
            <Link
                href={ROUTES.DASHBOARD_FLEET_COMPUTER(session.nodeId, 'sessions')}
                className="inline-flex items-center gap-1 text-sm text-text-muted dark:text-text-muted-dark hover:text-text dark:hover:text-text-dark"
                data-testid="fleet-session-back"
            >
                <ArrowLeft className="w-4 h-4" aria-hidden="true" />
                {nodeName} · {t('detail.back')}
            </Link>
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 space-y-1">
                    <h1 className="flex items-center gap-2 text-xl font-semibold text-text dark:text-text-dark">
                        <KindIcon className="w-5 h-5 shrink-0" aria-hidden="true" />
                        <span className="truncate" data-testid="fleet-session-title">
                            {session.title}
                        </span>
                        <span className="inline-flex items-center gap-1.5 text-sm font-normal text-text-muted dark:text-text-muted-dark">
                            {statusGlyph === 'none' ? (
                                <span
                                    className={cn('h-2 w-2 rounded-full', FLEET_TONE_DOT_CLASS[glyph.tone])}
                                    aria-hidden="true"
                                />
                            ) : (
                                <SessionStateGlyph glyph={statusGlyph} />
                            )}
                            <span data-testid="fleet-session-state">{stateText}</span>
                        </span>
                    </h1>
                    <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-muted dark:text-text-muted-dark">
                        <span>{nodeName}</span>
                        <span>{t(`kinds.${session.kind}`)}</span>
                        <span>{t(`providers.${providerKey(session.provider)}`)}</span>
                        <span className="inline-flex items-center gap-1 min-w-0">
                            <Folder className="w-3 h-3" aria-hidden="true" />
                            <span className="truncate font-mono" title={session.cwd}>
                                {session.cwd}
                            </span>
                        </span>
                        <span>{t('detail.startedBy', { who })}</span>
                        {elapsed && (
                            <span className="tabular-nums">
                                {live ? t('detail.runningFor', { elapsed }) : t('detail.ranFor', { elapsed })}
                            </span>
                        )}
                    </p>
                    {sourceNote && (
                        <p
                            className="text-xs text-text-muted dark:text-text-muted-dark"
                            data-testid="fleet-session-status-source"
                            data-source={sourceNote}
                        >
                            {t(`statusSource.${sourceNote}`, { provider: providerName, node: nodeName })}
                            {notifyReplaced(session) && <> · {t('statusSource.notifyReplaced')}</>}
                            {session.provider !== 'shell' && <> · {t('statusSource.noTokens')}</>}
                        </p>
                    )}
                    <div data-slot="fl-06-git-line">{gitSlot}</div>
                    <div data-slot="fl-05-attention">{attentionSlot}</div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    {live && canDrive && role === 'viewer' && (
                        <Button size="sm" onClick={onTakeKeyboard} data-testid="fleet-session-take-keyboard">
                            {t('detail.takeKeyboard')}
                        </Button>
                    )}
                    {live && role === 'driver' && (
                        <Button size="sm" variant="secondary" onClick={onWatchOnly} data-testid="fleet-session-watch-only">
                            {t('detail.watchOnly')}
                        </Button>
                    )}
                    {actionsSlot}
                    <Button size="sm" variant="secondary" onClick={onRename} data-testid="fleet-session-rename">
                        {t('detail.rename')}
                    </Button>
                    {live ? (
                        <Button size="sm" variant="danger" onClick={onEnd} data-testid="fleet-session-end">
                            {t('detail.end')}
                        </Button>
                    ) : (
                        <Button size="sm" variant="secondary" onClick={onRestart} data-testid="fleet-session-restart">
                            {t('detail.restart')}
                        </Button>
                    )}
                    <Button size="sm" variant="ghost" onClick={onCopyLink}>
                        {t('detail.copyLink')}
                    </Button>
                    <Button
                        size="icon"
                        variant="ghost"
                        onClick={onShortcuts}
                        aria-label={t('detail.shortcuts')}
                        data-testid="fleet-session-shortcuts-button"
                    >
                        <Keyboard className="w-4 h-4" aria-hidden="true" />
                    </Button>
                </div>
            </div>
        </header>
    );
}
