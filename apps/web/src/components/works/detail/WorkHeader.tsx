'use client';

import { Work } from '@/lib/api/types-only';
import { cn } from '@/lib/utils/cn';
import { getGenerationStatusConfig } from '@/lib/utils/generation-status';
import { useTranslations } from 'next-intl';
import { WorkMemberRole, WorkScheduleStatus } from '@/lib/api/enums';
import { Link as IconLink, Users, Cog, Github, Clock, AlertTriangle, Bot } from 'lucide-react';
import { useWorkDetail, useWorkPermissions } from './WorkDetailContext';
import { buildPublicComparisonUrl } from '@/lib/utils/comparison';
import { Link, usePathname } from '@/i18n/navigation';
import { ShinyText } from '@/components/ui/ShinyText';
import { AnimatedClock } from '@/components/ui/AnimatedClock';

interface WorkHeaderProps {
    work: Work;
}

export function WorkHeader({ work }: WorkHeaderProps) {
    const t = useTranslations('dashboard.workDetail');
    const { repoLinks } = useWorkDetail();
    const { role } = useWorkPermissions();
    const pathname = usePathname();

    const isShared = role && role !== WorkMemberRole.OWNER;

    const hasWarnings = !!work.generateStatus?.warnings?.length;
    const statusStyle = getGenerationStatusConfig(work.generateStatus?.status, {
        hasWarnings,
    });
    const isScheduled = work.scheduledStatus === WorkScheduleStatus.ACTIVE;
    const isGenerating = statusStyle.labelKey === 'generating';
    const showStatusBadge = !isScheduled || isGenerating;
    const showScheduledBadge = isScheduled && !isGenerating;
    const statusLabel =
        statusStyle.labelKey === 'generatedWithWarnings'
            ? t('status.generated')
            : t(`status.${statusStyle.labelKey}`);
    const pathSegments = pathname.split('/').filter(Boolean);
    const comparisonsIndex = pathSegments.indexOf('comparisons');
    const comparisonSlug =
        comparisonsIndex >= 0 && comparisonsIndex < pathSegments.length - 1
            ? pathSegments[comparisonsIndex + 1]
            : null;
    const externalWebsiteUrl =
        work.website && comparisonSlug
            ? buildPublicComparisonUrl(work.website, comparisonSlug)
            : work.website;

    return (
        <div className="relative mb-6">
            <div className="relative">
                <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0 flex-1">
                        {/* Title + inline status badges */}
                        <div className="mb-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
                            <h1 className="text-xl font-bold leading-tight text-text dark:text-text-dark sm:text-2xl">
                                {work.name}
                            </h1>

                            {showStatusBadge && (
                                <span
                                    className={cn(
                                        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-normal whitespace-nowrap shrink-0',
                                        statusStyle.badge,
                                        isGenerating && 'animate-pulse',
                                    )}
                                >
                                    {isGenerating ? <ShinyText text={statusLabel} /> : statusLabel}
                                    {statusStyle.labelKey === 'generatedWithWarnings' && (
                                        <AlertTriangle className="w-3 h-3" />
                                    )}
                                </span>
                            )}

                            {showScheduledBadge && (
                                <span className="inline-flex items-center gap-1 rounded-full bg-blue-100 px-2 py-0.5 text-[11px] font-normal shrink-0 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300">
                                    {hasWarnings && <AlertTriangle className="w-3 h-3" />}
                                    {statusLabel}
                                    <AnimatedClock className="w-3 h-3" />
                                </span>
                            )}

                            {isShared && (
                                <span
                                    className="inline-flex items-center gap-1 rounded-full bg-purple-100 px-2 py-0.5 text-[11px] font-normal shrink-0 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300"
                                    title={t('shared.tooltip', { role: t(`role.${role}`) })}
                                >
                                    <Users className="w-3 h-3" />
                                    {t(`role.${role}`)}
                                </span>
                            )}
                        </div>

                        {/* Description */}
                        {work.description && (
                            <p className="mt-1.5 text-sm leading-relaxed text-text-secondary dark:text-text-secondary-dark">
                                {work.description}
                            </p>
                        )}

                        {/* Meta row */}
                        <div className="mt-4 flex flex-wrap items-center gap-3">
                            {/* Slug */}
                            <div className="flex items-center gap-1 text-[11px] text-text-secondary dark:text-text-secondary-dark">
                                <Cog className="w-3.5 h-3.5 opacity-60" />
                                <code className="rounded bg-black/5 px-1.5 py-0.5 font-mono dark:bg-white/8">
                                    {work.slug}
                                </code>
                            </div>

                            {work.organization && work.owner && (
                                <div className="flex items-center gap-1 text-[11px] text-text-secondary dark:text-text-secondary-dark">
                                    <Users className="w-3.5 h-3.5 opacity-60" />
                                    <span>{work.owner}</span>
                                </div>
                            )}

                            {(() => {
                                const inner = (
                                    <>
                                        <Github className="w-3.5 h-3.5 opacity-60" />
                                        <span className="capitalize">{work.gitProvider}</span>
                                    </>
                                );
                                if (repoLinks?.main) {
                                    return (
                                        <a
                                            href={repoLinks.main}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="flex items-center gap-1 text-[11px] text-text-secondary dark:text-text-secondary-dark hover:text-text dark:hover:text-text-dark transition-colors"
                                        >
                                            {inner}
                                        </a>
                                    );
                                }
                                return (
                                    <div className="flex items-center gap-1 text-[11px] text-text-secondary dark:text-text-secondary-dark">
                                        {inner}
                                    </div>
                                );
                            })()}

                            <div className="flex items-center gap-1 text-[11px] text-text-secondary dark:text-text-secondary-dark">
                                <Clock className="w-3.5 h-3.5 opacity-60" />
                                <span>{new Date(work.createdAt).toLocaleDateString()}</span>
                            </div>
                        </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                        {/* FU-3 — direct on-ramp to a Work-scoped Agent. */}
                        <Link
                            href={`/works/${work.id}/agents/new`}
                            className="inline-flex items-center gap-1.5 rounded-lg border border-border dark:border-border-dark px-3 h-8 text-[12px] font-medium text-text-secondary dark:text-text-secondary-dark hover:border-primary/40 hover:text-primary dark:hover:text-primary transition-colors"
                            title="Create a new Work-scoped Agent"
                        >
                            <Bot className="w-3.5 h-3.5" />
                            New Agent
                        </Link>

                        {/* External link */}
                        {externalWebsiteUrl && (
                            <Link
                                href={externalWebsiteUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="rounded-lg border border-border dark:border-border-dark p-2 text-text-secondary dark:text-text-secondary-dark hover:border-primary/40 hover:text-primary dark:hover:text-primary transition-colors"
                            >
                                <IconLink className="w-4 h-4" />
                            </Link>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}
