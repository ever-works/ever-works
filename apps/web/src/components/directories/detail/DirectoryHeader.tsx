'use client';

import { Directory } from '@/lib/api/types-only';
import { cn } from '@/lib/utils/cn';
import { getGenerationStatusConfig } from '@/lib/utils/generation-status';
import { useTranslations } from 'next-intl';
import { DirectoryMemberRole, DirectoryScheduleStatus } from '@/lib/api/enums';
import { Link as IconLink, Users, Cog, Github, Clock } from 'lucide-react';
import { useDirectoryDetail, useDirectoryPermissions } from './DirectoryDetailContext';
import { getStepText, getItemsProcessedText } from '@/lib/utils/generator-steps';
import { buildPublicComparisonUrl } from '@/lib/utils/comparison';
import { Link, usePathname } from '@/i18n/navigation';
import { ShinyText } from '@/components/ui/ShinyText';

interface DirectoryHeaderProps {
    directory: Directory;
}

export function DirectoryHeader({ directory }: DirectoryHeaderProps) {
    const t = useTranslations('dashboard.directoryDetail');
    const tProgress = useTranslations('dashboard.directoryDetail.progress');
    const { repoLinks } = useDirectoryDetail();
    const { role } = useDirectoryPermissions();
    const pathname = usePathname();

    const isShared = role && role !== DirectoryMemberRole.OWNER;

    const hasWarnings = !!directory.generateStatus?.warnings?.length;
    const statusStyle = getGenerationStatusConfig(directory.generateStatus?.status, {
        hasWarnings,
    });
    const isScheduled = directory.scheduledStatus === DirectoryScheduleStatus.ACTIVE;
    const StatusIcon = statusStyle.icon;
    const statusLabel = isScheduled
        ? `${t(`status.${statusStyle.labelKey}`)} - Scheduled`
        : t(`status.${statusStyle.labelKey}`);
    const pathSegments = pathname.split('/').filter(Boolean);
    const comparisonsIndex = pathSegments.indexOf('comparisons');
    const comparisonSlug =
        comparisonsIndex >= 0 && comparisonsIndex < pathSegments.length - 1
            ? pathSegments[comparisonsIndex + 1]
            : null;
    const externalWebsiteUrl =
        directory.website && comparisonSlug
            ? buildPublicComparisonUrl(directory.website, comparisonSlug)
            : directory.website;

    return (
        <div className="mb-8 pb-6 border-b border-border dark:border-border-dark">
            <div className="flex items-start justify-between">
                <div className="flex-1">
                    <div className="flex items-center gap-3 mb-3">
                        <h1 className="text-3xl font-bold text-text dark:text-text-dark">
                            {directory.name}
                        </h1>
                        {isShared && (
                            <span
                                className={cn(
                                    'inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium',
                                    'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300',
                                )}
                                title={t('shared.tooltip', { role: t(`role.${role}`) })}
                            >
                                <Users className="w-4 h-4" />
                                {t(`role.${role}`)}
                            </span>
                        )}
                        <span
                            className={cn(
                                'inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium',
                                statusStyle.badge,
                            )}
                        >
                            <StatusIcon
                                className={cn('w-3 h-3', statusStyle.animate && 'animate-spin')}
                            />
                            {statusStyle.animate ? <ShinyText text={statusLabel} /> : statusLabel}
                            {directory.generateStatus?.step && statusStyle.animate && (
                                <span className="text-xs opacity-75">
                                    •{' '}
                                    <span className="ml-1">
                                        {getItemsProcessedText(directory.generateStatus) ||
                                            getStepText(
                                                directory.generateStatus,
                                                tProgress('steps.processing'),
                                            )}
                                    </span>
                                </span>
                            )}
                        </span>
                    </div>

                    <p className="text-sm text-text-secondary dark:text-text-secondary-dark mb-4">
                        {directory.description}
                    </p>

                    <div className="flex flex-wrap items-center gap-4 text-sm text-text-muted dark:text-text-muted-dark">
                        <div className="flex items-center gap-0.5">
                            <Cog className="w-4 h-4" />
                            <code className="px-1.5 py-0.5 bg-surface dark:bg-surface-dark rounded">
                                {directory.slug}
                            </code>
                        </div>

                        {directory.organization && directory.owner && (
                            <div className="flex items-center gap-1.5">
                                <Users className="w-4 h-4" />
                                <span>{directory.owner}</span>
                            </div>
                        )}

                        {(() => {
                            const innerJSX = (
                                <>
                                    <Github className="w-4 h-4" />
                                    <span className="capitalize">{directory.gitProvider}</span>
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
                            <Clock className="w-4 h-4" />
                            <span>{new Date(directory.createdAt).toLocaleDateString()}</span>
                        </div>
                    </div>
                </div>

                {externalWebsiteUrl && (
                    <div className="ml-6">
                        <Link href={externalWebsiteUrl} target="_blank" rel="noopener noreferrer">
                            <IconLink className="w-4 h-4" />
                        </Link>
                    </div>
                )}
            </div>
        </div>
    );
}
