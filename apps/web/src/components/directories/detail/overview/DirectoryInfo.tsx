'use client';

import { DirectoryMemberRole } from '@/lib/api/enums';
import { Directory, DirectoryConfig } from '@/lib/api/types-only';
import { useMounted } from '@/lib/hooks/use-mounted';
import { cn } from '@/lib/utils/cn';
import { useTranslations } from 'next-intl';
import { useDirectoryDetail } from '../DirectoryDetailContext';
import { Link } from '@/i18n/navigation';
import {
    Users,
    UserCircle,
    Lock,
    Unlock,
    ExternalLink,
    Cloud,
    Hash,
    GitBranch,
    Building2,
    FolderGit2,
    Calendar,
    FileText,
} from 'lucide-react';

interface DirectoryInfoProps {
    directory: Directory;
    config: DirectoryConfig | null;
}

// Helper to render visibility icon
function RepoVisibilityIcon({
    isPrivate,
    label,
}: {
    isPrivate: boolean | undefined;
    label: string;
}) {
    const t = useTranslations('common.visibility');
    if (isPrivate === undefined) return null;

    const visibilityLabel = isPrivate ? t('private') : t('public');
    return (
        <div
            className="flex items-center gap-1 text-xs text-text-muted dark:text-text-muted-dark"
            title={`${label}: ${visibilityLabel}`}
        >
            {isPrivate ? <Lock className="w-3 h-3" /> : <Unlock className="w-3 h-3" />}
        </div>
    );
}

export function DirectoryInfo({ directory, config }: DirectoryInfoProps) {
    const t = useTranslations('dashboard.directoryDetail.info');
    const { repoLinks, oauthConnection } = useDirectoryDetail();

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
            icon: <UserCircle className="w-3.5 h-3.5" />,
        },
        {
            label: t('slug'),
            value: <span className="font-mono text-xs">{directory.slug}</span>,
            icon: <Hash className="w-3.5 h-3.5" />,
        },
        {
            label: t('gitProvider'),
            value: (
                <div className="flex items-center gap-2">
                    <span className="capitalize">
                        {oauthConnection?.name || directory.gitProvider}
                    </span>
                    {oauthConnection?.connected ? (
                        <span className="text-xs text-success">@{oauthConnection.username}</span>
                    ) : (
                        <span className="text-xs text-text-muted dark:text-text-muted-dark">
                            {t('notConnected')}
                        </span>
                    )}
                </div>
            ),
            icon: <GitBranch className="w-3.5 h-3.5" />,
        },
        {
            label: t('deployProvider'),
            value: directory.deployProvider ? (
                <div className="flex items-center gap-2">
                    <span className="capitalize">{directory.deployProvider}</span>
                    {directory.website && (
                        <a
                            href={directory.website}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs text-primary hover:text-primary-hover flex items-center gap-1"
                        >
                            {t('viewSite')}
                            <ExternalLink className="w-3 h-3" />
                        </a>
                    )}
                </div>
            ) : (
                <span className="text-text-muted dark:text-text-muted-dark">
                    {t('notConfigured')}
                </span>
            ),
            icon: <Cloud className="w-3.5 h-3.5" />,
        },
        {
            label: t('organization'),
            value: directory.organization ? directory.owner || t('yes') : t('no'),
            icon: <Building2 className="w-3.5 h-3.5" />,
        },
        {
            label: t('repositories'),
            active: Boolean(repoLinks),
            value: (
                <ul className="flex gap-2 flex-col list-inside">
                    <li className="flex gap-1">
                        {directory.repoVisibility && (
                            <RepoVisibilityIcon
                                isPrivate={directory.repoVisibility.data}
                                label="Data Repo"
                            />
                        )}
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
                        {directory.repoVisibility && (
                            <RepoVisibilityIcon
                                isPrivate={directory.repoVisibility.website}
                                label="Website Repo"
                            />
                        )}
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
                        {directory.repoVisibility && (
                            <RepoVisibilityIcon
                                isPrivate={directory.repoVisibility.directory}
                                label="Main Repo"
                            />
                        )}
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
            icon: <FolderGit2 className="w-3.5 h-3.5" />,
        },
        {
            label: t('created'),
            value: new Date(directory.createdAt),
            icon: <Calendar className="w-3.5 h-3.5" />,
        },

        // {
        //     label: t('lastUpdated'),
        //     value: new Date(directory.updatedAt),
        //     icon: <Calendar className="w-3.5 h-3.5" />,
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
                icon: <FileText className="w-3.5 h-3.5" />,
            });
        }
        if (directory.readmeConfig.footer) {
            infoItems.push({
                label: t('readmeFooter'),
                value: directory.readmeConfig.overwriteDefaultFooter
                    ? t('customOverwrite')
                    : t('custom'),
                icon: <FileText className="w-3.5 h-3.5" />,
            });
        }
    }

    return (
        <div
            className={cn(
                'rounded-lg border overflow-hidden',
                'bg-card dark:bg-card-primary-dark/30',
                'border-card-border dark:border-card-border-dark',
            )}
        >
            <div className="px-5 py-3.5 border-b border-card-border dark:border-card-border-dark">
                <h3 className="text-sm font-semibold text-text dark:text-text-dark">
                    {t('title')}
                </h3>
            </div>
            <div className="divide-y divide-card-border dark:divide-card-border-dark">
                {infoItems
                    .filter((item) => item.active !== false)
                    .map((item) => (
                        <div key={item.label} className="flex items-start gap-3 px-5 py-3">
                            <div className="flex items-center gap-1.5 w-32 shrink-0 pt-0.5 text-text-muted dark:text-text-muted-dark">
                                {item.icon}
                                <span className="text-xs">{item.label}</span>
                            </div>
                            <div className="flex-1 text-xs text-text dark:text-text-dark">
                                {item.value instanceof Date ? (
                                    <DisplayDate date={item.value.toISOString()} />
                                ) : (
                                    item.value
                                )}
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
