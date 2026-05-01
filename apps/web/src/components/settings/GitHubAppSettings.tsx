'use client';

import { useState } from 'react';
import { useRouter } from '@/i18n/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Github, Import, RefreshCw, ShieldCheck, ShieldOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { CollapsibleCard } from '@/components/ui/collapsible-card';
import type { GitHubAppInstallationDto } from '@/lib/api/github-app';
import { onboardGitHubAppRepository, syncGitHubAppInstallation } from '@/app/actions/github-app';
import { ROUTES } from '@/lib/constants';

interface GitHubAppSettingsProps {
    installations: GitHubAppInstallationDto[];
}

export function GitHubAppSettings({ installations: initialInstallations }: GitHubAppSettingsProps) {
    const t = useTranslations('dashboard.settings.githubApp');
    const router = useRouter();
    const [installations, setInstallations] = useState(initialInstallations);
    const [pendingInstallationId, setPendingInstallationId] = useState<string | null>(null);
    const [pendingRepositoryId, setPendingRepositoryId] = useState<string | null>(null);

    const handleSync = async (installationId: string) => {
        setPendingInstallationId(installationId);

        try {
            const result = await syncGitHubAppInstallation(installationId);

            if (!result.success || !result.data) {
                toast.error(result.error || t('syncError'));
                return;
            }

            setInstallations((current) =>
                current.map((installation) =>
                    installation.installationId === installationId ? result.data : installation,
                ),
            );
            toast.success(t('syncSuccess'));
        } catch {
            toast.error(t('syncError'));
        } finally {
            setPendingInstallationId(null);
        }
    };

    const handleOnboard = async (installationId: string, repositoryId: string) => {
        setPendingRepositoryId(repositoryId);

        try {
            const result = await onboardGitHubAppRepository(installationId, repositoryId);

            if (!result.success || !result.data) {
                toast.error(result.error || t('onboardError'));
                return;
            }

            toast.success(result.data.message || t('onboardSuccess'));

            if (result.data.directoryId) {
                router.push(ROUTES.DASHBOARD_DIRECTORY(result.data.directoryId));
            }
        } catch {
            toast.error(t('onboardError'));
        } finally {
            setPendingRepositoryId(null);
        }
    };

    if (installations.length === 0) {
        return (
            <div className="rounded-xl border border-dashed border-border/70 bg-surface/40 p-8 text-center dark:border-border-dark/70 dark:bg-surface-dark/20">
                <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl border border-border/60 bg-card dark:border-border-dark/60 dark:bg-card-primary-dark">
                    <Github className="h-5 w-5 text-text-muted dark:text-text-muted-dark" />
                </div>
                <h2 className="mt-4 text-lg font-semibold text-text dark:text-text-dark">
                    {t('emptyTitle')}
                </h2>
                <p className="mx-auto mt-2 max-w-xl text-sm leading-relaxed text-text-muted dark:text-text-muted-dark">
                    {t('emptyDescription')}
                </p>
            </div>
        );
    }

    return (
        <div className="space-y-4">
            <div>
                <h2 className="text-xl font-semibold text-text dark:text-text-dark">
                    {t('title')}
                </h2>
                <p className="mt-1 text-sm text-text-muted dark:text-text-muted-dark">
                    {t('subtitle')}
                </p>
            </div>

            {installations.map((installation) => {
                const isSyncing = pendingInstallationId === installation.installationId;
                const repositoryCount = installation.repositories.length;

                return (
                    <CollapsibleCard
                        key={installation.id}
                        defaultExpanded={repositoryCount > 0}
                        className="overflow-hidden border-border/60 bg-card dark:border-border-dark/60 dark:bg-card-primary-dark"
                        headerClassName="bg-card dark:bg-card-primary-dark"
                        bodyClassName="bg-surface/30 dark:bg-surface-dark/10"
                        header={
                            <div className="flex min-w-0 items-center gap-3">
                                <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-border/60 bg-surface-secondary dark:border-border-dark/60 dark:bg-surface-secondary-dark">
                                    <Github className="h-4 w-4 text-text dark:text-text-dark" />
                                </div>
                                <div className="min-w-0">
                                    <div className="flex items-center gap-2">
                                        <p className="truncate text-sm font-semibold text-text dark:text-text-dark">
                                            {installation.accountLogin}
                                        </p>
                                        {installation.suspendedAt ? (
                                            <span className="inline-flex items-center gap-1 rounded-full border border-warning/30 bg-warning/10 px-2 py-0.5 text-[11px] font-medium text-warning">
                                                <ShieldOff className="h-3 w-3" />
                                                {t('suspended')}
                                            </span>
                                        ) : (
                                            <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
                                                <ShieldCheck className="h-3 w-3" />
                                                {t('active')}
                                            </span>
                                        )}
                                    </div>
                                    <p className="mt-1 text-xs text-text-muted dark:text-text-muted-dark">
                                        {t('installationMeta', {
                                            installationId: installation.installationId,
                                            accountType: installation.accountType,
                                            targetType: installation.targetType,
                                        })}
                                    </p>
                                </div>
                            </div>
                        }
                        actions={
                            <Button
                                type="button"
                                variant="secondary"
                                size="sm"
                                loading={isSyncing}
                                onClick={() => handleSync(installation.installationId)}
                                className="h-8 px-3 text-xs"
                            >
                                <RefreshCw className="h-3.5 w-3.5" />
                                {t('sync')}
                            </Button>
                        }
                    >
                        <div className="space-y-4 p-5">
                            <div className="grid gap-3 sm:grid-cols-3">
                                <div className="rounded-lg border border-border/60 bg-card/80 p-3 dark:border-border-dark/60 dark:bg-card-primary-dark/60">
                                    <p className="text-[11px] uppercase tracking-wide text-text-muted dark:text-text-muted-dark">
                                        {t('repoCount')}
                                    </p>
                                    <p className="mt-1 text-sm font-semibold text-text dark:text-text-dark">
                                        {repositoryCount}
                                    </p>
                                </div>
                                <div className="rounded-lg border border-border/60 bg-card/80 p-3 dark:border-border-dark/60 dark:bg-card-primary-dark/60">
                                    <p className="text-[11px] uppercase tracking-wide text-text-muted dark:text-text-muted-dark">
                                        {t('updatedAt')}
                                    </p>
                                    <p className="mt-1 text-sm font-semibold text-text dark:text-text-dark">
                                        {new Date(installation.updatedAt).toLocaleString()}
                                    </p>
                                </div>
                                <div className="rounded-lg border border-border/60 bg-card/80 p-3 dark:border-border-dark/60 dark:bg-card-primary-dark/60">
                                    <p className="text-[11px] uppercase tracking-wide text-text-muted dark:text-text-muted-dark">
                                        {t('appSlug')}
                                    </p>
                                    <p className="mt-1 truncate text-sm font-semibold text-text dark:text-text-dark">
                                        {installation.appSlug || 'ever-works'}
                                    </p>
                                </div>
                            </div>

                            <div>
                                <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-text-muted dark:text-text-muted-dark">
                                    {t('repositories')}
                                </p>

                                {repositoryCount === 0 ? (
                                    <div className="rounded-lg border border-dashed border-border/70 p-4 text-sm text-text-muted dark:border-border-dark/70 dark:text-text-muted-dark">
                                        {t('noRepositories')}
                                    </div>
                                ) : (
                                    <div className="space-y-2">
                                        {installation.repositories.map((repository) => (
                                            <div
                                                key={repository.id}
                                                className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-card/80 px-4 py-3 dark:border-border-dark/60 dark:bg-card-primary-dark/60"
                                            >
                                                <div className="min-w-0">
                                                    <p className="truncate text-sm font-medium text-text dark:text-text-dark">
                                                        {repository.fullName}
                                                    </p>
                                                    <p className="mt-1 text-xs text-text-muted dark:text-text-muted-dark">
                                                        {repository.defaultBranch
                                                            ? t('branch', {
                                                                  branch: repository.defaultBranch,
                                                              })
                                                            : t('branchUnknown')}
                                                    </p>
                                                </div>
                                                <div className="flex shrink-0 items-center gap-2">
                                                    <span className="rounded-full border border-border/70 px-2.5 py-1 text-[11px] font-medium text-text-muted dark:border-border-dark/70 dark:text-text-muted-dark">
                                                        {repository.isPrivate
                                                            ? t('private')
                                                            : t('public')}
                                                    </span>
                                                    <Button
                                                        type="button"
                                                        variant="secondary"
                                                        size="sm"
                                                        loading={pendingRepositoryId === repository.id}
                                                        onClick={() =>
                                                            handleOnboard(
                                                                installation.installationId,
                                                                repository.id,
                                                            )
                                                        }
                                                        className="h-8 px-3 text-xs"
                                                    >
                                                        <Import className="h-3.5 w-3.5" />
                                                        {t('onboard')}
                                                    </Button>
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                        </div>
                    </CollapsibleCard>
                );
            })}
        </div>
    );
}
