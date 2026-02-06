import { pluginsAPI } from '@/lib/api/plugins';
import { notFound } from 'next/navigation';
import { PluginSettingsInline } from '@/components/settings/PluginSettingsInline';

interface PageProps {
    params: Promise<{
        category: string;
        pluginId: string;
    }>;
}

export default async function PluginSettingsPage({ params }: PageProps) {
    const { category, pluginId } = await params;

    let plugin;
    try {
        plugin = await pluginsAPI.get(pluginId);
    } catch (error) {
        console.error('Failed to fetch plugin:', error);
        notFound();
    }

    // Verify the plugin belongs to this category
    if (plugin.category !== category) {
        notFound();
    }

    return <PluginSettingsInline plugin={plugin} />;
}
