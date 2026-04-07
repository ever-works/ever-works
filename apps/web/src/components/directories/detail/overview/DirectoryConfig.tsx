'use client';

import { DirectoryConfig as DirectoryConfigType } from '@/lib/api/types-only';
import { cn } from '@/lib/utils/cn';
import { useTranslations } from 'next-intl';
import { useDirectoryDetail } from '../DirectoryDetailContext';
import { PrUpdateInfo } from '../PrUpdateInfo';
import { Building2, FileText, Globe, Settings, CheckSquare, Layers, Table2 } from 'lucide-react';

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
                {/* Generation Details */}
                {config.metadata?.initial_prompt && (
                    <div className="flex items-start gap-3 px-5 py-3">
                        <div className="flex items-center gap-1.5 w-32 shrink-0 pt-0.5 text-text-muted dark:text-text-muted-dark">
                            <FileText className="w-3.5 h-3.5" />
                            <span className="text-xs">{t('initialPrompt')}</span>
                        </div>
                        <div className="flex-1 text-xs text-text dark:text-text-dark">
                            <p className="bg-surface dark:bg-surface-dark rounded-md p-3">
                                {config.metadata.initial_prompt}
                            </p>
                        </div>
                    </div>
                )}

                {/* Company Information */}
                {config.company_name && (
                    <div className="flex items-start gap-3 px-5 py-3">
                        <div className="flex items-center gap-1.5 w-32 shrink-0 pt-0.5 text-text-muted dark:text-text-muted-dark">
                            <Building2 className="w-3.5 h-3.5" />
                            <span className="text-xs">{t('companyName')}</span>
                        </div>
                        <div className="flex-1 text-xs text-text dark:text-text-dark">
                            {config.company_name}
                        </div>
                    </div>
                )}

                {config.company_website && (
                    <div className="flex items-start gap-3 px-5 py-3">
                        <div className="flex items-center gap-1.5 w-32 shrink-0 pt-0.5 text-text-muted dark:text-text-muted-dark">
                            <Globe className="w-3.5 h-3.5" />
                            <span className="text-xs">{t('companyWebsite')}</span>
                        </div>
                        <div className="flex-1 text-xs text-text dark:text-text-dark">
                            <a
                                href={config.company_website}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-primary hover:underline"
                            >
                                {config.company_website}
                            </a>
                        </div>
                    </div>
                )}

                {/* Generation Settings — hidden */}
                <div className="hidden">
                    {config.metadata?.generation_method && (
                        <div className="flex items-start gap-3 px-5 py-3">
                            <div className="flex items-center gap-1.5 w-32 shrink-0 pt-0.5 text-text-muted dark:text-text-muted-dark">
                                <Settings className="w-3.5 h-3.5" />
                                <span className="text-xs">{t('generationMethod')}</span>
                            </div>
                            <div className="flex-1 text-xs text-text dark:text-text-dark capitalize">
                                {config.metadata.generation_method.replace('-', ' ')}
                            </div>
                        </div>
                    )}
                    {config.autoapproval !== undefined && (
                        <div className="flex items-start gap-3 px-5 py-3">
                            <div className="flex items-center gap-1.5 w-32 shrink-0 pt-0.5 text-text-muted dark:text-text-muted-dark">
                                <CheckSquare className="w-3.5 h-3.5" />
                                <span className="text-xs">{t('autoApproval')}</span>
                            </div>
                            <div className="flex-1 text-xs text-text dark:text-text-dark">
                                {config.autoapproval ? t('enabled') : t('disabled')}
                            </div>
                        </div>
                    )}
                    {config.paging_mode && (
                        <div className="flex items-start gap-3 px-5 py-3">
                            <div className="flex items-center gap-1.5 w-32 shrink-0 pt-0.5 text-text-muted dark:text-text-muted-dark">
                                <Layers className="w-3.5 h-3.5" />
                                <span className="text-xs">{t('pagingMode')}</span>
                            </div>
                            <div className="flex-1 text-xs text-text dark:text-text-dark capitalize">
                                {config.paging_mode}
                            </div>
                        </div>
                    )}
                    {config.content_table !== undefined && (
                        <div className="flex items-start gap-3 px-5 py-3">
                            <div className="flex items-center gap-1.5 w-32 shrink-0 pt-0.5 text-text-muted dark:text-text-muted-dark">
                                <Table2 className="w-3.5 h-3.5" />
                                <span className="text-xs">{t('contentTable')}</span>
                            </div>
                            <div className="flex-1 text-xs text-text dark:text-text-dark">
                                {config.content_table ? t('enabled') : t('disabled')}
                            </div>
                        </div>
                    )}
                </div>

                <PrUpdateInfo mainPR={mainPR} dataPR={dataPR} className="px-5 py-3" />
            </div>
        </div>
    );
}
