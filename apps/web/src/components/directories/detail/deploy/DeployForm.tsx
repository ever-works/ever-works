'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import type { Directory, VercelTeam } from '@/lib/api';
import { cn } from '@/lib/utils/cn';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { Link, useRouter } from '@/i18n/navigation';
import {
    deployToVercel,
    getVercelTeams,
    lookupExistingDeployment,
    updateWebsiteRepository,
    updateWebsiteTemplateSettings,
} from '@/app/actions/dashboard/deploy';
import { RefreshCw, Info, Loader2, Triangle, Settings2, AlertCircle } from 'lucide-react';
import { useDirectoryDetail } from '../DirectoryDetailContext';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { pageIntervalRefresh } from '@/lib/utils';
import { VercelTeamSelectionDialog } from './VercelTeamSelectionDialog';
import { formatDistanceToNow } from 'date-fns';

interface DeployFormProps {
    directory: Directory;
    isDeploying?: boolean;
}

export function DeployForm({ directory, isDeploying }: DeployFormProps) {
    const t = useTranslations('dashboard.directoryDetail.deploy');
    const [isPending, startTransition] = useTransition();
    const router = useRouter();
    const [isTeamDialogOpen, setIsTeamDialogOpen] = useState(false);
    const [vercelTeams, setVercelTeams] = useState<VercelTeam[]>([]);

    const hasVercelTeams = vercelTeams.length > 0;
    const setHasCheckedExisting = useRef(false);

    useEffect(() => {
        if (isDeploying) {
            const cleanup = pageIntervalRefresh(router);
            return cleanup;
        }
    }, [isDeploying, router]);

    useEffect(() => {
        getVercelTeams().then((res) => {
            setVercelTeams(res.teams || []);
        });
    }, []);

    useEffect(() => {
        if (directory.website || setHasCheckedExisting.current) {
            return;
        }

        setHasCheckedExisting.current = true;
        startTransition(async () => {
            const result = await lookupExistingDeployment(directory.id).catch(() => null);
            if (result?.success && result.website) {
                router.refresh();
            }
        });
    }, [directory.id, directory.website, router]);

    const runDeploy = (teamScope?: string) => {
        startTransition(async () => {
            try {
                const result = await deployToVercel(directory.id, teamScope);

                if (result.success && result.data) {
                    if (result.data.status === 'pending') {
                        toast.info(t('form.messages.deployPending'));
                        setTimeout(() => router.refresh(), 3000);
                    } else if (result.data.status === 'success') {
                        toast.success(t('form.messages.deploySuccess'));
                    }
                } else {
                    toast.error(result.error || t('form.messages.deployFailed'));
                }
            } catch (error) {
                console.error('Deployment failed:', error);
                toast.error(t('form.messages.deployError'));
            }
        });
    };

    const handleDeployClick = () => {
        if (isPending || isDeploying) {
            return;
        }

        if (!hasVercelTeams) {
            runDeploy();
            return;
        }

        setIsTeamDialogOpen(true);
    };

    const handleConfirmDeploy = (teamScope: string) => {
        setIsTeamDialogOpen(false);
        runDeploy(teamScope);
    };

    return (
        <div className="space-y-6">
            <VercelTeamSelectionDialog
                open={isTeamDialogOpen}
                teams={vercelTeams}
                isSubmitting={isPending || isDeploying}
                onConfirm={handleConfirmDeploy}
                onCancel={() => setIsTeamDialogOpen(false)}
            />

            {/* Deploy to Vercel Section */}
            <div className="rounded-lg bg-surface dark:bg-surface-dark border border-border dark:border-border-dark p-6">
                <div className="flex items-start gap-4">
                    <div
                        className={cn(
                            'shrink-0 w-10 h-10 rounded-full flex items-center justify-center',
                            'bg-primary/10 dark:bg-primary-dark/10',
                        )}
                    >
                        <Triangle className="w-5 h-5 text-primary dark:text-primary-dark fill-current" />
                    </div>

                    <div className="flex-1">
                        <h3 className="text-lg font-semibold text-text dark:text-text-dark mb-2">
                            {t('form.deployToVercel.title')}
                        </h3>
                        <p className="text-text-secondary dark:text-text-secondary-dark mb-4">
                            {t('form.deployToVercel.description')}
                        </p>

                        {directory.website && (
                            <div className="mb-4 p-4 rounded-lg bg-success/10 dark:bg-success-dark/10 border border-success/20 dark:border-success-dark/20">
                                {directory.deploymentState === 'READY' && (
                                    <p className="text-sm text-success dark:text-success-dark mb-2">
                                        {t('form.deployToVercel.successMessage')}
                                    </p>
                                )}

                                <a
                                    href={directory.website}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-sm text-primary dark:text-primary-dark hover:underline break-all"
                                >
                                    {directory.website}
                                </a>
                            </div>
                        )}

                        <Button
                            onClick={handleDeployClick}
                            disabled={isPending || isDeploying}
                            size="lg"
                        >
                            {isPending || isDeploying ? (
                                <span className="flex items-center gap-2 capitalize">
                                    <Loader2 className="animate-spin h-4 w-4" />

                                    {isDeploying
                                        ? t('form.deployToVercel.deployingStateButton', {
                                              state: (
                                                  directory.deploymentState || 'INITIALIZING'
                                              ).toLowerCase(),
                                          })
                                        : t('form.deployToVercel.deployButton')}
                                </span>
                            ) : (
                                t('form.deployToVercel.deployButton')
                            )}
                        </Button>
                    </div>
                </div>
            </div>

            {/* Update Repository Section */}
            <UpdateWebsiteRepository directory={directory} />

            {/* Website Template Settings Section */}
            <WebsiteTemplateSettings directory={directory} />

            {/* Info Section */}
            <div className="p-6 rounded-lg bg-info/5 dark:bg-info-dark/5 border border-info/20 dark:border-info-dark/20 hidden">
                <div className="flex gap-3">
                    <Info className="shrink-0 w-5 h-5 text-info dark:text-info-dark mt-0.5" />
                    <div className="space-y-2 text-sm text-text-secondary dark:text-text-secondary-dark">
                        <p>{t('form.info.deployInfo')}</p>
                        <p>{t('form.info.updateInfo')}</p>
                    </div>
                </div>
            </div>
        </div>
    );
}

