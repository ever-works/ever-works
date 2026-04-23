'use client';

import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils/cn';
import { getGenerationStatusConfig } from '@/lib/utils/generation-status';
import { Link, usePathname } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { useTranslations } from 'next-intl';
import type { Directory } from '@/lib/api/directory';
import { DirectoryMemberRole } from '@/lib/api/enums';
import { DirectoryScheduleStatus } from '@/lib/api/enums';
import { Github, Users, FolderClosed, Clock, AlertTriangle } from 'lucide-react';
import { ShowDateTime } from '../ui/show-datetime';
import { Tooltip } from '../ui/tooltip';
import { ShinyText } from '../ui/ShinyText';

interface DirectoryCardProps {
    directory: Directory;
}

const OPENING_RESET_MS = 8000;

const formatDate = (date: string, locale: string) => {
    return new Date(date).toLocaleDateString(locale, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
    });
};

export function DirectoryCard({ directory }: DirectoryCardProps) {
    const t = useTranslations('dashboard.directoryCard');
    const tStatus = useTranslations('dashboard.directoryDetail.status');
    const pathname = usePathname();
    const [isOpening, setIsOpening] = useState(false);

    const status = directory.generateStatus?.status;
    const hasWarnings = !!directory.generateStatus?.warnings?.length;
    const statusConfig = getGenerationStatusConfig(status, { hasWarnings });
    const isScheduled = directory.scheduledStatus === DirectoryScheduleStatus.ACTIVE;
    const userRole = directory.userRole;
    const isShared = userRole && userRole !== DirectoryMemberRole.OWNER;
    const isGenerating = statusConfig.labelKey === 'generating' || isOpening;
    const showStatusBadge = !isScheduled || isGenerating || isOpening;
    const showScheduledBadge = isScheduled && !isOpening;
    const baseStatusLabel = isOpening
        ? t('status.opening')
        : statusConfig.labelKey === 'generatedWithWarnings'
          ? tStatus('generated')
          : tStatus(statusConfig.labelKey);

    useEffect(() => {
        if (!isOpening) {
            return;
        }

        const timeoutId = window.setTimeout(() => {
            setIsOpening(false);
        }, OPENING_RESET_MS);

        return () => {
            window.clearTimeout(timeoutId);
        };
    }, [isOpening]);

    useEffect(() => {
        setIsOpening(false);
    }, [pathname]);

    const handleOpen = (event: React.MouseEvent<HTMLAnchorElement>) => {
        if (isOpening) {
            event.preventDefault();
            return;
        }

        if (
            event.defaultPrevented ||
            event.metaKey ||
            event.ctrlKey ||
            event.shiftKey ||
            event.altKey
        ) {
            return;
        }

        if (typeof event.button === 'number' && event.button !== 0) {
            return;
        }

        setIsOpening(true);
    };

    return (
        <Link
            href={ROUTES.DASHBOARD_DIRECTORY(directory.id)}
            onClick={handleOpen}
            aria-busy={isOpening}
            className={cn(
                'relative flex flex-col rounded-lg p-4 shadow-xs overflow-hidden',
                'bg-card dark:bg-card-primary-dark',
                'border border-card-border dark:border-white/9',
                'hover:border-primary-500/50 dark:hover:border-white/20',
                'transition-colors',
                isGenerating &&
                    'border-primary/25 before:absolute before:inset-0 before:rounded-lg before:border before:border-primary/50 before:animate-pulse before:pointer-events-none',
                isOpening &&
                    'border-primary-500/60 dark:border-white/25 shadow-[0_0_0_1px_rgba(59,130,246,0.15)]',
            )}
        >
            {isOpening ? (
                <div className="absolute inset-0 z-10 flex items-center justify-center rounded-lg bg-card/88 dark:bg-card-primary-dark/88 backdrop-blur-[2px]">
                    <div className="flex max-w-[17rem] flex-col items-center gap-2 px-4 text-center">
                        <div className="flex items-center gap-2 rounded-full border border-primary/20 bg-primary/8 px-3 py-1.5 dark:border-white/10 dark:bg-white/8">
                            <span className="h-2 w-2 rounded-full bg-primary animate-pulse dark:bg-white" />
                            <span className="text-xs font-normal uppercase tracking-[0.18em] text-primary dark:text-white">
                                {t('status.opening')}
                            </span>
                        </div>
                        <div className="space-y-1">
                            <p className="text-xs font-normal text-text dark:text-text-dark">
                                <ShinyText text={t('openingTitle')} />
                            </p>
                            <p className="text-xs leading-5 text-text-secondary dark:text-text-secondary-dark">
                                {t('openingMessage')}
                            </p>
                        </div>
                    </div>
                </div>
            ) : null}

            <div className={cn('transition-opacity duration-200', isOpening && 'opacity-35')}>
                <div className="flex items-center justify-between gap-4 mb-3">
                    <div className="flex items-center gap-3 min-w-0">
                        <div className="shrink-0 w-8 h-8 rounded-lg flex items-center justify-center bg-gray-100 dark:bg-white/5">
                            <FolderClosed
                                strokeWidth={1}
                                className="w-4 h-4 text-gray-400 dark:text-gray-500"
                            />
                        </div>

                        <div className="min-h-[2lh] flex items-center min-w-0">
                            <h3 className="text-sm font-semibold text-text dark:text-text-dark line-clamp-2">
                                {directory.name}
                            </h3>
                        </div>
                    </div>
                    <span className="text-xs text-text-muted dark:text-text-muted-dark shrink-0">
                        {t('items', { count: directory.itemsCount || 0 })}
                    </span>
                </div>

                <div className="flex-1 mb-4">
                    <div className="inline-flex items-center gap-1 mt-0.5 mb-3 bg-primary-400/10 dark:bg-white/10 self-start max-w-full px-1.5 rounded-full">
                        <Github className="w-3 h-3 shrink-0 text-gray-600 dark:text-gray-200" />
                        <span className="text-sm font-mono text-gray-600 dark:text-gray-200 truncate">
                            {directory.owner && (
                                <span className="text-gray-400 dark:text-gray-400">
                                    {directory.owner}/
                                </span>
                            )}
                            {directory.slug}
                        </span>
                    </div>

                    <p className="text-xs leading-4.5 line-clamp-2 min-h-[2lh]">
                        {directory.description ? (
                            <span className="text-text-secondary dark:text-text-secondary-dark">
                                {directory.description}
                            </span>
                        ) : (
                            <span className="text-text-muted dark:text-text-muted-dark italic">
                                {t('noDescription')}
                            </span>
                        )}
                    </p>
                </div>

                <div className="flex items-center justify-between text-[11px] pt-4 border-t border-border dark:border-border-dark mt-auto">
                    <div className="flex items-center gap-1.5">
                        {showStatusBadge && (
                            <span
                                className={cn(
                                    'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-normal whitespace-nowrap shrink-0',
                                    isOpening
                                        ? 'bg-primary/15 text-primary dark:bg-white/12 dark:text-white'
                                        : statusConfig.badge,
                                    isGenerating && 'animate-pulse bg-gray-100',
                                )}
                            >
                                {isGenerating || isOpening ? (
                                    <ShinyText text={baseStatusLabel} />
                                ) : (
                                    baseStatusLabel
                                )}
                                {hasWarnings && !isGenerating && !isOpening && (
                                    <AlertTriangle className="w-3 h-3" />
                                )}
                            </span>
                        )}
                        {showScheduledBadge && (
                            <span
                                className={cn(
                                    'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-normal shrink-0',
                                    'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
                                )}
                            >
                                {hasWarnings && <AlertTriangle className="w-3 h-3" />}
                                {baseStatusLabel}
                                <Clock className="w-3 h-3" />
                            </span>
                        )}
                        {isShared && (
                            <Tooltip content={t('shared.tooltip', { role: t(`role.${userRole}`) })}>
                                <span
                                    className={cn(
                                        'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-normal shrink-0',
                                        'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300',
                                    )}
                                >
                                    <Users className="w-3 h-3" />
                                    {t(`role.${userRole}`)}
                                </span>
                            </Tooltip>
                        )}
                    </div>
                    {directory.updatedAt && (
                        <span className="text-[11px] text-text-muted dark:text-text-muted-dark">
                            <ShowDateTime
                                value={directory.updatedAt}
                                customFormatter={formatDate}
                            />
                        </span>
                    )}
                </div>
            </div>
        </Link>
    );
}
