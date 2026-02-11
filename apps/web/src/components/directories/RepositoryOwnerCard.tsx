'use client';

import { cn } from '@/lib/utils/cn';
import { useTranslations } from 'next-intl';
import { OrganizationSelector } from './OrganizationSelector';
import { GitBranch } from 'lucide-react';

interface RepositoryOwnerCardProps {
    gitProvider?: string;
    gitConnected?: boolean;
    owner: string;
    onChange: (value: string, isOrganization: boolean) => void;
    disabled?: boolean;
}

export function RepositoryOwnerCard({
    gitProvider,
    gitConnected = false,
    owner,
    onChange,
    disabled,
}: RepositoryOwnerCardProps) {
    const t = useTranslations('dashboard.directoryCreation');

    return (
        <div
            className={cn(
                'p-6 rounded-lg',
                'bg-card dark:bg-card-dark',
                'border border-card-border dark:border-card-border-dark',
            )}
        >
            {gitProvider && gitConnected ? (
                <OrganizationSelector
                    value={owner}
                    providerId={gitProvider}
                    onChange={onChange}
                    disabled={disabled}
                />
            ) : (
                <div className="flex items-start gap-3">
                    <GitBranch className="w-5 h-5 text-text-muted dark:text-text-muted-dark mt-0.5 shrink-0" />
                    <div>
                        <p className="text-sm font-medium text-text dark:text-text-dark">
                            {t('organizationSelector.label')}
                        </p>
                        <p className="text-sm text-text-muted dark:text-text-muted-dark mt-1">
                            {t('organizationSelector.connectRequired')}
                        </p>
                    </div>
                </div>
            )}
        </div>
    );
}
