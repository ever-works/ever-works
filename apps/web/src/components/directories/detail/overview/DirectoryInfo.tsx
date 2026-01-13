'use client';

import { DirectoryMemberRole } from '@/lib/api/enums';
import { Directory, DirectoryConfig } from '@/lib/api/types-only';
import { useMounted } from '@/lib/hooks/use-mounted';
import { cn } from '@/lib/utils/cn';
import { useTranslations } from 'next-intl';
import { useDirectoryDetail } from '../DirectoryDetailContext';
import { Link } from '@/i18n/navigation';
import { Users, UserCircle, Lock, Unlock, Database, Layout, FolderGit2 } from 'lucide-react';

interface DirectoryInfoProps {
    directory: Directory;
    config: DirectoryConfig | null;
}

// Helper to render visibility icon
const renderRepoIcon = (isPrivate: boolean | undefined, label: string) => {
    if (isPrivate === undefined) return null;

    return (
        <div
            className="flex items-center gap-1 text-xs text-muted-foreground"
            title={`${label}: ${isPrivate ? 'Private' : 'Public'}`}
        >
            {isPrivate ? <Lock className="w-3 h-3" /> : <Unlock className="w-3 h-3" />}
        </div>
    );
};

// {
//     directory.repoVisibility && (
//         <div className="flex gap-3 mb-2">

//             {renderRepoIcon('data', directory.repoVisibility.data, Database, 'Data Repo')}
//             {renderRepoIcon('website', directory.repoVisibility.website, Layout, 'Website Repo')}
//         </div>
//     );
// }

export function DirectoryInfo({ directory, config }: DirectoryInfoProps) {
    const t = useTranslations('dashboard.directoryDetail.info');
    const { repoLinks } = useDirectoryDetail();

    const userRole = directory.userRole;
    const isShared = userRole && userRole !== DirectoryMemberRole.OWNER;

    const infoItems = [
        {
            label: t('yourRole'),
            value: (
                <span
                    className={cn(
                        'inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-medium',
                        isShared
                            ? 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300'
                            : 'bg-primary/10 text-primary dark:bg-primary/20',
                    )}
                >
                    {isShared ? <Users className="w-3 h-3" /> : <UserCircle className="w-3 h-3" />}
                    {t(`role.${userRole || DirectoryMemberRole.OWNER}`)}
                </span>
            ),
            icon: (
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"
                    />
                </svg>
            ),
        },
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
            label: t('repositories'),
            active: Boolean(repoLinks && config),
            value: (
                <ul className="flex gap-2 flex-col list-inside">
                    <li className="flex gap-1">
                        {directory.repoVisibility &&
                            renderRepoIcon(directory.repoVisibility.data, 'Data Repo')}
                        <Link
                            href={repoLinks?.dataRepo || '#'}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-primary hover:text-primary-hover"
                        >
                            {t('dataRepo')}
                        </Link>
                    </li>

                    <li className="flex gap-1">
                        {directory.repoVisibility &&
                            renderRepoIcon(directory.repoVisibility.website, 'Website Repo')}
                        <Link
                            href={repoLinks?.websiteRepo || '#'}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-primary hover:text-primary-hover"
                        >
                            {t('websiteRepo')}
                        </Link>
                    </li>

                    <li className="flex gap-1">
                        {directory.repoVisibility &&
                            renderRepoIcon(directory.repoVisibility.directory, 'Main Repo')}
                        <Link
                            href={repoLinks?.main || '#'}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-primary hover:text-primary-hover"
                        >
                            {t('mainRepo')}
                        </Link>
                    </li>
                </ul>
            ),
            icon: (
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h3m-3-8h7m-7 3h7m-7 3h7m2-10v16m-2-5h.01M7 20h5a2 2 0 002-2v-6a2 2 0 00-2-2H7a2 2 0 00-2 2v6a2 2 0 002 2h5m-2 4h.01"
                    />
                </svg>
            ),
        },
        {
            label: t('created'),
            value: new Date(directory.createdAt),
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

        // {
        //     label: t('lastUpdated'),
        //     value: new Date(directory.updatedAt),
        //     icon: (
        //         <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        //             <path
        //                 strokeLinecap="round"
        //                 strokeLinejoin="round"
        //                 strokeWidth={2}
        //                 d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
        //             />
        //         </svg>
        //     ),
        // },
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
                {infoItems
                    .filter((item) => item.active !== false)
                    .map((item) => (
                        <div key={item.label} className="flex items-start gap-3">
                            <div className="mt-0.5 text-text-muted dark:text-text-muted-dark">
                                {item.icon}
                            </div>
                            <div className="flex-1">
                                <p className="text-xs text-text-muted dark:text-text-muted-dark mb-1">
                                    {item.label}
                                </p>
                                <div className="text-sm font-medium text-text dark:text-text-dark">
                                    {item.value instanceof Date ? (
                                        <DisplayDate date={item.value.toISOString()} />
                                    ) : (
                                        item.value
                                    )}
                                </div>
                            </div>
                        </div>
                    ))}
            </div>
        </div>
    );
}

function DisplayDate({ date }: { date: string }) {
    const isMounted = useMounted();

    if (!isMounted) return null;

    return <time dateTime={date}>{new Date(date).toLocaleString()}</time>;
}
