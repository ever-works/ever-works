'use client';

import { Directory } from '@/lib/api/types-only';
import { cn } from '@/lib/utils/cn';
import { getGenerationStatusConfig } from '@/lib/utils/generation-status';
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
    const hasWarnings = !!generateStatus?.warnings?.length;
    const statusStyle = getGenerationStatusConfig(generateStatus?.status, { hasWarnings });
    const StatusIcon = statusStyle.icon;

    const getStatusContent = (): {
        title: string;
        description: string;
        action: React.ReactNode;
    } => {
        if (!generateStatus) {
            return {
                title: t('notStarted.title'),
                description: t('notStarted.description'),
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
                description: generateStatus.warnings?.length ? '' : t('generated.description'),
                action: (
                    <div>
                        {generateStatus.warnings?.length ? (
                            <div className="mb-3 rounded-md bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 px-3 py-2">
                                <p className="text-xs font-medium text-amber-800 dark:text-amber-300 mb-1">
                                    {t('generated.withWarnings')}
                                </p>
                                <ul className="space-y-0.5">
                                    {generateStatus.warnings.map((warning, i) => (
                                        <li
                                            key={i}
                                            className="text-xs text-amber-700 dark:text-amber-400 flex items-start gap-1.5"
                                        >
                                            <span className="shrink-0 mt-0.5">&#x2022;</span>
                                            <span>{warning}</span>
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        ) : null}
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
                    </div>
                ),
            },
            [GenerateStatusType.ERROR]: {
                title: t('error.title'),
                description: generateStatus.error || t('error.description'),
                action: (
                    <div>
                        {generateStatus.warnings?.length ? (
                            <div className="mb-3 rounded-md bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 px-3 py-2">
                                <p className="text-xs font-medium text-amber-800 dark:text-amber-300 mb-1">
                                    {t('generated.withWarnings')}
                                </p>
                                <ul className="space-y-0.5">
                                    {generateStatus.warnings.map((warning, i) => (
                                        <li
                                            key={i}
                                            className="text-xs text-amber-700 dark:text-amber-400 flex items-start gap-1.5"
                                        >
                                            <span className="shrink-0 mt-0.5">&#x2022;</span>
                                            <span>{warning}</span>
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        ) : null}
                        <Button
                            href={`${ROUTES.DASHBOARD_DIRECTORY(directory.id)}/generator`}
                            variant="primary"
                            size="sm"
                        >
                            {t('error.retry')}
                        </Button>
                    </div>
                ),
            },
            [GenerateStatusType.CANCELLED]: {
                title: t('cancelled.title'),
                description: generateStatus.error || t('cancelled.description'),
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

    const config = getStatusContent();

    return (
        <div className={cn('rounded-lg border', statusStyle.card.borderBg)}>
            <div className="p-6">
                <div className="flex items-start gap-4">
                    <div
                        className={cn(
                            'w-10 h-10 rounded-lg flex items-center justify-center shrink-0',
                            statusStyle.card.iconBg,
                            statusStyle.card.iconColor,
                        )}
                    >
                        <StatusIcon
                            className={cn('w-5 h-5', statusStyle.animate && 'animate-spin')}
                        />
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
