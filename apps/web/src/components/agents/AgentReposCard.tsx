'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { FolderGit2 } from 'lucide-react';
import Link from 'next/link';
import { Switch } from '@/components/ui/switch';
import { ROUTES } from '@/lib/constants';
import type { AgentRepoDto } from '@/lib/api/repo-connections';
import { removeAgentRepoAttachment, setAgentRepoAttachment } from '@/app/actions/repo-connections';

interface AgentReposCardProps {
    agentId: string;
    repos: AgentRepoDto[];
}

/**
 * Repository registry (Feature G) — minimal "Repositories" section on
 * the agent settings page: every registry repo with an attach toggle.
 * Additive and movable; the per-agent Capabilities page absorbs this
 * card when it ships.
 */
export function AgentReposCard({ agentId, repos: initialRepos }: AgentReposCardProps) {
    const t = useTranslations('dashboard.settings.repositories.agentCard');
    const [repos, setRepos] = useState(initialRepos);
    const [pendingId, setPendingId] = useState<string | null>(null);

    const handleToggle = async (repo: AgentRepoDto, next: boolean) => {
        setPendingId(repo.id);
        try {
            const result = next
                ? await setAgentRepoAttachment(agentId, repo.id, true)
                : await removeAgentRepoAttachment(agentId, repo.id);
            if (!result.success) {
                toast.error(result.error || t('toggleError'));
                return;
            }
            setRepos((current) =>
                current.map((row) =>
                    row.id === repo.id ? { ...row, attached: next, attachmentEnabled: next } : row,
                ),
            );
        } finally {
            setPendingId(null);
        }
    };

    return (
        <div
            className="rounded-xl border border-border/60 bg-card p-5 dark:border-border-dark/60 dark:bg-card-primary-dark"
            data-testid="agent-repos-card"
        >
            <div className="flex items-center gap-2">
                <FolderGit2 className="h-4 w-4 text-text-muted dark:text-text-muted-dark" />
                <h3 className="text-sm font-semibold text-text dark:text-text-dark">
                    {t('title')}
                </h3>
            </div>
            <p className="mt-1 text-xs text-text-muted dark:text-text-muted-dark">
                {t('subtitle')}
            </p>

            {repos.length === 0 ? (
                <p className="mt-4 text-sm text-text-muted dark:text-text-muted-dark">
                    {t('empty')}{' '}
                    <Link
                        href={ROUTES.DASHBOARD_SETTINGS_REPOSITORIES}
                        className="text-info underline-offset-2 hover:underline"
                    >
                        {t('manageLink')}
                    </Link>
                </p>
            ) : (
                <div className="mt-4 space-y-2">
                    {repos.map((repo) => (
                        <div
                            key={repo.id}
                            className="flex items-center justify-between gap-3 rounded-lg border border-border/50 px-3 py-2.5 dark:border-border-dark/50"
                        >
                            <div className="min-w-0">
                                <p className="truncate text-sm font-medium text-text dark:text-text-dark">
                                    {repo.name}
                                </p>
                                <p className="truncate text-xs text-text-muted dark:text-text-muted-dark">
                                    {repo.url}
                                </p>
                            </div>
                            <Switch
                                checked={repo.attached && repo.attachmentEnabled}
                                disabled={pendingId === repo.id}
                                onChange={(checked) => handleToggle(repo, checked)}
                                data-testid={`agent-repo-toggle-${repo.name}`}
                            />
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
