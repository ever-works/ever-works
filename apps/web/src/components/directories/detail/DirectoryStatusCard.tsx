'use client';

import { useState } from 'react';
import { Directory } from '@/lib/api/types-only';
import { cn } from '@/lib/utils/cn';
import { getGenerationStatusConfig } from '@/lib/utils/generation-status';
import { Button } from '@/components/ui/button';
import { useRouter } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { useTranslations } from 'next-intl';
import { GenerateStatusType } from '@/lib/api/enums';
import { getStepProgress, getStepText, getItemsProcessedText } from '@/lib/utils/generator-steps';
import { Terminal } from 'lucide-react';
import { TerminalLogViewer } from './shared/TerminalLogViewer';

interface DirectoryStatusCardProps {
    directory: Directory;
}

export function DirectoryStatusCard({ directory }: DirectoryStatusCardProps) {
    const router = useRouter();
    const t = useTranslations('dashboard.directoryDetail.statusCard');
    const tProgress = useTranslations('dashboard.directoryDetail.progress');
    const [showLogs, setShowLogs] = useState(false);

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
        const itemsText = getItemsProcessedText(generateStatus);

        const recentLogs = generateStatus.recentLogs;
        const hasLogs = recentLogs && recentLogs.length > 0;
        const isGenerating = generateStatus.status === GenerateStatusType.GENERATING;

        const logsSection = hasLogs ? (
            <>
                <button
                    type="button"
                    onClick={() => setShowLogs((prev) => !prev)}
                    className={cn(
                        'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                        showLogs
                            ? 'bg-primary/10 text-primary dark:bg-primary/20'
                            : 'text-text-muted dark:text-text-muted-dark hover:text-text dark:hover:text-text-dark',
                    )}
                >
                    <Terminal className="h-3 w-3" />
                    {showLogs ? tProgress('hideLogs') : tProgress('showLogs')}
                </button>
                {showLogs && (
                    <TerminalLogViewer
                        logs={recentLogs}
                        title={tProgress('showLogs')}
                        maxHeight="max-h-48"
                        showCursor={isGenerating}
                    />
                )}
            </>
        ) : null;

        const configs = {
            [GenerateStatusType.GENERATING]: {
                title: t('generating.title'),
                description: itemsText || stepText || t('generating.description'),
                action: (
                    <div className="w-full space-y-3">
                        <div>
                            <div className="flex items-center justify-between text-xs text-text-muted dark:text-text-muted-dark mb-1">
                                <span>{t('generating.processing')}</span>
                                <span className="font-medium">{progressPercentage}%</span>
                            </div>
                            <div className="w-full h-1.5 bg-surface-tertiary dark:bg-surface-tertiary-dark rounded-full overflow-hidden">
                                <div
                                    className="h-full bg-primary rounded-full transition-all duration-700 ease-out"
                                    style={{ width: `${progressPercentage}%` }}
                                >
                                    <div className="h-full bg-linear-to-r from-primary via-primary to-primary/80 animate-gradient" />
                                </div>
                            </div>
                        </div>
                        {logsSection}
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
                                            <span className="break-words min-w-0">{warning}</span>
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
                        {logsSection && <div className="mt-3">{logsSection}</div>}
                    </div>
                ),
            },
            [GenerateStatusType.ERROR]: {
                title: t('error.title'),
                description: generateStatus.error || t('error.description'),
                action: (
                    <div>
                        {generateStatus.warnings?.length ? (
                            <div className="mb-3 rounded-md bg-rose-50/60 dark:bg-rose-950/20 border border-rose-200/70 dark:border-rose-800/40 px-3 py-2">
                                <p className="text-xs font-medium text-rose-900 dark:text-rose-300 mb-1">
                                    {t('error.withWarnings')}
                                </p>
                                <ul className="space-y-0.5">
                                    {generateStatus.warnings.map((warning, i) => (
                                        <li
                                            key={i}
                                            className="text-xs text-rose-800 dark:text-rose-300/80 flex items-start gap-1.5"
                                        >
                                            <span className="shrink-0 mt-0.5">&#x2022;</span>
                                            <span className="break-words min-w-0">{warning}</span>
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        ) : null}
                        {logsSection && <div className="mb-3">{logsSection}</div>}
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
            <div className="p-5">
                <div className="flex items-start gap-2.5">
                    <StatusIcon
                        className={cn(
                            'w-4 h-4 mt-0.5 shrink-0',
                            statusStyle.card.iconColor,
                            statusStyle.animate && 'animate-spin',
                        )}
                    />
                    <div className="flex-1 min-w-0">
                        <h3 className="text-sm font-semibold text-text dark:text-text-dark leading-snug">
                            {config.title}
                        </h3>
                        {config.description && (
                            <p className="text-sm text-text-muted dark:text-text-muted-dark mt-1">
                                {config.description}
                            </p>
                        )}
                        {config.action && <div className="mt-3">{config.action}</div>}
                    </div>
                </div>
            </div>
        </div>
    );
}
