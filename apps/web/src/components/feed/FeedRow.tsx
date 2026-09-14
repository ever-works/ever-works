'use client';

import type { ReactNode } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Plug, Sparkles, UserRound } from 'lucide-react';
import type { FeedActorDto, FeedEntryDto } from '@ever-works/contracts';
import { Link } from '@/i18n/navigation';
import { cn } from '@/lib/utils/cn';
import { FeedKindPill } from './FeedKindPill';
import { describeFeedTime } from './feed-time';

interface FeedRowProps {
    entry: FeedEntryDto;
    /** Destination for the entry, or `null` to render plain text. */
    href: string | null;
    selected?: boolean;
    /** 1-based position for assistive technology. */
    position: number;
    /** Total entries when known, `-1` while more can load. */
    setSize: number;
    now: Date;
    onFocusEntry?: (id: string) => void;
}

function initials(name: string): string {
    const parts = name.trim().split(/\s+/).filter(Boolean);
    const letters =
        parts.length > 1 ? `${parts[0][0]}${parts[1][0]}` : (parts[0] ?? '?').slice(0, 2);
    return letters.toUpperCase();
}

function humanize(actionType: string): string {
    const words = actionType
        .replace(/[._-]+/g, ' ')
        .trim()
        .toLowerCase();
    return words ? words.charAt(0).toUpperCase() + words.slice(1) : '';
}

function ActorAvatar({ actor, name }: { actor: FeedActorDto; name: string }) {
    const base =
        'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border text-xs font-semibold';
    if (actor.kind === 'agent') {
        return (
            <span
                aria-hidden="true"
                className={cn(
                    base,
                    'border-concept-agents/20 bg-concept-agents/10 text-concept-agents',
                )}
            >
                {initials(name)}
            </span>
        );
    }
    const Icon = actor.kind === 'user' ? UserRound : actor.kind === 'external' ? Plug : Sparkles;
    return (
        <span
            aria-hidden="true"
            className={cn(
                base,
                'border-border dark:border-border-dark bg-surface-secondary dark:bg-surface-secondary-dark text-text-secondary dark:text-text-secondary-dark',
            )}
        >
            <Icon className="h-4 w-4" />
        </span>
    );
}

/**
 * One Live Feed entry: actor avatar, the narrated line naming the actor,
 * the kind pill (always with text) and a relative timestamp — in that order.
 * The words come only from `dashboard.feed.*`; an unknown narration key
 * falls back to the generic line, never to a raw action token.
 */
export function FeedRow({
    entry,
    href,
    selected = false,
    position,
    setSize,
    now,
    onFocusEntry,
}: FeedRowProps) {
    const t = useTranslations('dashboard.feed');
    const locale = useLocale();

    const actorName =
        entry.actor.kind === 'user'
            ? t('actors.you')
            : entry.actor.label ||
              (entry.actor.kind === 'agent'
                  ? t('actors.unknownAgent')
                  : entry.actor.kind === 'external'
                    ? t('actors.external')
                    : t('actors.system'));

    const emphasis = (chunks: ReactNode) => (
        <span className="font-medium text-text dark:text-text-dark">{chunks}</span>
    );
    // The narration key is data from the API, so it cannot be a statically
    // typed message key; `t.has` guards it at runtime instead.
    const narrationKey = `narration.${entry.narration.key}`;
    const hasUnchecked = t.has as unknown as (key: string) => boolean;
    const richUnchecked = t.rich as unknown as (
        key: string,
        values: Record<string, unknown>,
    ) => ReactNode;
    const line =
        entry.narration.key !== 'fallback' && hasUnchecked(narrationKey)
            ? richUnchecked(narrationKey, {
                  ...entry.narration.params,
                  actor: actorName,
                  b: emphasis,
              })
            : t.rich('narration.fallback', {
                  actor: actorName,
                  action: String(entry.narration.params.action ?? '') || humanize(entry.actionType),
                  b: emphasis,
              });

    const time = describeFeedTime(entry.createdAt, now, locale);
    const relative =
        time.kind === 'justNow'
            ? t('time.justNow')
            : time.kind === 'minutesAgo'
              ? t('time.minutesAgo', { count: time.count })
              : time.kind === 'hoursAgo'
                ? t('time.hoursAgo', { count: time.count })
                : time.kind === 'yesterdayAt'
                  ? t('time.yesterdayAt', { time: time.time })
                  : time.kind === 'withinWeek'
                    ? t('time.withinWeek', { weekday: time.weekday, time: time.time })
                    : t('time.absolute', { date: time.date });

    const body = (
        <>
            <ActorAvatar actor={entry.actor} name={actorName} />
            <p
                id={`feed-entry-${entry.id}-line`}
                className="min-w-0 flex-1 text-sm text-text-secondary dark:text-text-secondary-dark line-clamp-2"
            >
                {line}
            </p>
            <FeedKindPill kind={entry.kind} />
            <time
                dateTime={entry.createdAt}
                title={new Date(entry.createdAt).toLocaleString(locale)}
                suppressHydrationWarning
                className="w-24 shrink-0 text-right text-xs tabular-nums text-text-muted dark:text-text-muted-dark"
            >
                {relative}
            </time>
        </>
    );

    const rowClass = cn(
        'flex items-center gap-3 rounded-lg px-3 py-2.5 transition-colors',
        selected
            ? 'bg-surface-secondary dark:bg-surface-secondary-dark ring-2 ring-primary/60'
            : 'hover:bg-surface-secondary/60 dark:hover:bg-surface-secondary-dark/60',
    );

    return (
        <article
            data-testid="feed-entry"
            data-entry-id={entry.id}
            data-kind={entry.kind}
            data-selected={selected ? 'true' : undefined}
            aria-posinset={position}
            aria-setsize={setSize}
            aria-labelledby={`feed-entry-${entry.id}-line`}
            // A linked entry is reached through its link; a plain one is
            // itself a tab stop so every entry is reachable from the keyboard.
            tabIndex={href ? -1 : 0}
            onFocus={() => onFocusEntry?.(entry.id)}
            className="rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
            {href ? (
                <Link
                    href={href}
                    data-testid="feed-entry-link"
                    className={cn(
                        rowClass,
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                    )}
                >
                    {body}
                </Link>
            ) : (
                <div className={rowClass}>{body}</div>
            )}
        </article>
    );
}
