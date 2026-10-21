'use client';

import { useLocale, useTranslations } from 'next-intl';
import type { FleetSessionGitRef } from '@ever-works/contracts';
import { cn } from '@/lib/utils/cn';
import { GitLine } from '../checkouts/GitLine';
import { relativeTime } from '../fleet-hub.shared';
import { PrPill } from './PrPill';
import { folderOf, gitLineAgeTone, sessionGitState, withoutPullRequest } from './session-git.shared';

/**
 * Session git & actions (FL-06, spec FR-6, §5.1) — the ONE git line every
 * session surface renders: `acme/api · nina/fix-login ⎇ · +214 −38 · 6 files
 * · ↑3 ↓0 · 2 uncommitted · PR #912 open ✓ · 41 s ago`. Zero parts are left
 * out (FL-14's `GitLine` does that); the age turns amber past five minutes and
 * the whole line dims while the computer is offline (spec U1). Without a
 * checkout it reads "Not in a checkout".
 *
 * `pill: false` leaves the pull request out — the session card shows it in its
 * own `prPill` slot (CONTRACTS §4.8).
 */
export function SessionGitLine({
    git,
    now,
    offline = false,
    pill = true,
    unknownMinutes = null,
    className,
}: {
    git: FleetSessionGitRef | null | undefined;
    now: Date;
    offline?: boolean;
    pill?: boolean;
    unknownMinutes?: number | null;
    className?: string;
}) {
    const t = useTranslations('fleet.sessionGit.gitLine');
    const locale = useLocale();
    const state = sessionGitState(git);
    if (!git || state === 'none') {
        return (
            <span className={cn('text-xs text-text-muted dark:text-text-muted-dark', className)} data-testid="fleet-session-git-none">
                {t('noCheckout')}
            </span>
        );
    }
    const line = git.gitLine;
    const tone = gitLineAgeTone(line, now.getTime(), offline);
    const age = line ? relativeTime(line.at, now, locale) : null;
    return (
        <span
            className={cn(
                'inline-flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs',
                tone === 'offline' && 'opacity-60',
                className,
            )}
            data-testid="fleet-session-git-line"
            data-checkout-id={git.checkoutId}
        >
            {git.repository ? <span className="font-medium text-text dark:text-text-dark">{git.repository}</span> : null}
            <span title={line?.isWorktree ? t('worktreeOf', { folder: folderOf(git.path) }) : git.path}>
                <GitLine line={withoutPullRequest(line)} branch={git.branch} />
            </span>
            {state === 'missing' ? (
                <span className="text-amber-600 dark:text-amber-400">{t('folderGone')}</span>
            ) : null}
            {pill ? <PrPill pr={line?.pr ?? null} unknownMinutes={unknownMinutes} /> : null}
            {age ? (
                <span
                    className={cn(
                        'tabular-nums',
                        tone === 'stale' ? 'text-amber-600 dark:text-amber-400' : 'text-text-muted dark:text-text-muted-dark',
                    )}
                    data-testid="fleet-session-git-age"
                    data-tone={tone}
                >
                    {age}
                </span>
            ) : null}
        </span>
    );
}
