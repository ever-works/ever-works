'use client';

import { Directory } from '@/lib/api/types-only';
import { cn } from '@/lib/utils/cn';
import { useTranslations } from 'next-intl';

interface DirectoryInfoProps {
    directory: Directory;
}

export function DirectoryInfo({ directory }: DirectoryInfoProps) {
    const t = useTranslations('dashboard.directoryDetail.info');

    const infoItems = [
        {
            label: t('slug'),
            value: directory.slug,
            icon: (
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M7 20l4-16m2 16l4-16M6 9h14M4 15h14"
                    />
                </svg>
            ),
        },
        {
            label: t('repoProvider'),
            value: directory.repoProvider,
            icon: (
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4"
                    />
                </svg>
            ),
        },
        {
            label: t('organization'),
            value: directory.organization ? directory.owner || t('yes') : t('no'),
            icon: (
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"
                    />
                </svg>
            ),
        },
        {
            label: t('created'),
            value: new Date(directory.createdAt).toLocaleString(),
            icon: (
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
                    />
                </svg>
            ),
        },
        {
            label: t('lastUpdated'),
            value: new Date(directory.updatedAt).toLocaleString(),
            icon: (
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                    />
                </svg>
            ),
        },
    ];

    // Add README config if exists
    if (directory.readmeConfig) {
        if (directory.readmeConfig.header) {
            infoItems.push({
                label: t('readmeHeader'),
                value: directory.readmeConfig.overwriteDefaultHeader
                    ? t('customOverwrite')
                    : t('custom'),
                icon: (
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                        />
                    </svg>
                ),
            });
        }
        if (directory.readmeConfig.footer) {
            infoItems.push({
                label: t('readmeFooter'),
                value: directory.readmeConfig.overwriteDefaultFooter
                    ? t('customOverwrite')
                    : t('custom'),
                icon: (
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                        />
                    </svg>
                ),
            });
        }
    }

    return (
        <div
            className={cn(
                'rounded-lg border p-6',
                'bg-card dark:bg-card-dark',
                'border-card-border dark:border-card-border-dark',
            )}
        >
            <h3 className="text-lg font-semibold text-text dark:text-text-dark mb-4">
                {t('title')}
            </h3>
            <div className="space-y-4">
                {infoItems.map((item) => (
                    <div key={item.label} className="flex items-start gap-3">
                        <div className="mt-0.5 text-text-muted dark:text-text-muted-dark">
                            {item.icon}
                        </div>
                        <div className="flex-1">
                            <p className="text-xs text-text-muted dark:text-text-muted-dark mb-1">
                                {item.label}
                            </p>
                            <p className="text-sm font-medium text-text dark:text-text-dark">
                                {item.value}
                            </p>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}
