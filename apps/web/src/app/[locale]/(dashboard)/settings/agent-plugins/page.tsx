import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import {
    agentPluginsAPI,
    EMPTY_AGENT_PLUGIN_LIST,
    type AgentPluginListResponse,
} from '@/lib/api/agent-plugins';
import { AgentPluginsSettings } from '@/components/settings/AgentPluginsSettings';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('dashboard.settings.agentPlugins');
    return { title: t('title') };
}

/**
 * Settings → Agent Plugins.
 *
 * Server component: reads the package registry and hands it to the client
 * view. The endpoint is safe to call regardless of the feature flag — it
 * reports `enabled` explicitly and does not touch the filesystem when the
 * feature is off — so there is no need to gate the fetch itself.
 *
 * A failed fetch renders the page with an explanation rather than throwing.
 * The distinction the UI must preserve is three-way: the feature is off, the
 * feature is on with nothing installed, or we could not find out. Collapsing
 * the third into either of the others tells the operator something untrue.
 */
export default async function AgentPluginsSettingsPage() {
    let data: AgentPluginListResponse = EMPTY_AGENT_PLUGIN_LIST;
    let loadFailed = false;

    try {
        data = await agentPluginsAPI.list();
    } catch {
        loadFailed = true;
    }

    return <AgentPluginsSettings data={data} loadFailed={loadFailed} />;
}
