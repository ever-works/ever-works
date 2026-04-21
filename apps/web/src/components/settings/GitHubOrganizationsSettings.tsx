'use client';

import { useEffect, useMemo, useState, useTransition } from 'react';
import { Building2, Plus } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { connectOAuthProvider, getGitProviderOrganizations } from '@/app/actions/dashboard/oauth';
import type { UserPlugin } from '@/lib/api/plugins';
import { ROUTES } from '@/lib/constants';
import { usePathname } from '@/i18n/navigation';
import { Button } from '@/components/ui/button';

interface GitHubOrganizationsSettingsProps {
    plugin: UserPlugin;
    connected: boolean;
}

export function GitHubOrganizationsSettings(props: GitHubOrganizationsSettingsProps) {
    const t = useTranslations('dashboard.plugins.githubOrganizations');
    const tOAuth = useTranslations('dashboard.plugins.oauth');
    const [isPending, startTransition] = useTransition();
    const [organizations, setOrganizations] = useState<string[]>([]);
    const pathname = usePathname();

    useEffect(() => {
        if (!props.connected) {
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
        if (!props.connected) {
            return [];
        }

        return Array.from(new Set(organizations)).sort((a, b) => a.localeCompare(b));
    }, [organizations, props.connected]);

    const handleAddOrganization = () => {
        startTransition(() => {
            void (async () => {
                const result = await connectOAuthProvider(
                    props.plugin.pluginId,
                    pathname || ROUTES.DASHBOARD_SETTINGS,
                    true,
                );

                if (result.success && result.url) {
                    window.location.href = result.url;
                    return;
                }

                toast.error(result.error || tOAuth('reconnectError'));
            })();
        });
    };

    return (
        <div className="rounded-xl border border-border dark:border-border-dark bg-surface dark:bg-surface-dark p-5 space-y-4">
            <div className="flex items-start justify-between gap-4">
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

                <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={handleAddOrganization}
                    disabled={isPending}
                    className="gap-1.5 text-sm"
                >
                    <Plus className="w-4 h-4" />
                    {isPending ? tOAuth('reconnecting') : t('addButton')}
                </Button>
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
