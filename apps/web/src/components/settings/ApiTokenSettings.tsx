'use client';

import { cn } from '@/lib/utils/cn';
import { useTranslations } from 'next-intl';
import { UserProfile } from '@/lib/api';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { Settings } from 'lucide-react';

interface ApiTokenSettingsProps {
    user: UserProfile;
}

export function ApiTokenSettings({ user }: ApiTokenSettingsProps) {
    const t = useTranslations('dashboard.apiTokens');

    return (
        <div className="space-y-6">
            <div>
                <h2 className="text-xl font-semibold text-text dark:text-text-dark mb-4">
                    {t('title')}
                </h2>
                <p className="text-text-muted dark:text-text-muted-dark text-sm">{t('subtitle')}</p>
            </div>

            <div className="space-y-4">
                <div className="flex items-center justify-between">
                    <div>
                        <h3 className="text-lg font-medium text-text dark:text-text-dark">
                            {t('deployment.title')}
                        </h3>
                        <p className="text-sm text-text-muted dark:text-text-muted-dark mt-1">
                            {t('deployment.subtitle')}
                        </p>
                    </div>
                </div>

                <div className="p-4 rounded-lg bg-surface-secondary dark:bg-surface-secondary-dark border border-border dark:border-border-dark">
                    <div className="flex items-start gap-3">
                        <Settings className="w-5 h-5 text-primary dark:text-primary-dark mt-0.5 flex-shrink-0" />
                        <div className="flex-1">
                            <p className="text-sm text-text dark:text-text-dark mb-3">
                                Deployment configuration is managed in Plugin Settings for better
                                security and per-directory configuration.
                            </p>
                            <div className="flex flex-wrap gap-3">
                                <Link
                                    href={ROUTES.DASHBOARD_PLUGINS}
                                    className={cn(
                                        'inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors',
                                        'bg-primary dark:bg-primary-dark text-white',
                                        'hover:bg-primary/90 dark:hover:bg-primary-dark/90',
                                    )}
                                >
                                    <Settings className="w-4 h-4" />
                                    Configure in Plugin Settings
                                </Link>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            {/* API Keys Section */}
            <div className="pt-6 border-t border-border dark:border-border-dark">
                <h3 className="text-lg font-medium text-text dark:text-text-dark mb-2">
                    {t('apiKeys.title')}
                </h3>
                <p className="text-sm text-text-muted dark:text-text-muted-dark mb-4">
                    {t('apiKeys.subtitle')}
                </p>
                <button
                    disabled
                    className={cn(
                        'px-4 py-2 rounded-lg text-sm font-medium',
                        'bg-surface-secondary dark:bg-surface-secondary-dark',
                        'text-text-muted dark:text-text-muted-dark',
                        'cursor-not-allowed opacity-50',
                    )}
                >
                    {t('apiKeys.generate')}
                </button>
            </div>

            {/* Webhooks */}
            <div className="pt-6 border-t border-border dark:border-border-dark">
                <h3 className="text-lg font-medium text-text dark:text-text-dark mb-2">
                    {t('webhooks.title')}
                </h3>
                <p className="text-sm text-text-muted dark:text-text-muted-dark mb-4">
                    {t('webhooks.subtitle')}
                </p>
                <button
                    disabled
                    className={cn(
                        'px-4 py-2 rounded-lg text-sm font-medium',
                        'bg-surface-secondary dark:bg-surface-secondary-dark',
                        'text-text-muted dark:text-text-muted-dark',
                        'cursor-not-allowed opacity-50',
                    )}
                >
                    {t('webhooks.configure')}
                </button>
            </div>
        </div>
    );
}
