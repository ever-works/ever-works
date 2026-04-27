'use client';

import { useState } from 'react';
import { useSettings } from './SettingsContext';
import { RepositoryStatus, RepositoryType } from '@/lib/api/directory';
import { toggleRepositoryVisibility } from '@/app/actions/dashboard/directories';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription,
    DialogFooter,
    DialogClose,
} from '@/components/ui/dialog';
import { Lock, Unlock, AlertTriangle, GitBranch } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';

interface RepoVisibilitySettingsProps {
    initialRepositories: RepositoryStatus[];
}

export function RepoVisibilitySettings({ initialRepositories }: RepoVisibilitySettingsProps) {
    const { context } = useSettings();
    const { directory } = context;
    const t = useTranslations('dashboard.directoryDetail.settings');
    const tVisibility = useTranslations('common.visibility');
    const [repositories, setRepositories] = useState<RepositoryStatus[]>(initialRepositories);
    const [updating, setUpdating] = useState<RepositoryType | null>(null);
    const [pendingPrivateRepo, setPendingPrivateRepo] = useState<RepositoryStatus | null>(null);

    const handleToggleRequest = (repo: RepositoryStatus) => {
        const newIsPrivate = !repo.isPrivate;

        // If making private, show warning modal
        if (newIsPrivate) {
            setPendingPrivateRepo(repo);
        } else {
            // Making public - proceed directly
            executeToggle(repo);
        }
    };

    const handleConfirmMakePrivate = () => {
        if (pendingPrivateRepo) {
            executeToggle(pendingPrivateRepo);
            setPendingPrivateRepo(null);
        }
    };

    const handleCancelMakePrivate = () => {
        setPendingPrivateRepo(null);
    };

    const executeToggle = async (repo: RepositoryStatus) => {
        try {
            setUpdating(repo.type);
            const newIsPrivate = !repo.isPrivate;

            const result = await toggleRepositoryVisibility(directory.id, repo.type, newIsPrivate);

            if (result.success) {
                setRepositories((prev) =>
                    prev.map((r) => (r.type === repo.type ? { ...r, isPrivate: newIsPrivate } : r)),
                );

                toast.success(
                    t('visibilityUpdated', {
                        name: repo.name,
                        visibility: newIsPrivate ? tVisibility('private') : tVisibility('public'),
                    }),
                );
            } else {
                toast.error(result.error || t('visibilityUpdateFailed'));
            }
        } catch (error) {
            console.error('Failed to update repo visibility:', error);
            toast.error(t('visibilityUpdateFailed'));
        } finally {
            setUpdating(null);
        }
    };

    return (
        <div className="bg-card dark:bg-card-primary-dark/30 border border-card-border dark:border-border-secondary-dark rounded-lg overflow-hidden">
            <div className="px-5 py-3.5 border-b border-card-border dark:border-border-secondary-dark">
                <h3 className="text-sm font-semibold text-text dark:text-text-dark">
                    {t('repositoryVisibilityTitle')}
                </h3>
            </div>
            <div className="px-5 py-4 space-y-4">
                {repositories.map((repo) => (
                    <div
                        key={repo.type}
                        className="flex items-center justify-between p-3 border rounded-lg border-card-border dark:border-border-secondary-dark"
                    >
                        <div className="space-y-1">
                            <div className="flex items-center gap-2">
                                <span className="text-xs font-medium text-text dark:text-text-dark capitalize">
                                    {repo.type === 'directory'
                                        ? t('repositoryTypes.main')
                                        : repo.type === 'data'
                                          ? t('repositoryTypes.data')
                                          : t('repositoryTypes.website')}{' '}
                                    {t('repositoryTypeSuffix')}
                                </span>
                                {repo.isPrivate ? (
                                    <Lock className="h-3 w-3 text-text-muted dark:text-text-muted-dark" />
                                ) : (
                                    <Unlock className="h-3 w-3 text-text-muted dark:text-text-muted-dark" />
                                )}
                            </div>
                            <div className="text-xs text-text-muted dark:text-text-muted-dark flex items-center gap-1">
                                <GitBranch className="h-3 w-3" />
                                {repo.name}
                            </div>
                        </div>

                        <div className="flex items-center gap-3">
                            <span className="text-xs font-medium text-text dark:text-text-dark">
                                {repo.isPrivate ? tVisibility('private') : tVisibility('public')}
                            </span>
                            <Switch
                                checked={!repo.isPrivate}
                                onChange={() => handleToggleRequest(repo)}
                                disabled={updating === repo.type || !repo.exists}
                            />
                        </div>
                    </div>
                ))}
            </div>

            {/* Warning modal for making repository private */}
            <Dialog
                open={pendingPrivateRepo !== null}
                onOpenChange={(open) => !open && handleCancelMakePrivate()}
            >
                <DialogContent>
                    <DialogClose onClose={handleCancelMakePrivate} />
                    <DialogHeader>
                        <DialogTitle className="flex items-center gap-2 text-amber-600 dark:text-amber-500">
                            <AlertTriangle className="h-5 w-5" />
                            {t('visibilityWarningTitle')}
                        </DialogTitle>
                        <DialogDescription>
                            {t('visibilityWarningDescription', {
                                name: pendingPrivateRepo?.name ?? '',
                            })}
                        </DialogDescription>
                    </DialogHeader>

                    <div className="bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-lg p-4 my-4">
                        <p className="text-sm font-medium text-amber-800 dark:text-amber-200 mb-2">
                            {t('visibilityWarningPermanent')}
                        </p>
                        <ul className="text-sm text-amber-700 dark:text-amber-300 space-y-1 list-disc list-inside">
                            <li>{t('visibilityWarningStars')}</li>
                            <li>{t('visibilityWarningWatchers')}</li>
                            <li>{t('visibilityWarningNotRestored')}</li>
                        </ul>
                    </div>

                    <DialogFooter>
                        <Button
                            variant="secondary"
                            onClick={handleCancelMakePrivate}
                            disabled={updating !== null}
                        >
                            {t('cancel')}
                        </Button>
                        <Button
                            variant="danger"
                            onClick={handleConfirmMakePrivate}
                            loading={updating !== null}
                        >
                            {t('visibilityConfirmPrivate')}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}
