'use client';

import { Directory } from '@/lib/api/types-only';
import { cn } from '@/lib/utils/cn';
import { Button } from '@/components/ui/button';
import { useRouter } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { useTranslations } from 'next-intl';
import { GenerateStatusType } from '@/lib/api/enums';
import { getStepProgress, getStepText } from '@/lib/utils/generator-steps';

interface DirectoryStatusCardProps {
    directory: Directory;
}

export function DirectoryStatusCard({ directory }: DirectoryStatusCardProps) {
    const router = useRouter();
    const t = useTranslations('dashboard.directoryDetail.statusCard');
    const tProgress = useTranslations('dashboard.directoryDetail.progress');

    const generateStatus = directory.generateStatus;

    const getStatusConfig = (): {
        title: string;
        description: string;
        color: string;
        iconBg: string;
        iconColor: string;
        icon: React.ReactNode;
        action: React.ReactNode;
    } => {
        if (!generateStatus) {
            return {
                title: t('notStarted.title'),
                description: t('notStarted.description'),
                color: 'border-border dark:border-border-dark bg-surface-secondary/50 dark:bg-surface-secondary-dark/50',
                iconBg: 'bg-surface-tertiary dark:bg-surface-tertiary-dark',
                iconColor: 'text-text-muted dark:text-text-muted-dark',
                icon: (
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M12 6v6m0 0v6m0-6h6m-6 0H6"
                        />
                    </svg>
                ),
                action: (
                    <Button
                        onClick={() =>
                            router.push(`${ROUTES.DASHBOARD_DIRECTORY(directory.id)}/generator`)
                        }
                        variant="primary"
                        size="sm"
                    >
                        {t('notStarted.action')}
                    </Button>
                ),
            };
        }

        // Get dynamic step description from pipeline plugin
        const progressPercentage = getStepProgress(generateStatus);
        const stepText = getStepText(generateStatus, tProgress('steps.processing'));

        const configs = {
            [GenerateStatusType.GENERATING]: {
                title: t('generating.title'),
                description: stepText || t('generating.description'),
                color: 'border-primary/20 dark:border-primary/30 bg-primary/5 dark:bg-primary/10',
                iconBg: 'bg-primary/10 dark:bg-primary/20',
                iconColor: 'text-primary',
                icon: (
                    <svg className="animate-spin h-5 w-5" fill="none" viewBox="0 0 24 24">
                        <circle
                            className="opacity-25"
                            cx="12"
                            cy="12"
                            r="10"
                            stroke="currentColor"
                            strokeWidth="4"
                        />
                        <path
                            className="opacity-75"
                            fill="currentColor"
                            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                        />
                    </svg>
                ),
                action: (
                    <div className="w-full">
                        <div className="flex items-center justify-between text-xs text-text-muted dark:text-text-muted-dark mb-1">
                            <span>{t('generating.processing')}</span>
                            <span className="font-medium">{progressPercentage}%</span>
                        </div>
                        <div className="w-full h-1.5 bg-surface-tertiary dark:bg-surface-tertiary-dark rounded-full overflow-hidden">
                            <div
                                className="h-full bg-primary rounded-full transition-all duration-700 ease-out"
                                style={{ width: `${progressPercentage}%` }}
                            >
                                <div className="h-full bg-gradient-to-r from-primary via-primary to-primary/80 animate-gradient" />
                            </div>
                        </div>
                    </div>
                ),
            },
            [GenerateStatusType.GENERATED]: {
                title: t('generated.title'),
                description: t('generated.description'),
                color: 'border-success/20 dark:border-success/30 bg-success/5 dark:bg-success/10',
                iconBg: 'bg-success/10 dark:bg-success/20',
                iconColor: 'text-success',
                icon: (
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
                        />
                    </svg>
                ),
                action: (
                    <div className="flex gap-2">
                        <Button
                            href={`${ROUTES.DASHBOARD_DIRECTORY(directory.id)}/items`}
                            variant="secondary"
                            size="sm"
                        >
                            {t('generated.viewItems')}
                        </Button>
                        <Button
                            href={`${ROUTES.DASHBOARD_DIRECTORY(directory.id)}/generator`}
                            variant="ghost"
                            size="sm"
                        >
                            {t('generated.regenerate')}
                        </Button>
                    </div>
                ),
            },
            [GenerateStatusType.ERROR]: {
                title: t('error.title'),
                description: generateStatus.error || t('error.description'),
                color: 'border-danger/20 dark:border-danger/30 bg-danger/5 dark:bg-danger/10',
                iconBg: 'bg-danger/10 dark:bg-danger/20',
                iconColor: 'text-danger',
                icon: (
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                        />
                    </svg>
                ),
                action: (
                    <Button
                        href={`${ROUTES.DASHBOARD_DIRECTORY(directory.id)}/generator`}
                        variant="primary"
                        size="sm"
                    >
                        {t('error.retry')}
                    </Button>
                ),
            },
            [GenerateStatusType.CANCELLED]: {
                title: t('cancelled.title'),
                description: generateStatus.error || t('cancelled.description'),
                color: 'border-border dark:border-border-dark bg-gray-50 dark:bg-gray-900/40',
                iconBg: 'bg-gray-200 dark:bg-gray-800',
                iconColor: 'text-gray-600 dark:text-gray-200',
                icon: (
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M12 9v4m0 4h.01M10.29 3.86l-7.4 12.84a1 1 0 00.86 1.5h14.8a1 1 0 00.86-1.5l-7.4-12.84a1 1 0 00-1.72 0z"
                        />
                    </svg>
                ),
                action: (
                    <Button
                        href={`${ROUTES.DASHBOARD_DIRECTORY(directory.id)}/generator`}
                        variant="primary"
                        size="sm"
                    >
                        {t('cancelled.restart')}
                    </Button>
                ),
            },
        };

        return configs[generateStatus.status];
    };

    const config = getStatusConfig();

    return (
        <div className={cn('rounded-lg border', config.color)}>
            <div className="p-6">
                <div className="flex items-start gap-4">
                    <div
                        className={cn(
                            'w-10 h-10 rounded-lg flex items-center justify-center shrink-0',
                            config.iconBg,
                            config.iconColor,
                        )}
                    >
                        {config.icon}
                    </div>
                    <div className="flex-1 min-w-0">
                        <h3 className="font-semibold text-text dark:text-text-dark mb-1">
                            {config.title}
                        </h3>
                        <p className="text-sm text-text-secondary dark:text-text-secondary-dark mb-4">
                            {config.description}
                        </p>
                        {config.action}
                    </div>
                </div>
            </div>
        </div>
    );
}
