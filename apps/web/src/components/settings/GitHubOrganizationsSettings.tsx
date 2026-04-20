'use client';

import { useEffect, useMemo, useState, useTransition } from 'react';
import { Building2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { getGitProviderOrganizations } from '@/app/actions/dashboard/oauth';
import type { UserPlugin } from '@/lib/api/plugins';

interface GitHubOrganizationsSettingsProps {
    plugin: UserPlugin;
    connected: boolean;
}

export function GitHubOrganizationsSettings(props: GitHubOrganizationsSettingsProps) {
    const t = useTranslations('dashboard.plugins.githubOrganizations');
    const [, startTransition] = useTransition();
    const [organizations, setOrganizations] = useState<string[]>([]);

    useEffect(() => {
        if (!props.connected) {
            setOrganizations([]);
            return;
        }

        let cancelled = false;

        startTransition(async () => {
            const result = await getGitProviderOrganizations(props.plugin.pluginId);
            if (cancelled || !result.success) {
                return;
            }

            setOrganizations(result.organizations.map((organization) => organization.login));
        });

        return () => {
            cancelled = true;
        };
    }, [props.connected, props.plugin.pluginId]);

    const visibleOrganizations = useMemo(() => {
        return Array.from(new Set(organizations)).sort((a, b) => a.localeCompare(b));
    }, [organizations]);

    return (
        <div className="rounded-xl border border-border dark:border-border-dark bg-surface dark:bg-surface-dark p-5 space-y-4">
            <div className="flex items-start gap-3">
                <div className="mt-0.5 rounded-lg bg-surface-secondary dark:bg-surface-secondary-dark p-2">
                    <Building2 className="w-4 h-4 text-text-muted dark:text-text-muted-dark" />
                </div>
                <div>
                    <h3 className="text-sm font-semibold text-text dark:text-text-dark">
                        {t('title')}
                    </h3>
                </div>
            </div>

            <div className="flex flex-wrap gap-2">
                {visibleOrganizations.length > 0 ? (
                    visibleOrganizations.map((login) => (
                        <span
                            key={login}
                            className="inline-flex items-center rounded-full bg-surface-secondary dark:bg-surface-secondary-dark px-3 py-1 text-sm text-text dark:text-text-dark"
                        >
                            @{login}
                        </span>
                    ))
                ) : (
                    <p className="text-sm text-text-muted dark:text-text-muted-dark">
                        {props.connected ? t('noOrganizations') : t('connectToLoad')}
                    </p>
                )}
            </div>
        </div>
    );
}
