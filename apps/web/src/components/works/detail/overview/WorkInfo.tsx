'use client';

import { WorkMemberRole } from '@/lib/api/enums';
import { Work, WorkConfig } from '@/lib/api/types-only';
import { useMounted } from '@/lib/hooks/use-mounted';
import { cn } from '@/lib/utils/cn';
import { useTranslations } from 'next-intl';
import { useWorkDetail } from '../WorkDetailContext';
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

interface WorkInfoProps {
    work: Work;
    config: WorkConfig | null;
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

export function WorkInfo({ work, config }: WorkInfoProps) {
    const t = useTranslations('dashboard.workDetail.info');
    const { repoLinks, oauthConnection } = useWorkDetail();

    const userRole = work.userRole;
    const isShared = userRole && userRole !== WorkMemberRole.OWNER;

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
                    {t(`role.${userRole || WorkMemberRole.OWNER}`)}
                </span>
            ),
            icon: <UserCircle className="w-3.5 h-3.5" />,
        },
        {
            label: t('slug'),
            value: <span className="font-mono text-xs">{work.slug}</span>,
            icon: <Hash className="w-3.5 h-3.5" />,
        },
        {
            label: t('gitProvider'),
            value: (
                <div className="flex items-center gap-2">
                    <span className="capitalize">
                        {oauthConnection?.name || work.gitProvider}
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
            value: work.deployProvider ? (
                <div className="flex items-center gap-2">
                    <span className="capitalize">{work.deployProvider}</span>
                    {work.website && (
                        <a
                            href={work.website}
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
            value: work.organization ? work.owner || t('yes') : t('no'),
            icon: <Building2 className="w-3.5 h-3.5" />,
        },
        {
            label: t('repositories'),
            active: Boolean(repoLinks),
            value: (
                <ul className="flex gap-2 flex-col list-inside">
                    <li className="flex gap-1">
                        {work.repoVisibility && (
                            <RepoVisibilityIcon
                                isPrivate={work.repoVisibility.data}
                                label={t('dataRepo')}
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
                        {work.repoVisibility && (
                            <RepoVisibilityIcon
                                isPrivate={work.repoVisibility.website}
                                label={t('websiteRepo')}
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
                        {work.repoVisibility && (
                            <RepoVisibilityIcon
                                isPrivate={work.repoVisibility.work}
                                label={t('mainRepo')}
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
            value: new Date(work.createdAt),
            icon: <Calendar className="w-3.5 h-3.5" />,
        },

        // {
        //     label: t('lastUpdated'),
        //     value: new Date(work.updatedAt),
        //     icon: <Calendar className="w-3.5 h-3.5" />,
        // },
    ];

    // Add README config if exists
    if (work.readmeConfig) {
        if (work.readmeConfig.header) {
            infoItems.push({
                label: t('readmeHeader'),
                value: work.readmeConfig.overwriteDefaultHeader
                    ? t('customOverwrite')
                    : t('custom'),
                icon: <FileText className="w-3.5 h-3.5" />,
            });
        }
        if (work.readmeConfig.footer) {
            infoItems.push({
                label: t('readmeFooter'),
                value: work.readmeConfig.overwriteDefaultFooter
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
                'bg-card dark:bg-transparent',
                'border-card-border dark:border-border-secondary-dark',
            )}
        >
            <div className="px-5 py-3.5 border-b border-card-border dark:border-border-secondary-dark">
                <h3 className="text-sm font-semibold text-text dark:text-text-dark">
                    {t('title')}
                </h3>
            </div>
            <div className="divide-y divide-card-border dark:divide-border-secondary-dark">
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
