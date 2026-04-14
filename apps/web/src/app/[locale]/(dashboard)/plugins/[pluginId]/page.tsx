import type { Metadata } from 'next';
import { pluginsAPI } from '@/lib/api/plugins';
import { oauthAPI, OAuthConnectionInfo } from '@/lib/api/plugins-capabilities/oauth';
import { PluginSettings } from '@/components/plugins/PluginSettings';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('metadata.pages');
    return { title: t('pluginSettings') };
}

interface PluginDetailPageProps {
    params: Promise<{ pluginId: string }>;
}

export default async function PluginDetailPage({ params }: PluginDetailPageProps) {
    const { pluginId } = await params;
    let plugin;

    try {
        plugin = await pluginsAPI.get(pluginId);
    } catch {
        notFound();
    }

    let oauthConnection: OAuthConnectionInfo | null | undefined;
    if (plugin.capabilities.includes('oauth')) {
        try {
            oauthConnection = await oauthAPI.checkConnection(plugin.pluginId);
        } catch {
            oauthConnection = null;
        }
    }

    let localAuthStatus = null;
    if (plugin.pluginId === 'codex') {
        try {
            localAuthStatus = await pluginsAPI.getLocalAuthStatus(plugin.pluginId);
        } catch {
            localAuthStatus = null;
        }

        const configuredAuthMode =
            typeof plugin.settings?.authMode === 'string' ? plugin.settings.authMode : undefined;
        const hasSavedApiKey =
            typeof plugin.settings?.apiKey === 'string' && plugin.settings.apiKey.length > 0;

        if (!configuredAuthMode) {
            plugin = {
                ...plugin,
                settings: {
                    ...(plugin.settings || {}),
                    authMode:
                        !hasSavedApiKey && localAuthStatus?.connected ? 'local' : 'api-key',
                },
            };
        }
    }

    return (
        <div className="w-full">
            <PluginSettings
                plugin={plugin}
                oauthConnection={oauthConnection}
                localAuthStatus={localAuthStatus}
            />
        </div>
    );
}
