'use client';

import { Button } from '@/components/ui/button';
import { useRouter } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { useTranslations } from 'next-intl';

interface ItemsEmptyStateProps {
    directoryId: string;
}

export function ItemsEmptyState({ directoryId }: ItemsEmptyStateProps) {
    const router = useRouter();
    const t = useTranslations('dashboard.directoryDetail.items');

    return (
        <div className="flex flex-col items-center justify-center py-16">
            <div className="w-16 h-16 rounded-full bg-gray-100 dark:bg-gray-800 flex items-center justify-center mb-4">
                <svg
                    className="w-8 h-8 text-gray-400 dark:text-gray-600"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                >
                    <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"
                    />
                </svg>
            </div>
            <h3 className="text-xl font-semibold text-text dark:text-text-dark mb-2">
                {t('noItemsTitle')}
            </h3>
            <p className="text-text-secondary dark:text-text-secondary-dark text-center max-w-md mb-6">
                {t('noItemsDescription')}
            </p>
            <Button
                onClick={() => router.push(`${ROUTES.DASHBOARD_DIRECTORY(directoryId)}/generator`)}
                variant="primary"
                size="lg"
            >
                <svg className="w-5 h-5 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M13 10V3L4 14h7v7l9-11h-7z"
                    />
                </svg>
                {t('generateItems')}
            </Button>
        </div>
    );
}
