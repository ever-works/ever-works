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

    try {
        const plugin = await pluginsAPI.get(pluginId);

        let oauthConnection: OAuthConnectionInfo | null | undefined;
        if (plugin.capabilities.includes('oauth')) {
            try {
                oauthConnection = await oauthAPI.checkConnection(plugin.pluginId);
            } catch {
                oauthConnection = null;
            }
        }

        return (
            <div className="w-full">
                <PluginSettings plugin={plugin} oauthConnection={oauthConnection} />
            </div>
        );
    } catch (error) {
        notFound();
    }
}
