'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { GitOrganization } from '@/lib/api';
import { getGitProviderOrganizations } from '@/app/actions/dashboard/organizations';
import {
    Select,
    SelectContent,
    SelectGroup,
    SelectItem,
    SelectLabel,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
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

    const handleChange = (selected: string) => {
        const selectedValue = selected === '__personal__' ? '' : selected;
        onChange(selectedValue, selectedValue !== '');
    };

    if (isPending && organizations.length === 0) {
        return (
            <div className="space-y-1.5">
                <label className="block text-xs font-medium text-text-muted dark:text-text-muted-dark">
                    {t('organizationSelector.label')}
                </label>
                <div
                    className={cn(
                        'flex items-center justify-center py-8',
                        'bg-surface dark:bg-surface-dark',
                        'border border-card-border dark:border-card-border-dark',
                        'rounded-lg',
                    )}
                >
                    <Loader2 className="animate-spin h-4 w-4 text-text-muted dark:text-text-muted-dark" />
                    <span className="ml-2 text-xs text-text-muted dark:text-text-muted-dark">
                        {t('organizationSelector.loading')}
                    </span>
                </div>
            </div>
        );
    }

    const selectValue = value === '' ? '__personal__' : value;

    return (
        <div className="space-y-1.5">
            <label className="block text-xs font-medium text-text-muted dark:text-text-muted-dark">
                {t('organizationSelector.label')}
            </label>
            <Select value={selectValue} onValueChange={handleChange} disabled={disabled}>
                <SelectTrigger>
                    <SelectValue />
                </SelectTrigger>
                <SelectContent>
                    <SelectItem value="__personal__">
                        <span className="flex items-center gap-2">
                            <User className="w-3.5 h-3.5 text-text-muted dark:text-text-muted-dark" />
                            {t('organizationSelector.personal')}
                        </span>
                    </SelectItem>
                    {organizations.length > 0 && (
                        <SelectGroup>
                            <SelectLabel>{t('organizationSelector.organizations')}</SelectLabel>
                            {organizations.map((org) => (
                                <SelectItem key={org.login} value={org.login}>
                                    <span className="flex items-center gap-2">
                                        <Building2 className="w-3.5 h-3.5 text-primary dark:text-primary-dark" />
                                        {org.login}
                                        {org.name && ` - ${org.name.substring(0, 50)}`}
                                    </span>
                                </SelectItem>
                            ))}
                        </SelectGroup>
                    )}
                </SelectContent>
            </Select>
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
                    'border border-card-border dark:border-card-border-dark',
                )}
            >
                {value === '' ? (
                    <>
                        <User className="w-4 h-4 text-text-muted dark:text-text-muted-dark" />
                        <span className="text-xs text-text-secondary dark:text-text-secondary-dark">
                            {t('organizationSelector.personalAccount')}
                        </span>
                    </>
                ) : (
                    <>
                        <Building2 className="w-4 h-4 text-primary dark:text-primary-dark" />
                        <span className="text-xs text-text dark:text-text-dark font-medium">
                            {value}
                        </span>
                    </>
                )}
            </div>
        </div>
    );
}