function UpdateWebsiteRepository({ directory }: DeployFormProps) {
    const t = useTranslations('dashboard.directoryDetail.deploy');
    const { repoLinks } = useDirectoryDetail();
    const [isPending, startTransition] = useTransition();
    const router = useRouter();

    const handleUpdateRepository = () => {
        startTransition(async () => {
            try {
                const result = await updateWebsiteRepository(directory.id);

                if (result.success) {
                    toast.success(t('form.messages.updateSuccess'));
                    router.refresh();
                } else {
                    toast.error(result.error || t('form.messages.updateFailed'));
                }
            } catch (error) {
                console.error('Update repository failed:', error);
                toast.error(t('form.messages.updateError'));
            }
        });
    };

    return (
        <div className="rounded-lg bg-surface dark:bg-surface-dark border border-border dark:border-border-dark p-6">
            <div className="flex items-start gap-4">
                <div
                    className={cn(
                        'shrink-0 w-10 h-10 rounded-full flex items-center justify-center',
                        'bg-info/10 dark:bg-info-dark/10',
                    )}
                >
                    <RefreshCw className="w-5 h-5 text-info dark:text-info-dark" />
                </div>
                <div className="flex-1">
                    <h3 className="text-lg font-semibold text-text dark:text-text-dark mb-2">
                        {t('form.updateRepository.title')}
                    </h3>
                    <p className="text-text-secondary dark:text-text-secondary-dark mb-4">
                        {t('form.updateRepository.description')}{' '}
                        <Link
                            href={repoLinks?.websiteRepo || '#'}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-primary hover:text-primary-hover"
                        >
                            {t('form.updateRepository.websiteRepository')}
                        </Link>
                    </p>

                    <Button
                        onClick={handleUpdateRepository}
                        disabled={isPending}
                        variant="secondary"
                    >
                        {isPending
                            ? t('form.updateRepository.updatingButton')
                            : t('form.updateRepository.updateButton')}
                    </Button>
                </div>
            </div>
        </div>
    );
}

