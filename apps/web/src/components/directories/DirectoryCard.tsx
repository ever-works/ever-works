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
                'block rounded-lg p-6',
                'bg-card dark:bg-card-dark',
                'border border-card-border dark:border-card-border-dark',
                'hover:border-border-secondary dark:hover:border-border-secondary-dark',
                'transition-colors duration-200',
                'cursor-pointer',
            )}
        >
            <div className="flex items-start justify-between mb-3">
                <div className="flex-1 min-w-0">
                    <h3 className="text-lg font-semibold text-text dark:text-text-dark">
                        {directory.name}
                    </h3>
                    <p className="text-sm text-text-muted dark:text-text-muted-dark mt-1">
                        /{directory.slug}
                    </p>
                </div>

                {/* Status indicator */}
                <div
                    className={cn(
                        'px-2 py-1 rounded-full text-xs font-medium',
                        status === GenerateStatusType.ERROR && 'bg-danger/20 text-danger',
                        status === GenerateStatusType.GENERATING && 'bg-info/20 text-info',
                        status === GenerateStatusType.GENERATED && 'bg-success/20 text-success',
                        !status && 'bg-gray-200 text-gray-700',
                    )}
                >
                    {status === GenerateStatusType.ERROR && t('status.error')}
                    {status === GenerateStatusType.GENERATING && t('status.generating')}
                    {status === GenerateStatusType.GENERATED && t('status.generated')}
                    {!status && t('status.idle')}
                </div>
            </div>

            <p
                className={cn(
                    'text-sm mb-4 line-clamp-2',
                    'text-text-secondary dark:text-text-secondary-dark',
                )}
            >
                {directory.description || t('noDescription')}
            </p>

            {/* Stats */}
            <div className="items-center gap-4 mb-4 text-sm text-text-muted dark:text-text-muted-dark flex">
                <span className="flex items-center gap-1">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                        />
                    </svg>
                    {t('items', { count: directory.itemsCount || 0 })}
                </span>
            </div>

            {/* Footer */}
            <div className="flex items-center justify-between pt-4 border-t border-border dark:border-border-dark">
                {directory.updatedAt && (
                    <span className="text-xs text-text-muted dark:text-text-muted-dark">
                        {t('updated', { date: formatDate(directory.updatedAt, locale) })}
                    </span>
                )}

                <span className="text-sm font-medium text-primary">{t('viewAction')}</span>
            </div>
        </Link>
    );
}
