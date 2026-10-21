'use client';

import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Bot, Folder, TerminalSquare } from 'lucide-react';
import type { FleetSessionView } from '@ever-works/contracts';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { cn } from '@/lib/utils/cn';
import { FLEET_TONE_DOT_CLASS } from '../fleet-hub.shared';
import { providerKey, sessionElapsed, sessionStateGlyph } from './sessions.shared';

/**
 * Sessions on computers (FL-04 P1b, CONTRACTS R-22) — one session as a card,
 * in its COMPACT layout: a header (state dot and word, title linking to the
 * session page, kind, CLI, how long it has run) and a footer (who started it,
 * its folder). FL-05 completes the anatomy (the attention line, the screen
 * preview); FL-06 / FL-15 / FL-20 fill `footerSlots` (git, task, cost). The
 * row menu is passed in so the tab and the Agent page share one.
 */
export function SessionCard({
    session,
    nodeName,
    viewerUserId,
    now,
    menu,
    footerSlots,
}: {
    session: FleetSessionView;
    nodeName: string;
    viewerUserId?: string | null;
    now: Date;
    menu?: ReactNode;
    footerSlots?: ReactNode;
}) {
    const t = useTranslations('fleet.sessions');
    const glyph = sessionStateGlyph(session.state);
    const elapsed = sessionElapsed(session, now);
    const startedBy = session.startedBy.startsWith('agent:')
        ? t('tab.startedByAgent')
        : session.userId === viewerUserId
          ? t('tab.startedByYou')
          : t('tab.startedByOther');
    const KindIcon = session.kind === 'agent' ? Bot : TerminalSquare;

    return (
        <article
            className="rounded-lg border border-border dark:border-border-dark bg-card dark:bg-card-primary-dark px-3 py-2.5 space-y-1.5"
            data-testid="fleet-session-card"
            data-session-id={session.id}
            data-state={session.state}
            aria-label={t('a11y.card', {
                title: session.title,
                node: nodeName,
                state: t(`states.${glyph.key}`),
            })}
        >
            <header className="flex items-center gap-2 min-w-0">
                <span
                    className={cn('h-2 w-2 shrink-0 rounded-full', FLEET_TONE_DOT_CLASS[glyph.tone])}
                    aria-hidden="true"
                />
                <span className="text-xs text-text-muted dark:text-text-muted-dark shrink-0">
                    {t(`states.${glyph.key}`)}
                </span>
                <KindIcon className="w-3.5 h-3.5 shrink-0 text-text-muted dark:text-text-muted-dark" aria-hidden="true" />
                <Link
                    href={ROUTES.DASHBOARD_FLEET_SESSION(session.id)}
                    className="min-w-0 truncate text-sm font-medium text-text dark:text-text-dark hover:underline"
                    data-testid="fleet-session-card-title"
                >
                    {session.title}
                </Link>
                <span className="ml-auto flex items-center gap-2 shrink-0 text-xs text-text-muted dark:text-text-muted-dark">
                    <span>{t(`providers.${providerKey(session.provider)}`)}</span>
                    {elapsed && <span className="tabular-nums">{elapsed}</span>}
                    {menu}
                </span>
            </header>
            <footer className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-muted dark:text-text-muted-dark">
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
