import { getTranslations } from 'next-intl/server';
import type { Metadata } from 'next';
import { mcpConnectionsAPI, type McpConnection } from '@/lib/api/mcp-connections';
import { McpConnectionsClient } from '@/components/settings/McpConnectionsClient';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('dashboard.settings.connections');
    return { title: t('title') };
}

/**
 * Agent Plugins MCP slice — Settings → Connections. The workspace-global
 * registry of external MCP servers agents can be bound to.
 */
export default async function ConnectionsSettingsPage() {
    let initial: McpConnection[] = [];
    try {
        initial = (await mcpConnectionsAPI.list()).data;
    } catch {
        initial = [];
    }

    return <McpConnectionsClient initial={initial} />;
}
