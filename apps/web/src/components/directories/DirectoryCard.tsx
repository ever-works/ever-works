'use client';

import { cn } from '@/lib/utils/cn';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import type { Directory } from '@/lib/api/directory';

interface DirectoryCardProps {
    directory: Directory;
}

const formatDate = (date: string) => {
    return new Date(date).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
    });
};

export function DirectoryCard({ directory }: DirectoryCardProps) {
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
                        'bg-success/10 text-success',
                    )}
                >
                    Active
                </div>
            </div>

            <p
                className={cn(
                    'text-sm mb-4 line-clamp-2',
                    'text-text-secondary dark:text-text-secondary-dark',
                )}
            >
                {directory.description || 'No description provided'}
            </p>

            {/* Stats */}
            <div className="flex items-center gap-4 mb-4 text-sm text-text-muted dark:text-text-muted-dark">
                <span className="flex items-center gap-1">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                        />
                    </svg>
                    0 items
                </span>
                <span className="flex items-center gap-1">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                        />
                        <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"
                        />
                    </svg>
                    0 views
                </span>
            </div>

            {/* Footer */}
            <div className="flex items-center justify-between pt-4 border-t border-border dark:border-border-dark">
                {directory.updated_at && (
                    <span className="text-xs text-text-muted dark:text-text-muted-dark">
                        Updated {formatDate(directory.updated_at)}
                    </span>
                )}

                <span className="text-sm font-medium text-primary">View →</span>
            </div>
        </Link>
    );
}
