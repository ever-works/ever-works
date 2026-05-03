'use client';

import { cn } from '@/lib/utils/cn';
import { useTranslations } from 'next-intl';
import { AlertTriangle, Users } from 'lucide-react';

export function SharedWorkNoTokenAlert() {
    const t = useTranslations('dashboard.workDetail.deploy');

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
                            {t('sharedNoTokenAlert.title')}
                        </h3>
                        <p className="text-text-secondary dark:text-text-secondary-dark mb-4">
                            {t('sharedNoTokenAlert.description')}
                        </p>
                        <div
                            className={cn(
                                'flex items-center gap-2 px-4 py-3 rounded-lg',
                                'bg-surface-secondary dark:bg-surface-secondary-dark',
                            )}
                        >
                            <Users className="w-5 h-5 text-text-secondary dark:text-text-secondary-dark" />
                            <span className="text-sm text-text-secondary dark:text-text-secondary-dark">
                                {t('sharedNoTokenAlert.hint')}
                            </span>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
