'use client';

import { cn } from '@/lib/utils/cn';
import { useTranslations } from 'next-intl';
import { OrganizationSelector } from './OrganizationSelector';
import { GitBranch, ShieldCheck } from 'lucide-react';

interface RepositoryOwnerCardProps {
    gitProvider?: string;
    gitConnected?: boolean;
    /**
     * True when repositories are created in the managed Ever Works GitHub
     * org. The owner is then the platform org, not something the user picks —
     * so neither the organization selector nor the "connect a Git provider"
     * prompt applies.
     */
    managedGitStorage?: boolean;
    owner: string;
    onChange: (value: string, isOrganization: boolean) => void;
    disabled?: boolean;
}

export function RepositoryOwnerCard({
    gitProvider,
    gitConnected = false,
    managedGitStorage = false,
    owner,
    onChange,
    disabled,
}: RepositoryOwnerCardProps) {
    const t = useTranslations('dashboard.workCreation');

    return (
        <div
            className={cn(
                'p-1 rounded-lg',
                'bg-card/10 dark:bg-card-primary-dark/30',
                'border border-card-border dark:border-border-secondary-dark',
            )}
        >
            <div
                className={cn(
                    'p-6 rounded-sm',
                    'bg-card dark:bg-card-secondary-dark/50',
                    'border border-card-border dark:border-border-secondary-dark',
                )}
            >
                {managedGitStorage ? (
                    <div className="flex items-start gap-3">
                        <ShieldCheck
                            className="w-8 h-8 rounded-sm bg-emerald-500/10 p-1 text-emerald-500 dark:text-emerald-400 mt-0.5 shrink-0"
                            strokeWidth={1.4}
                        />
                        <div>
                            <p className="text-sm font-normal text-text dark:text-text-dark">
                                {t('organizationSelector.label')}
                            </p>
                            <p className="text-sm text-text-muted dark:text-text-muted-dark mt-1">
                                {t('organizationSelector.managedByEverWorks')}
                            </p>
                        </div>
                    </div>
                ) : gitProvider && gitConnected ? (
                    <OrganizationSelector
                        value={owner}
                        providerId={gitProvider}
                        onChange={onChange}
                        disabled={disabled}
                    />
                ) : (
                    <div className="flex items-start gap-3">
                        <GitBranch
                            className="w-8 h-8 rounded-sm bg-primary-500/10 p-1 text-text-muted dark:text-text-muted-dark mt-0.5 shrink-0"
                            strokeWidth={1}
                        />
                        <div>
                            <p className="text-sm font-normal text-text dark:text-text-dark">
                                {t('organizationSelector.label')}
                            </p>
                            <p className="text-sm text-text-muted dark:text-text-muted-dark mt-1">
                                {t('organizationSelector.connectRequired')}
                            </p>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
