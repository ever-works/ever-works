'use client';

import { OnboardingPluginStep } from '../OnboardingPluginStep';
import type { UserPlugin } from '@/lib/api/plugins';
import type { OAuthConnectionInfo } from '@/lib/api/plugins-capabilities/oauth';
import type { GitProviderConnectionInfo } from '@/lib/api/plugins-capabilities/git-providers';
import type { PluginDeviceAuthStatus } from '@/lib/api/plugins-capabilities/device-auth';

export interface ConfigStepProps {
    readonly title: string;
    readonly description: string;
    readonly plugin: UserPlugin | null;
    readonly connection?: OAuthConnectionInfo | GitProviderConnectionInfo | null;
    readonly deviceAuthStatus?: PluginDeviceAuthStatus | null;
    readonly isStatusLoading?: boolean;
    readonly returnPath?: string;
}

/**
 * Renders the chosen vendor's existing plugin onboarding panel.
 * Falls back to a "plugin not available" hint when the choice points at a
 * plugin id that isn't installed in this environment (rare; defensive).
 */
export function ConfigStep({
    title,
    description,
    plugin,
    connection,
    deviceAuthStatus,
    isStatusLoading,
    returnPath,
}: ConfigStepProps) {
    return (
        <div className="space-y-5 max-w-2xl">
            <header>
                <h3 className="text-lg font-semibold text-text dark:text-text-dark">{title}</h3>
                <p className="mt-1 text-sm text-text-muted dark:text-text-muted-dark">
                    {description}
                </p>
            </header>
            {plugin ? (
                <OnboardingPluginStep
                    plugin={plugin}
                    connection={connection}
                    deviceAuthStatus={deviceAuthStatus}
                    isStatusLoading={isStatusLoading}
                    returnPath={returnPath}
                />
            ) : (
                <div className="rounded-xl border border-dashed border-border dark:border-border-dark p-4 text-sm text-text-muted dark:text-text-muted-dark">
                    This integration isn&apos;t installed on this environment. You can pick a
                    different option or skip and configure it later from Settings → Plugins.
                </div>
            )}
        </div>
    );
}
