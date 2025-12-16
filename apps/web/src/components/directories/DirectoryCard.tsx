'use client';

import { cn } from '@/lib/utils/cn';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { useTranslations, useLocale } from 'next-intl';
import type { Directory } from '@/lib/api/directory';
import { GenerateStatusType } from '@/lib/api/enums';

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
    const locale = useLocale();

    const status = directory.generateStatus?.status;

    return (
        <Link
            href={ROUTES.DASHBOARD_DIRECTORY(directory.id)}
            className={cn(
                'flex flex-col rounded-lg p-6',
                'bg-card dark:bg-card-dark',
                'border border-card-border dark:border-card-border-dark',
                'hover:border-primary/50 dark:hover:border-primary/50',
                'transition-colors',
            )}
        >
            <div className="flex items-start justify-between gap-4 mb-3">
                <h3 className="text-lg font-semibold text-text dark:text-text-dark">
                    {directory.name}
                </h3>
                <span
                    className={cn(
                        'px-2 py-1 rounded text-xs font-medium whitespace-nowrap',
                        status === GenerateStatusType.ERROR && 'bg-danger/10 text-danger',
                        status === GenerateStatusType.GENERATING && 'bg-info/10 text-info',
                        status === GenerateStatusType.GENERATED && 'bg-success/10 text-success',
                        status === GenerateStatusType.CANCELLED &&
                            'bg-gray-200 text-gray-700 dark:bg-gray-700 dark:text-gray-300',
                        !status && 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
                    )}
                >
                    {status === GenerateStatusType.ERROR && t('status.error')}
                    {status === GenerateStatusType.GENERATING && t('status.generating')}
                    {status === GenerateStatusType.GENERATED && t('status.generated')}
                    {status === GenerateStatusType.CANCELLED && t('status.cancelled')}
                    {!status && t('status.idle')}
                </span>
            </div>

            <p className="text-sm text-text-muted dark:text-text-muted-dark mb-1">
                /{directory.slug}
            </p>

            <div className="flex-1 mb-4">
                {directory.description && (
                    <p className="text-sm text-text-secondary dark:text-text-secondary-dark line-clamp-2">
                        {directory.description}
                    </p>
                )}
            </div>

            <div className="flex items-center justify-between pt-4 border-t border-border dark:border-border-dark mt-auto">
                <span className="text-sm text-text-muted dark:text-text-muted-dark">
                    {t('items', { count: directory.itemsCount || 0 })}
                </span>
                {directory.updatedAt && (
                    <span className="text-xs text-text-muted dark:text-text-muted-dark">
                        {formatDate(directory.updatedAt, locale)}
                    </span>
                )}
            </div>
        </Link>
    );
}
