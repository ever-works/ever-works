'use client';

import { Directory } from '@/lib/api/types-only';
import { cn } from '@/lib/utils/cn';
import { Button } from '@/components/ui/button';
import { useTranslations } from 'next-intl';
import { GenerateStatusType } from '@/lib/api/enums';
import { Link as IconLink } from 'lucide-react';
import { useDirectoryDetail } from './DirectoryDetailContext';
import { getStepText } from '@/lib/utils/generator-steps';
import { Link } from '@/i18n/navigation';

interface DirectoryHeaderProps {
    directory: Directory;
}

export function DirectoryHeader({ directory }: DirectoryHeaderProps) {
    const t = useTranslations('dashboard.directoryDetail');
    const tProgress = useTranslations('dashboard.directoryDetail.progress');
    const { repoLinks } = useDirectoryDetail();

    const isGenerating = directory.generateStatus?.status === GenerateStatusType.GENERATING;

    const getStatusDisplay = () => {
        if (!directory.generateStatus) {
            return {
                label: t('status.notStarted'),
                color: 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200',
                icon: (
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                        />
                    </svg>
                ),
            };
        }

        const statusConfigs = {
            [GenerateStatusType.GENERATING]: {
                label: t('status.generating'),
                color: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
                icon: (
                    <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
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
            },
            [GenerateStatusType.GENERATED]: {
                label: t('status.generated'),
                color: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
                icon: (
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
                        />
                    </svg>
                ),
            },
            [GenerateStatusType.ERROR]: {
                label: t('status.error'),
                color: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200',
                icon: (
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                        />
                    </svg>
                ),
            },
            [GenerateStatusType.CANCELLED]: {
                label: t('status.cancelled'),
                color: 'bg-gray-200 text-gray-800 dark:bg-gray-800 dark:text-gray-200',
                icon: (
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M12 9v4m0 4h.01M10.29 3.86l-7.4 12.84a1 1 0 00.86 1.5h14.8a1 1 0 00.86-1.5l-7.4-12.84a1 1 0 00-1.72 0z"
                        />
                    </svg>
                ),
            },
        };

        return statusConfigs[directory.generateStatus.status];
    };

    const status = getStatusDisplay();

    return (
        <div className="mb-8 pb-6 border-b border-border dark:border-border-dark">
            <div className="flex items-start justify-between">
                <div className="flex-1">
                    <div className="flex items-center gap-3 mb-3">
                        <h1 className="text-3xl font-bold text-text dark:text-text-dark">
                            {directory.name}
                        </h1>
                        <span
                            className={cn(
                                'inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-sm font-medium',
                                status.color,
                            )}
                        >
                            {status.icon}
                            {status.label}
                            {directory.generateStatus?.step && isGenerating && (
                                <span className="text-xs opacity-75">
                                    •{' '}
                                    <span className="ml-1">
                                        {getStepText(directory.generateStatus.step, tProgress)}
                                    </span>
                                </span>
                            )}
                        </span>
                    </div>

                    <p className="text-lg text-text-secondary dark:text-text-secondary-dark mb-4">
                        {directory.description}
                    </p>

                    <div className="flex flex-wrap items-center gap-4 text-sm text-text-muted dark:text-text-muted-dark">
                        <div className="flex items-center gap-1.5">
                            <svg
                                className="w-4 h-4"
                                fill="none"
                                stroke="currentColor"
                                viewBox="0 0 24 24"
                            >
                                <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    strokeWidth={2}
                                    d="M13 10V3L4 14h7v7l9-11h-7z"
                                />
                            </svg>
                            <code className="px-1.5 py-0.5 bg-surface dark:bg-surface-dark rounded">
                                {directory.slug}
                            </code>
                        </div>

                        {directory.organization && directory.owner && (
                            <div className="flex items-center gap-1.5">
                                <svg
                                    className="w-4 h-4"
                                    fill="none"
                                    stroke="currentColor"
                                    viewBox="0 0 24 24"
                                >
                                    <path
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        strokeWidth={2}
                                        d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"
                                    />
                                </svg>
                                <span>{directory.owner}</span>
                            </div>
                        )}

                        {(() => {
                            const innerJSX = (
                                <>
                                    <svg
                                        className="w-4 h-4"
                                        fill="none"
                                        stroke="currentColor"
                                        viewBox="0 0 24 24"
                                    >
                                        <path
                                            strokeLinecap="round"
                                            strokeLinejoin="round"
                                            strokeWidth={2}
                                            d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4"
                                        />
                                    </svg>
                                    <span className="capitalize">{directory.repoProvider}</span>
                                </>
                            );

                            if (repoLinks?.main) {
                                return (
                                    <a
                                        href={repoLinks?.main}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="flex items-center gap-1.5"
                                    >
                                        {innerJSX}
                                    </a>
                                );
                            }

                            return <div className="flex items-center gap-1.5">{innerJSX}</div>;
                        })()}

                        <div className="flex items-center gap-1.5">
                            <svg
                                className="w-4 h-4"
                                fill="none"
                                stroke="currentColor"
                                viewBox="0 0 24 24"
                            >
                                <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    strokeWidth={2}
                                    d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
                                />
                            </svg>
                            <span>{new Date(directory.createdAt).toLocaleDateString()}</span>
                        </div>
                    </div>
                </div>

                {directory.website && (
                    <div className="ml-6">
                        <Link href={directory.website} target="_blank" rel="noopener noreferrer">
                            <IconLink className="w-4 h-4" />
                        </Link>
                    </div>
                )}
            </div>
        </div>
    );
}