function WebsiteTemplateSettings({ directory }: DeployFormProps) {
    const t = useTranslations('dashboard.directoryDetail.deploy');
    const [isPending, startTransition] = useTransition();
    const router = useRouter();
    const [autoUpdate, setAutoUpdate] = useState(directory.websiteTemplateAutoUpdate ?? false);
    const [useBeta, setUseBeta] = useState(directory.websiteTemplateUseBeta ?? false);

    const handleAutoUpdateChange = (checked: boolean) => {
        setAutoUpdate(checked);
        startTransition(async () => {
            try {
                const result = await updateWebsiteTemplateSettings(directory.id, {
                    websiteTemplateAutoUpdate: checked,
                });

                if (result.success) {
                    toast.success(t('form.websiteTemplate.updateSuccess'));
                    router.refresh();
                } else if ('requiresGitHub' in result && result.requiresGitHub) {
                    setAutoUpdate(!checked); // Revert on failure
                    toast.error(t('form.websiteTemplate.githubRequired'));
                } else {
                    setAutoUpdate(!checked); // Revert on failure
                    toast.error(result.error || t('form.websiteTemplate.updateFailed'));
                }
            } catch (error) {
                setAutoUpdate(!checked); // Revert on failure
                console.error('Update auto-update setting failed:', error);
                toast.error(t('form.websiteTemplate.updateFailed'));
            }
        });
    };

    const handleUseBetaChange = (checked: boolean) => {
        setUseBeta(checked);
        startTransition(async () => {
            try {
                const result = await updateWebsiteTemplateSettings(directory.id, {
                    websiteTemplateUseBeta: checked,
                });

                if (result.success) {
                    toast.success(t('form.websiteTemplate.updateSuccess'));
                    router.refresh();
                } else {
                    setUseBeta(!checked); // Revert on failure
                    toast.error(result.error || t('form.websiteTemplate.updateFailed'));
                }
            } catch (error) {
                setUseBeta(!checked); // Revert on failure
                console.error('Update use beta setting failed:', error);
                toast.error(t('form.websiteTemplate.updateFailed'));
            }
        });
    };

    const formatDate = (dateString: string | null | undefined) => {
        if (!dateString) return null;
        try {
            return formatDistanceToNow(new Date(dateString), { addSuffix: true });
        } catch {
            return null;
        }
    };

    const lastUpdated = formatDate(directory.websiteTemplateLastUpdatedAt);
    const lastChecked = formatDate(directory.websiteTemplateLastCheckedAt);
    const hasError = Boolean(directory.websiteTemplateLastError);

    return (
        <div className="rounded-lg bg-surface dark:bg-surface-dark border border-border dark:border-border-dark p-6">
            <div className="flex items-start gap-4">
                <div
                    className={cn(
                        'shrink-0 w-10 h-10 rounded-full flex items-center justify-center',
                        'bg-accent/10 dark:bg-accent-dark/10',
                    )}
                >
                    <Settings2 className="w-5 h-5 text-accent dark:text-accent-dark" />
                </div>
                <div className="flex-1">
                    <h3 className="text-lg font-semibold text-text dark:text-text-dark mb-2">
                        {t('form.websiteTemplate.title')}
                    </h3>
                    <p className="text-text-secondary dark:text-text-secondary-dark mb-4">
                        {t('form.websiteTemplate.description')}
                    </p>

                    <div className="space-y-4">
                        <Switch
                            checked={autoUpdate}
                            onChange={handleAutoUpdateChange}
                            disabled={isPending}
                            label={t('form.websiteTemplate.autoUpdate')}
                            helperText={t('form.websiteTemplate.autoUpdateDescription')}
                        />

                        <Switch
                            checked={useBeta}
                            onChange={handleUseBetaChange}
                            disabled={isPending}
                            label={t('form.websiteTemplate.useBeta')}
                            helperText={t('form.websiteTemplate.useBetaDescription')}
                        />

                        {/* Status display */}
                        {(lastUpdated || lastChecked) && (
                            <div className="mt-4 pt-4 border-t border-border dark:border-border-dark">
                                <div className="text-sm text-text-secondary dark:text-text-secondary-dark space-y-1">
                                    {lastUpdated && (
                                        <p>
                                            <span className="font-medium">
                                                {t('form.websiteTemplate.lastUpdated')}:
                                            </span>{' '}
                                            {lastUpdated}
                                        </p>
                                    )}
                                    {lastChecked && (
                                        <p>
                                            <span className="font-medium">
                                                {t('form.websiteTemplate.lastChecked')}:
                                            </span>{' '}
                                            {lastChecked}
                                        </p>
                                    )}
                                </div>
                            </div>
                        )}

                        {/* Error display */}
                        {hasError && (
                            <div className="mt-4 p-3 rounded-lg bg-error/10 dark:bg-error-dark/10 border border-error/20 dark:border-error-dark/20">
                                <div className="flex gap-2 items-start">
                                    <AlertCircle className="shrink-0 w-4 h-4 text-error dark:text-error-dark mt-0.5" />
                                    <div>
                                        <p className="text-sm font-medium text-error dark:text-error-dark">
                                            {t('form.websiteTemplate.lastError')}
                                        </p>
                                        <p className="text-sm text-text-secondary dark:text-text-secondary-dark mt-1">
                                            {directory.websiteTemplateLastError}
                                        </p>
                                    </div>
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}
