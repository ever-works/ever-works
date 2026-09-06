'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { GitBranch } from 'lucide-react';
import type { TaskExtraRepo } from '@ever-works/contracts';
import { listRepoConnections } from '@/app/actions/repo-connections';
import type { RepoConnectionDto } from '@/lib/api/repo-connections';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';

interface Props {
    /** The Task's current extra repositories (connection ids + options). */
    value: TaskExtraRepo[];
    onChange: (next: TaskExtraRepo[]) => void;
    disabled?: boolean;
    /** Pre-loaded connections (tests, server-composed pages); loaded on mount when absent. */
    connections?: RepoConnectionDto[];
    testId?: string;
}

/**
 * "Also work in" — the repositories a Task spans in addition to its Work's
 * repository (multi-repo Task workspaces, self-build slice C / PR C2).
 *
 * A checkbox per repository connection in the owner's registry. Checked
 * connections become workspace mounts next to the primary worktree on a
 * fleet run, each with its own pull request when it changes; the mount
 * directory shown is the one the model will see (`.mounts/<dir>`).
 * Attachments of the run agent are mounted too and need no entry here.
 */
export function TaskExtraReposPicker({ value, onChange, disabled, connections, testId }: Props) {
    const t = useTranslations('dashboard.tasksPage.extraRepos');
    const [loaded, setLoaded] = useState<RepoConnectionDto[] | null>(connections ?? null);
    const [error, setError] = useState<string | null>(null);

    // Depends on `connections` only: `t` is a fresh function every render
    // and would re-run the fetch after each state update.
    useEffect(() => {
        if (connections) {
            setLoaded(connections);
            return;
        }
        let cancelled = false;
        void (async () => {
            try {
                const rows = await listRepoConnections();
                if (!cancelled) setLoaded(rows);
            } catch (err) {
                // Empty string = "use the translated generic message" at render.
                if (!cancelled) setError(err instanceof Error && err.message ? err.message : '');
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [connections]);

    const selected = useMemo(
        () => new Map(value.map((entry) => [entry.repoConnectionId, entry])),
        [value],
    );
    const enabledRows = useMemo(() => (loaded ?? []).filter((row) => row.enabled), [loaded]);

    const toggle = (row: RepoConnectionDto) => {
        if (disabled) return;
        if (selected.has(row.id)) {
            onChange(value.filter((entry) => entry.repoConnectionId !== row.id));
        } else {
            onChange([...value, { repoConnectionId: row.id }]);
        }
    };

    if (error !== null) {
        return (
            <p className="text-xs text-danger" data-testid={testId ? `${testId}-error` : undefined}>
                {error || t('loadError')}
            </p>
        );
    }
    if (loaded === null) {
        return (
            <p
                className="text-xs text-text-muted dark:text-text-muted-dark"
                data-testid={testId ? `${testId}-loading` : undefined}
            >
                {t('loading')}
            </p>
        );
    }
    if (enabledRows.length === 0) {
        return (
            <p
                className="text-xs text-text-muted dark:text-text-muted-dark"
                data-testid={testId ? `${testId}-empty` : undefined}
            >
                {t('empty')}{' '}
                <Link
                    href={ROUTES.DASHBOARD_SETTINGS_REPOSITORIES}
                    className="text-primary hover:underline"
                >
                    {t('emptyLink')}
                </Link>
            </p>
        );
    }

    return (
        <ul className="space-y-1" data-testid={testId}>
            {enabledRows.map((row) => {
                const checked = selected.has(row.id);
                return (
                    <li key={row.id}>
                        <label
                            className={`flex items-start gap-2 rounded-md border px-2 py-1.5 text-xs ${
                                checked
                                    ? 'border-primary/40 bg-primary/5'
                                    : 'border-border/60 dark:border-border-dark/60'
                            } ${disabled ? 'opacity-60' : 'cursor-pointer'}`}
                        >
                            <input
                                type="checkbox"
                                className="mt-0.5"
                                checked={checked}
                                disabled={disabled}
                                onChange={() => toggle(row)}
                                data-testid={testId ? `${testId}-${row.id}` : undefined}
                            />
                            <span className="min-w-0 flex-1">
                                <span className="flex items-center gap-1.5 text-text dark:text-text-dark">
                                    <GitBranch className="w-3.5 h-3.5 shrink-0 text-text-muted" />
                                    <span className="truncate font-medium">{row.name}</span>
                                </span>
                                <span className="block truncate text-text-muted dark:text-text-muted-dark">
                                    {row.url}
                                </span>
                                <span className="block font-mono text-[11px] text-text-muted dark:text-text-muted-dark">
                                    .mounts/{selected.get(row.id)?.mountDir || row.mountDir}
                                </span>
                            </span>
                        </label>
                    </li>
                );
            })}
        </ul>
    );
}
