'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { GitOrganization } from '@/lib/api';
import { getGitProviderOrganizations } from '@/app/actions/dashboard/organizations';
import { cn } from '@/lib/utils/cn';
import { useTranslations } from 'next-intl';
import { Loader2, Building2, User } from 'lucide-react';

interface OrganizationSelectorProps {
    value: string;
    onChange: (value: string, isOrganization: boolean) => void;
    disabled?: boolean;
    providerId: string;
    suggestedOwner?: string;
}

const LOADED_ORGS = new Map<string, GitOrganization[]>();

export function OrganizationSelector({
    value,
    onChange,
    disabled,
    providerId,
    suggestedOwner,
}: OrganizationSelectorProps) {
    const t = useTranslations('dashboard.directoryCreation');
    const cacheKey = providerId;
    const [organizations, setOrganizations] = useState<GitOrganization[]>(
        LOADED_ORGS.get(cacheKey) || [],
    );
    const [isPending, startTransition] = useTransition();
    const onChangeRef = useRef(onChange);
    onChangeRef.current = onChange;
    const reconciledRef = useRef<string | undefined>(undefined);

    useEffect(() => {
        startTransition(async () => {
            const result = await getGitProviderOrganizations(providerId);
            setOrganizations(result.organizations || []);

            if (result.success) {
                LOADED_ORGS.set(cacheKey, result.organizations || []);
            }

            if (!result.success) {
                console.error('Failed to fetch organizations:', result.error);
            }
        });
    }, [providerId]);

    // Reconcile suggestedOwner against the loaded organizations list
    useEffect(() => {
        if (!suggestedOwner || organizations.length === 0) return;
        if (reconciledRef.current === suggestedOwner) return;

        reconciledRef.current = suggestedOwner;

        const match = organizations.find(
            (org) => org.login.toLowerCase() === suggestedOwner.toLowerCase(),
        );

        if (match) {
            onChangeRef.current(match.login, true);
        } else if (value === suggestedOwner) {
            // User doesn't belong to this org — reset to personal
            onChangeRef.current('', false);
        }
    }, [suggestedOwner, organizations, value]);

    const handleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
        const selectedValue = e.target.value;
        onChange(selectedValue, selectedValue !== '');
    };

    if (isPending && organizations.length === 0) {
        return (
            <div className="space-y-2">
                <label className="block text-sm font-medium text-text dark:text-text-dark">
                    {t('organizationSelector.label')}
                </label>
                <div
                    className={cn(
                        'flex items-center justify-center py-8',
                        'bg-surface dark:bg-surface-dark',
                        'border border-border dark:border-border-dark',
                        'rounded-lg',
                    )}
                >
                    <Loader2 className="animate-spin h-5 w-5 text-text-muted dark:text-text-muted-dark" />
                    <span className="ml-2 text-sm text-text-muted dark:text-text-muted-dark">
                        {t('organizationSelector.loading')}
                    </span>
                </div>
            </div>
        );
    }

    return (
        <div className="space-y-2">
            <label
                htmlFor="organization"
                className="block text-sm font-medium text-text dark:text-text-dark"
            >
                {t('organizationSelector.label')}
            </label>
            <select
                id="organization"
                value={value}
                onChange={handleChange}
                disabled={disabled}
                className={cn(
                    'w-full px-4 py-2 rounded-lg',
                    'bg-surface dark:bg-surface-dark',
                    'border border-border dark:border-border-dark',
                    'text-text dark:text-text-dark',
                    'focus:outline-none focus:ring-2 focus:ring-primary dark:focus:ring-primary-dark',
                    'disabled:opacity-50 disabled:cursor-not-allowed',
                    'transition-colors',
                )}
            >
                <option value="">{t('organizationSelector.personal')}</option>
                {organizations.length > 0 && (
                    <optgroup label={t('organizationSelector.organizations')}>
                        {organizations.map((org) => (
                            <option key={org.login} value={org.login}>
                                {org.login}
                                {org.name && ` - ${org.name.substring(0, 50)}`}
                            </option>
                        ))}
                    </optgroup>
                )}
            </select>
            <p className="text-xs text-text-muted dark:text-text-muted-dark">
                {value === ''
                    ? t('organizationSelector.personalHelp')
                    : t('organizationSelector.organizationHelp', { org: value })}
            </p>

            {/* Visual indicator of current selection */}
            <div
                className={cn(
                    'flex items-center gap-2 px-3 py-2 rounded-lg',
                    'bg-surface-secondary dark:bg-surface-secondary-dark',
                    'border border-border dark:border-border-dark',
                )}
            >
                {value === '' ? (
                    <>
                        <User className="w-4 h-4 text-text-muted dark:text-text-muted-dark" />
                        <span className="text-sm text-text-secondary dark:text-text-secondary-dark">
                            {t('organizationSelector.personalAccount')}
                        </span>
                    </>
                ) : (
                    <>
                        <Building2 className="w-4 h-4 text-primary dark:text-primary-dark" />
                        <span className="text-sm text-text dark:text-text-dark font-medium">
                            {value}
                        </span>
                    </>
                )}
            </div>
        </div>
    );
}
