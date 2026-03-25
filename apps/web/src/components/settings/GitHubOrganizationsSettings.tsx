'use client';

import { useEffect, useMemo, useState, useTransition } from 'react';
import { Building2, Plus, Save, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { getGitProviderOrganizations } from '@/app/actions/dashboard/oauth';
import { updatePluginSettings } from '@/app/actions/plugins';
import type { UserPlugin } from '@/lib/api/plugins';

interface GitHubOrganizationsSettingsProps {
    plugin: UserPlugin;
    connected: boolean;
}

export function GitHubOrganizationsSettings({
    plugin,
    connected,
}: GitHubOrganizationsSettingsProps) {
    const [isPending, startTransition] = useTransition();
    const [organizations, setOrganizations] = useState<string[]>([]);
    const [additionalOrganizations, setAdditionalOrganizations] = useState<string[]>(
        Array.isArray(plugin.metadata?.additionalOrganizations)
            ? (plugin.metadata?.additionalOrganizations as string[])
            : [],
    );
    const [draftOrganization, setDraftOrganization] = useState('');
    const [status, setStatus] = useState<string | null>(null);

    useEffect(() => {
        if (!connected) {
            setOrganizations([]);
            return;
        }

        startTransition(async () => {
            const result = await getGitProviderOrganizations('github');
            if (result.success) {
                setOrganizations(result.organizations.map((org) => org.login));
            }
        });
    }, [connected]);

    const allOrganizations = useMemo(() => {
        const merged = new Set<string>([...organizations, ...additionalOrganizations]);
        return Array.from(merged).sort((a, b) => a.localeCompare(b));
    }, [additionalOrganizations, organizations]);

    const addOrganization = () => {
        const next = draftOrganization.trim().replace(/^@/, '');
        if (!next) {
            return;
        }

        setAdditionalOrganizations((prev) =>
            prev.includes(next) ? prev : [...prev, next].sort((a, b) => a.localeCompare(b)),
        );
        setDraftOrganization('');
        setStatus(null);
    };

    const removeAdditionalOrganization = (login: string) => {
        setAdditionalOrganizations((prev) => prev.filter((entry) => entry !== login));
        setStatus(null);
    };

    const saveOrganizations = () => {
        startTransition(async () => {
            const result = await updatePluginSettings(plugin.pluginId, {
                metadata: {
                    additionalOrganizations,
                },
            });

            setStatus(
                result.success ? 'Saved organization access.' : result.error || 'Save failed.',
            );
        });
    };

    return (
        <div className="rounded-xl border border-border dark:border-border-dark bg-surface dark:bg-surface-dark p-5 space-y-4">
            <div className="flex items-start gap-3">
                <div className="mt-0.5 rounded-lg bg-surface-secondary dark:bg-surface-secondary-dark p-2">
                    <Building2 className="w-4 h-4 text-text-muted dark:text-text-muted-dark" />
                </div>
                <div>
                    <h3 className="text-sm font-semibold text-text dark:text-text-dark">
                        GitHub organizations
                    </h3>
                    <p className="text-sm text-text-muted dark:text-text-muted-dark">
                        Review the organizations available from your GitHub connection and add any
                        extra organizations you want Ever Works to target.
                    </p>
                </div>
            </div>

            <div className="flex flex-wrap gap-2">
                {allOrganizations.length > 0 ? (
                    allOrganizations.map((login) => {
                        const removable = additionalOrganizations.includes(login);

                        return (
                            <span
                                key={login}
                                className="inline-flex items-center gap-1 rounded-full bg-surface-secondary dark:bg-surface-secondary-dark px-3 py-1 text-sm text-text dark:text-text-dark"
                            >
                                @{login}
                                {removable && (
                                    <button
                                        type="button"
                                        onClick={() => removeAdditionalOrganization(login)}
                                        className="text-text-muted hover:text-danger"
                                        aria-label={`Remove ${login}`}
                                    >
                                        <X className="w-3.5 h-3.5" />
                                    </button>
                                )}
                            </span>
                        );
                    })
                ) : (
                    <p className="text-sm text-text-muted dark:text-text-muted-dark">
                        {connected
                            ? 'No organizations found yet.'
                            : 'Connect GitHub to load your organizations.'}
                    </p>
                )}
            </div>

            <div className="flex flex-col gap-3">
                <Input
                    value={draftOrganization}
                    onChange={(event) => setDraftOrganization(event.target.value)}
                    placeholder="Add organization by login"
                />
                <div className="flex gap-3 items-center">
                    <Button variant="secondary" onClick={addOrganization} className="text-sm">
                        <Plus className="w-4 h-4" />
                        Add organization
                    </Button>
                    <Button
                        onClick={saveOrganizations}
                        loading={isPending}
                        size='sm'
                    >
                        <Save className="w-4 h-4" />
                        Save organizations
                    </Button>
                </div>
            </div>

            {status && (
                <p className="text-sm text-text-muted dark:text-text-muted-dark">{status}</p>
            )}
        </div>
    );
}
