'use client';

import { useTranslations } from 'next-intl';
import { GitBranch, GitFork } from 'lucide-react';
import type { FleetGitLine } from '@ever-works/contracts';
import { cn } from '@/lib/utils/cn';

/**
 * Checkouts on computers (FL-14, CONTRACTS §4.7, spec FR-8) — the one git line
 * renderer: branch (⎇ for a worktree) · `+214 −38 · 6 files` · `↑3 ↓2` ·
 * `● 3 uncommitted` or `✓ clean`. FL-06 fills the pull-request slot (`pr`)
 * and reuses this on every session card (CONTRACTS R-22 `gitLine` slot).
 */
export function GitLine({
    line,
    branch,
    className,
}: {
    line: FleetGitLine | null;
    /** Shown when no line was computed yet (the row's last-known branch). */
    branch?: string | null;
    className?: string;
}) {
    const t = useTranslations('fleet.checkouts.gitLine');
    const name = line?.branch ?? branch ?? null;
    const Icon = line?.isWorktree ? GitFork : GitBranch;
    return (
        <span
            className={cn('inline-flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs', className)}
            data-testid="fleet-checkout-git-line"
        >
            <span className="inline-flex items-center gap-1 font-mono">
                <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
                <span>{name ?? t('detached')}</span>
                {line?.isWorktree ? <span className="sr-only">{t('worktree')}</span> : null}
            </span>
            {line ? (
                <>
                    {line.added > 0 || line.removed > 0 || line.filesChanged > 0 ? (
                        <span className="text-text-muted dark:text-text-muted-dark">
                            {t('changes', {
                                added: line.added,
                                removed: line.removed,
                                files: line.filesChanged,
                            })}
                        </span>
                    ) : null}
                    {line.ahead !== null && line.ahead > 0 ? (
                        <span title={t('aheadTitle', { count: line.ahead })}>{t('ahead', { count: line.ahead })}</span>
                    ) : null}
                    {line.behind !== null && line.behind > 0 ? (
                        <span title={t('behindTitle', { count: line.behind })}>
                            {t('behind', { count: line.behind })}
                        </span>
                    ) : null}
                    {line.uncommitted > 0 ? (
                        <span className="text-amber-600 dark:text-amber-400">
                            {t('uncommitted', { count: line.uncommitted })}
                        </span>
                    ) : (
                        <span className="text-emerald-600 dark:text-emerald-400">{t('clean')}</span>
                    )}
                    {line.pr ? (
                        <a href={line.pr.url} target="_blank" rel="noreferrer" className="underline">
                            {t('pr', { number: line.pr.number, state: line.pr.state })}
                        </a>
                    ) : null}
                </>
            ) : (
                <span className="text-text-muted dark:text-text-muted-dark">{t('notRead')}</span>
            )}
        </span>
    );
}
