'use client';

import { DirectoryConfig as DirectoryConfigType } from '@/lib/api/types-only';
import { cn } from '@/lib/utils/cn';
import { useTranslations } from 'next-intl';
import { useDirectoryDetail } from '../DirectoryDetailContext';
import { Link } from '@/i18n/navigation';

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
                'rounded-lg border p-6',
                'bg-card dark:bg-card-dark',
                'border-card-border dark:border-card-border-dark',
            )}
        >
            <h3 className="text-lg font-semibold text-text dark:text-text-dark mb-4">
                {t('title')}
            </h3>

            <div className="space-y-4">
                {/* Generation Details */}
                {config.metadata?.initial_prompt && (
                    <div>
                        <h4 className="text-sm font-medium text-text-secondary dark:text-text-secondary-dark mb-1">
                            {t('initialPrompt')}
                        </h4>
                        <p className="text-sm text-text dark:text-text-dark bg-surface dark:bg-surface-dark rounded-md p-3">
                            {config.metadata.initial_prompt}
                        </p>
                    </div>
                )}

                {/* Company Information */}
                {(config.company_name || config.company_website) && (
                    <div>
                        <h4 className="text-sm font-medium text-text-secondary dark:text-text-secondary-dark mb-2">
                            {t('companyDetails')}
                        </h4>
                        <div className="grid grid-cols-2 gap-4">
                            {config.company_name && (
                                <div>
                                    <p className="text-xs text-text-muted dark:text-text-muted-dark">
                                        {t('companyName')}
                                    </p>
                                    <p className="text-sm text-text dark:text-text-dark">
                                        {config.company_name}
                                    </p>
                                </div>
                            )}
                            {config.company_website && (
                                <div>
                                    <p className="text-xs text-text-muted dark:text-text-muted-dark">
                                        {t('companyWebsite')}
                                    </p>
                                    <a
                                        href={config.company_website}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="text-sm text-primary hover:underline"
                                    >
                                        {config.company_website}
                                    </a>
                                </div>
                            )}
                        </div>
                    </div>
                )}

                {/* Generation Settings */}
                <div className="hidden">
                    <h4 className="text-sm font-medium text-text-secondary dark:text-text-secondary-dark mb-2">
                        {t('generationSettings')}
                    </h4>
                    <div className="grid grid-cols-2 gap-4">
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

                {/* PR Update Information */}
                {(mainPR || dataPR) && (
                    <div>
                        <h4 className="text-sm font-medium text-text-secondary dark:text-text-secondary-dark mb-2">
                            {t('pullRequestUpdate')}
                        </h4>
                        <div className="bg-surface dark:bg-surface-dark rounded-md p-3 space-y-2">
                            <div>
                                <p className="text-xs text-text-muted dark:text-text-muted-dark">
                                    {t('mainRepository')}
                                </p>
                                <Link
                                    href={mainPR?.url || '#'}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-sm text-primary hover:underline font-mono"
                                >
                                    {mainPR?.branch.substring(0, 10)} -{' '}
                                    {mainPR?.number ? `#${mainPR.number}` : '-'}
                                </Link>
                            </div>

                            <div>
                                <p className="text-xs text-text-muted dark:text-text-muted-dark">
                                    {t('dataRepository')}
                                </p>
                                <Link
                                    href={dataPR?.url || '#'}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-sm text-primary hover:underline font-mono"
                                >
                                    {mainPR?.branch.substring(0, 10)} -{' '}
                                    {dataPR?.number ? `#${dataPR.number}` : '-'}
                                </Link>
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
