'use client';

import { useEffect, useTransition } from 'react';
import { Directory } from '@/lib/api';
import { cn } from '@/lib/utils/cn';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { Link, useRouter } from '@/i18n/navigation';
import { deployToVercel, updateWebsiteRepository } from '@/app/actions/dashboard/deploy';
import { RefreshCw, Info, Loader2, Triangle } from 'lucide-react';
import { useDirectoryDetail } from '../DirectoryDetailContext';
import { Button } from '@/components/ui/button';
import { pageIntervalRefresh } from '@/lib/utils';

interface DeployFormProps {
    directory: Directory;
    isDeploying?: boolean;
}

export function DeployForm({ directory, isDeploying }: DeployFormProps) {
    const t = useTranslations('dashboard.directoryDetail.deploy');
    const [isPending, startTransition] = useTransition();
    const router = useRouter();

    useEffect(() => {
        if (isDeploying) {
            return pageIntervalRefresh(router);
        }
    }, [isDeploying, router]);

    const handleDeploy = () => {
        startTransition(async () => {
            try {
                const result = await deployToVercel(directory.id);

                if (result.success && result.data) {
                    if (result.data.status === 'pending') {
                        toast.info(t('form.messages.deployPending'));

                        setTimeout(() => {
                            router.refresh();
                        }, 5000);
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

    return (
        <div className="space-y-6">
            {/* Deploy to Vercel Section */}
            <div className="rounded-lg bg-surface dark:bg-surface-dark border border-border dark:border-border-dark p-6">
                <div className="flex items-start gap-4">
                    <div
                        className={cn(
                            'flex-shrink-0 w-10 h-10 rounded-full flex items-center justify-center',
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
                            onClick={handleDeploy}
                            disabled={isPending || isDeploying}
                            size="lg"
                        >
                            {isDeploying ? (
                                <span className="flex items-center gap-2 capitalize">
                                    <Loader2 className="animate-spin h-4 w-4" />
                                    {t('form.deployToVercel.deployingStateButton', {
                                        state: directory.deploymentState || 'INITIALIZING',
                                    })}
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

            {/* Info Section */}
            <div className="p-6 rounded-lg bg-info/5 dark:bg-info-dark/5 border border-info/20 dark:border-info-dark/20">
                <div className="flex gap-3">
                    <Info className="flex-shrink-0 w-5 h-5 text-info dark:text-info-dark mt-0.5" />
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
                        'flex-shrink-0 w-10 h-10 rounded-full flex items-center justify-center',
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
