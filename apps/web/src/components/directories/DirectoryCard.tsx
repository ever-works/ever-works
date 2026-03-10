'use client';

import { cn } from '@/lib/utils/cn';
import { getGenerationStatusConfig } from '@/lib/utils/generation-status';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { useTranslations } from 'next-intl';
import type { Directory } from '@/lib/api/directory';
import { DirectoryMemberRole } from '@/lib/api/enums';
import { Github, Users } from 'lucide-react';
import { ShowDateTime } from '../ui/show-datetime';
import { Tooltip } from '../ui/tooltip';

interface DirectoryCardProps {
    directory: Directory;
}

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

    const status = directory.generateStatus?.status;
    const hasWarnings = !!directory.generateStatus?.warnings?.length;
    const statusConfig = getGenerationStatusConfig(status, { hasWarnings });
    const userRole = directory.userRole;
    const isShared = userRole && userRole !== DirectoryMemberRole.OWNER;

    return (
        <Link
            href={ROUTES.DASHBOARD_DIRECTORY(directory.id)}
            className={cn(
                'flex flex-col rounded-lg p-6 shadow-xs',
                'bg-card dark:bg-card-primary-dark/70',
                'border border-card-border dark:border-border-secondary-dark',
                'hover:border-primary-500/50 dark:hover:border-primary-500/50',
                'transition-colors',
            )}
        >
            <div className="flex items-start justify-between gap-4 mb-3">
                <div className="flex items-center gap-2 min-w-0">
                    <h3 className="text-lg font-semibold text-text dark:text-text-dark truncate">
                        {directory.name}
                    </h3>
                    {isShared && (
                        <Tooltip content={t('shared.tooltip', { role: t(`role.${userRole}`) })}>
                            <span
                                className={cn(
                                    'inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium shrink-0',
                                    'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300',
                                )}
                            >
                                <Users className="w-3 h-3" />
                                {t(`role.${userRole}`)}
                            </span>
                        </Tooltip>
                    )}
                </div>
                <span
                    className={cn(
                        'px-2 py-0.5 rounded-full text-xs font-medium whitespace-nowrap shrink-0',
                        statusConfig.badge,
                    )}
                >
                    {tStatus(statusConfig.labelKey)}
                </span>
            </div>

            <div className="inline-flex items-center gap-1 mt-0.5 mb-2 bg-primary-400/10 dark:bg-white/10 self-start max-w-full px-1.5 rounded-full">
                <Github className="w-3 h-3 shrink-0 text-gray-600 dark:text-gray-200" />
                <span className="text-sm font-mono text-gray-600 dark:text-gray-200 truncate">
                    {directory.slug}
                    {directory.owner && (
                        <span className="text-gray-400 dark:text-gray-400">/{directory.owner}</span>
                    )}
                </span>
            </div>

            <div className="flex-1 mb-4">
                {directory.description && (
                    <p className="text-sm text-text-secondary dark:text-text-secondary-dark line-clamp-2">
                        {directory.description}
                    </p>
                )}
            </div>

            <div className="flex items-center justify-between pt-4 border-t border-border dark:border-border-dark mt-auto">
                <span className="text-xs text-text-muted dark:text-text-muted-dark">
                    {t('items', { count: directory.itemsCount || 0 })}
                </span>
                {directory.updatedAt && (
                    <span className="text-xs text-text-muted dark:text-text-muted-dark">
                        <ShowDateTime value={directory.updatedAt} customFormatter={formatDate} />
                    </span>
                )}
            </div>
        </Link>
    );
}
