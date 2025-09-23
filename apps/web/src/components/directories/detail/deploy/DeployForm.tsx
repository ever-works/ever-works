'use client';

import { useState, useTransition } from 'react';
import { Directory } from '@/lib/api';
import { cn } from '@/lib/utils/cn';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { useRouter } from '@/i18n/navigation';
import { deployToVercel, updateWebsiteRepository } from '@/app/actions/dashboard/deploy';
import { RefreshCw, Info, Loader2, Triangle } from 'lucide-react';

interface DeployFormProps {
    directory: Directory;
}

export function DeployForm({ directory }: DeployFormProps) {
    const t = useTranslations('dashboard.directoryDetail.deploy');
    const router = useRouter();
    const [isPending, startTransition] = useTransition();
    const [deploymentStatus, setDeploymentStatus] = useState<
        'idle' | 'deploying' | 'success' | 'error'
    >('idle');

    const [deploymentUrl, setDeploymentUrl] = useState<string>('');

    const handleDeploy = () => {
        startTransition(async () => {
            try {
                setDeploymentStatus('deploying');
                const result = await deployToVercel(directory.id);

                if (result.success && result.data) {
                    if (result.data.status === 'success') {
                        setDeploymentStatus('success');
                        setDeploymentUrl(result.data.deployment_url || '');
                        toast.success(t('form.messages.deploySuccess'));
                    } else if (result.data.status === 'pending') {
                        setDeploymentStatus('success');
                        toast.info(t('form.messages.deployPending'));
                    }
                } else {
                    setDeploymentStatus('error');
                    toast.error(result.error || t('form.messages.deployFailed'));
                }
            } catch (error) {
                setDeploymentStatus('error');
                console.error('Deployment failed:', error);
                toast.error(t('form.messages.deployError'));
            }
        });
    };

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

                        {deploymentStatus === 'success' && deploymentUrl && (
                            <div className="mb-4 p-4 rounded-lg bg-success/10 dark:bg-success-dark/10 border border-success/20 dark:border-success-dark/20">
                                <p className="text-sm text-success dark:text-success-dark mb-2">
                                    {t('form.deployToVercel.successMessage')}
                                </p>
                                <a
                                    href={deploymentUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-sm text-primary dark:text-primary-dark hover:underline break-all"
                                >
                                    {deploymentUrl}
                                </a>
                            </div>
                        )}

                        <button
                            onClick={handleDeploy}
                            disabled={isPending || deploymentStatus === 'deploying'}
                            className={cn(
                                'px-6 py-2 rounded-lg font-medium transition-colors',
                                'bg-primary dark:bg-primary-dark text-white',
                                'hover:bg-primary/90 dark:hover:bg-primary-dark/90',
                                'disabled:opacity-50 disabled:cursor-not-allowed',
                            )}
                        >
                            {deploymentStatus === 'deploying' ? (
                                <span className="flex items-center gap-2">
                                    <Loader2 className="animate-spin h-4 w-4" />
                                    {t('form.deployToVercel.deployingButton')}
                                </span>
                            ) : (
                                t('form.deployToVercel.deployButton')
                            )}
                        </button>
                    </div>
                </div>
            </div>

            {/* Update Repository Section */}
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
                            {t('form.updateRepository.description')}
                        </p>

                        <button
                            onClick={handleUpdateRepository}
                            disabled={isPending}
                            className={cn(
                                'px-6 py-2 rounded-lg font-medium transition-colors',
                                'bg-surface-secondary dark:bg-surface-secondary-dark',
                                'text-text dark:text-text-dark',
                                'hover:bg-surface-hover dark:hover:bg-surface-hover-dark',
                                'disabled:opacity-50 disabled:cursor-not-allowed',
                            )}
                        >
                            {isPending
                                ? t('form.updateRepository.updatingButton')
                                : t('form.updateRepository.updateButton')}
                        </button>
                    </div>
                </div>
            </div>

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
