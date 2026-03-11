'use client';

import { DirectoryConfig as DirectoryConfigType } from '@/lib/api/types-only';
import { cn } from '@/lib/utils/cn';
import { useTranslations } from 'next-intl';
import { useDirectoryDetail } from '../DirectoryDetailContext';
import { PrUpdateInfo } from '../PrUpdateInfo';
import { MessageSquare, Building2, Globe, Settings } from 'lucide-react';

interface DirectoryConfigProps {
    config: DirectoryConfigType;
}

export function DirectoryConfig({ config }: DirectoryConfigProps) {
    const { directory } = useDirectoryDetail();
    const t = useTranslations('dashboard.directoryDetail.config');

    const mainPR = directory.lastPullRequest?.main;
    const dataPR = directory.lastPullRequest?.data;

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
                {/* Generation Details */}
                {config.metadata?.initial_prompt && (
                    <div className="flex items-start gap-3 px-5 py-3">
                        <div className="flex items-center gap-1.5 w-32 shrink-0 pt-0.5 text-text-muted dark:text-text-muted-dark">
                            <MessageSquare className="w-3.5 h-3.5" />
                            <span className="text-xs">{t('initialPrompt')}</span>
                        </div>
                        <p className="flex-1 text-sm text-text dark:text-text-dark bg-surface dark:bg-surface-dark rounded-md p-2">
                            {config.metadata.initial_prompt}
                        </p>
                    </div>
                )}

                {/* Company Information */}
                {config.company_name && (
                    <div className="flex items-start gap-3 px-5 py-3">
                        <div className="flex items-center gap-1.5 w-32 shrink-0 pt-0.5 text-text-muted dark:text-text-muted-dark">
                            <Building2 className="w-3.5 h-3.5" />
                            <span className="text-xs">{t('companyName')}</span>
                        </div>
                        <span className="flex-1 text-sm text-text dark:text-text-dark">
                            {config.company_name}
                        </span>
                    </div>
                )}

                {config.company_website && (
                    <div className="flex items-start gap-3 px-5 py-3">
                        <div className="flex items-center gap-1.5 w-32 shrink-0 pt-0.5 text-text-muted dark:text-text-muted-dark">
                            <Globe className="w-3.5 h-3.5" />
                            <span className="text-xs">{t('companyWebsite')}</span>
                        </div>
                        <a
                            href={config.company_website}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex-1 text-sm text-primary hover:underline"
                        >
                            {config.company_website}
                        </a>
                    </div>
                )}

                {/* Generation Settings (hidden) */}
                <div className="hidden">
                    <div className="flex items-start gap-3 px-5 py-3">
                        <div className="flex items-center gap-1.5 w-32 shrink-0 pt-0.5 text-text-muted dark:text-text-muted-dark">
                            <Settings className="w-3.5 h-3.5" />
                            <span className="text-xs">{t('generationSettings')}</span>
                        </div>
                        <div className="flex-1 grid grid-cols-2 gap-4">
                            {config.metadata?.generation_method && (
                                <div>
                                    <p className="text-xs text-text-muted dark:text-text-muted-dark">
                                        {t('generationMethod')}
                                    </p>
                                    <p className="text-sm text-text dark:text-text-dark capitalize">
                                        {config.metadata.generation_method.replace('-', ' ')}
                                    </p>
                                </div>
                            )}
                            {config.autoapproval !== undefined && (
                                <div>
                                    <p className="text-xs text-text-muted dark:text-text-muted-dark">
                                        {t('autoApproval')}
                                    </p>
                                    <p className="text-sm text-text dark:text-text-dark">
                                        {config.autoapproval ? t('enabled') : t('disabled')}
                                    </p>
                                </div>
                            )}
                            {config.paging_mode && (
                                <div>
                                    <p className="text-xs text-text-muted dark:text-text-muted-dark">
                                        {t('pagingMode')}
                                    </p>
                                    <p className="text-sm text-text dark:text-text-dark capitalize">
                                        {config.paging_mode}
                                    </p>
                                </div>
                            )}
                            {config.content_table !== undefined && (
                                <div>
                                    <p className="text-xs text-text-muted dark:text-text-muted-dark">
                                        {t('contentTable')}
                                    </p>
                                    <p className="text-sm text-text dark:text-text-dark">
                                        {config.content_table ? t('enabled') : t('disabled')}
                                    </p>
                                </div>
                            )}
                        </div>
                    </div>
                </div>

                {(mainPR || dataPR) && (
                    <div className="px-5 py-3">
                        <PrUpdateInfo mainPR={mainPR} dataPR={dataPR} />
                    </div>
                )}
            </div>
        </div>
    );
}
