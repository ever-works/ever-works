'use client';

import { Directory } from '@/lib/api/types-only';
import { cn } from '@/lib/utils/cn';
import { Button } from '@/components/ui/button';
import { useRouter } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { useTranslations } from 'next-intl';
import { GenerateStatusType, ItemsGeneratorSteps } from '@/lib/api/enums';
import { getStepText } from '@/lib/utils/generator-steps';

interface DirectoryStatusCardProps {
    directory: Directory;
}

export function DirectoryStatusCard({ directory }: DirectoryStatusCardProps) {
    const router = useRouter();
    const t = useTranslations('dashboard.directoryDetail.statusCard');
    const tProgress = useTranslations('dashboard.directoryDetail.progress');

    const getStatusConfig = () => {
        if (!directory.generateStatus) {
            return {
                title: t('notStarted.title'),
                description: t('notStarted.description'),
                color: 'border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/50',
                icon: (
                    <div className="w-12 h-12 rounded-full bg-gray-100 dark:bg-gray-800 flex items-center justify-center">
                        <svg
                            className="w-6 h-6 text-gray-600 dark:text-gray-400"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                        >
                            <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M12 6v6m0 0v6m0-6h6m-6 0H6"
                            />
                        </svg>
                    </div>
                ),
                action: (
                    <Button
                        onClick={() =>
                            router.push(`${ROUTES.DASHBOARD_DIRECTORY(directory.id)}/generator`)
                        }
                        variant="primary"
                    >
                        {t('notStarted.action')}
                    </Button>
                ),
            };
        }

        // Get proper step description
        const currentStep = directory.generateStatus.step as ItemsGeneratorSteps | undefined;
        const stepText = getStepText(currentStep, tProgress);

        const configs = {
            [GenerateStatusType.GENERATING]: {
                title: t('generating.title'),
                description: stepText || t('generating.description'),
                color: 'border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/20',
                icon: (
                    <div className="w-12 h-12 rounded-full bg-blue-100 dark:bg-blue-900 flex items-center justify-center">
                        <svg
                            className="animate-spin h-6 w-6 text-blue-600 dark:text-blue-400"
                            fill="none"
                            viewBox="0 0 24 24"
                        >
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
                    </div>
                ),
                action: (
                    <div className="flex items-center gap-2">
                        <div className="flex-1 bg-gray-200 dark:bg-gray-700 rounded-full h-2">
                            <div
                                className="bg-blue-600 h-2 rounded-full animate-pulse"
                                style={{ width: '60%' }}
                            />
                        </div>
                        <span className="text-sm text-text-muted dark:text-text-muted-dark">
                            {t('generating.processing')}
                        </span>
                    </div>
                ),
            },
            [GenerateStatusType.GENERATED]: {
                title: t('generated.title'),
                description: t('generated.description'),
                color: 'border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-900/20',
                icon: (
                    <div className="w-12 h-12 rounded-full bg-green-100 dark:bg-green-900 flex items-center justify-center">
                        <svg
                            className="w-6 h-6 text-green-600 dark:text-green-400"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                        >
                            <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
                            />
                        </svg>
                    </div>
                ),
                action: (
                    <div className="flex gap-2">
                        <Button
                            onClick={() =>
                                router.push(`${ROUTES.DASHBOARD_DIRECTORY(directory.id)}/items`)
                            }
                            variant="secondary"
                            size="sm"
                        >
                            {t('generated.viewItems')}
                        </Button>
                        <Button
                            onClick={() =>
                                router.push(`${ROUTES.DASHBOARD_DIRECTORY(directory.id)}/generator`)
                            }
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
                description: directory.generateStatus.error || t('error.description'),
                color: 'border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20',
                icon: (
                    <div className="w-12 h-12 rounded-full bg-red-100 dark:bg-red-900 flex items-center justify-center">
                        <svg
                            className="w-6 h-6 text-red-600 dark:text-red-400"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                        >
                            <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                            />
                        </svg>
                    </div>
                ),
                action: (
                    <Button
                        onClick={() =>
                            router.push(`${ROUTES.DASHBOARD_DIRECTORY(directory.id)}/generator`)
                        }
                        variant="primary"
                        size="sm"
                    >
                        {t('error.retry')}
                    </Button>
                ),
            },
        };

        return configs[directory.generateStatus.status];
    };

    const config = getStatusConfig();

    return (
        <div className={cn('rounded-lg border-2 p-6', config.color)}>
            <div className="flex items-start gap-4">
                {config.icon}
                <div className="flex-1">
                    <h3 className="text-lg font-semibold text-text dark:text-text-dark mb-1">
                        {config.title}
                    </h3>
                    <p className="text-sm text-text-secondary dark:text-text-secondary-dark mb-4">
                        {config.description}
                    </p>
                    {config.action}
                </div>
            </div>
        </div>
    );
}
