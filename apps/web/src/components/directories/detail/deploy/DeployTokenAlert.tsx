'use client';

import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { cn } from '@/lib/utils/cn';
import { useTranslations } from 'next-intl';
import { AlertTriangle, ExternalLink, Settings } from 'lucide-react';

interface DeployTokenAlertProps {
    /** The deployment provider ID (e.g., 'vercel', 'netlify') */
    providerId?: string;
    /** Display name of the provider */
    providerName?: string;
}

const PROVIDER_CONFIGS: Record<
    string,
    { name: string; tokenUrl: string; tokenDescription: string }
> = {
    vercel: {
        name: 'Vercel',
        tokenUrl: 'https://vercel.com/account/tokens',
        tokenDescription: 'API token',
    },
    netlify: {
        name: 'Netlify',
        tokenUrl: 'https://app.netlify.com/user/applications#personal-access-tokens',
        tokenDescription: 'personal access token',
    },
};

export function DeployTokenAlert({ providerId = 'vercel', providerName }: DeployTokenAlertProps) {
    const t = useTranslations('dashboard.directoryDetail.deploy');

    const config = PROVIDER_CONFIGS[providerId] || {
        name: providerName || providerId,
        tokenUrl: '',
        tokenDescription: 'API token',
    };

    const displayName = providerName || config.name;

    return (
        <div className="max-w-full mx-auto">
            <div
                className={cn(
                    'rounded-lg p-6',
                    'bg-surface dark:bg-surface-dark',
                    'border border-warning/20 dark:border-warning-dark/20',
                )}
            >
                <div className="flex items-start gap-4">
                    <div
                        className={cn(
                            'shrink-0 w-10 h-10 rounded-full flex items-center justify-center',
                            'bg-warning/10 dark:bg-warning-dark/10',
                        )}
                    >
                        <AlertTriangle className="w-5 h-5 text-warning dark:text-warning-dark" />
                    </div>
                    <div className="flex-1">
                        <h3 className="text-lg font-semibold text-text dark:text-text-dark mb-2">
                            {t('noTokenAlert.title')}
                        </h3>
                        <p className="text-text-secondary dark:text-text-secondary-dark mb-4">
                            {t('noTokenAlert.description')}
                        </p>
                        <div className="flex flex-wrap gap-3">
                            <Link
                                href={ROUTES.DASHBOARD_PLUGIN_DETAIL(providerId)}
                                className={cn(
                                    'inline-flex items-center gap-2 px-4 py-2 rounded-lg font-medium transition-colors',
                                    'bg-primary dark:bg-primary-dark text-white',
                                    'hover:bg-primary/90 dark:hover:bg-primary-dark/90',
                                )}
                            >
                                <Settings className="w-4 h-4" />
                                {t('noTokenAlert.configureButton')}
                            </Link>
                            {config.tokenUrl && (
                                <a
                                    href={config.tokenUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className={cn(
                                        'inline-flex items-center gap-2 px-4 py-2 rounded-lg font-medium transition-colors',
                                        'bg-surface-secondary dark:bg-surface-secondary-dark',
                                        'text-text dark:text-text-dark',
                                        'hover:bg-surface-hover dark:hover:bg-surface-hover-dark',
                                    )}
                                >
                                    <ExternalLink className="w-4 h-4" />
                                    {t('noTokenAlert.getTokenButton')}
                                </a>
                            )}
                        </div>
                    </div>
                </div>
            </div>

            <div className="mt-6 p-6 rounded-lg bg-surface-secondary dark:bg-surface-secondary-dark">
                <h4 className="font-medium text-text dark:text-text-dark mb-3">
                    {t('noTokenAlert.howTo.title')}
                </h4>
                <ol className="space-y-2 text-sm text-text-secondary dark:text-text-secondary-dark">
                    <li className="flex gap-2">
                        <span className="font-medium">1.</span>
                        <span>{t('noTokenAlert.howTo.step1')}</span>
                    </li>
                    <li className="flex gap-2">
                        <span className="font-medium">2.</span>
                        <span>{t('noTokenAlert.howTo.step2')}</span>
                    </li>
                    <li className="flex gap-2">
                        <span className="font-medium">3.</span>
                        <span>
                            Configure your {displayName} {config.tokenDescription} in Plugin
                            Settings &gt; {displayName}
                        </span>
                    </li>
                    <li className="flex gap-2">
                        <span className="font-medium">4.</span>
                        <span>Return here to deploy your directory</span>
                    </li>
                </ol>
            </div>
        </div>
    );
}
