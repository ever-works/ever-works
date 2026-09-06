import { notFound } from 'next/navigation';
import { agentsAPI } from '@/lib/api/agents';
import { skillsAPI } from '@/lib/api/skills';
import { mcpConnectionsAPI } from '@/lib/api/mcp-connections';
import { repoConnectionsAPI } from '@/lib/api/repo-connections';
import { environmentsAPI } from '@/lib/api/environments';
import { AgentCapabilitiesClient } from '@/components/agents/AgentCapabilitiesClient';
import { loadAgentFleet } from './agent-fleet-data';

type Params = Promise<{ id: string; locale: string }>;

/**
 * Capabilities tab — the per-Agent "what can it do" surface:
 *
 *  - Agent tools (the tool-grant matrix's first web UI) — per-tool
 *    toggles writing the AGENT-scope grant row; parent-scope denials
 *    shown read-only (narrowing-only semantics);
 *  - Skills — agent-scope bindings (attach / detach) + inherited
 *    bindings read-only;
 *  - MCP connections — effective per-agent state over the user's MCP
 *    connections, with the tenant-inherited rows badged;
 *  - Repositories — registry attachments; Work-derived rows read-only;
 *  - Environment — the published Environment this agent runs in;
 *  - Execution — the preferred Fleet node (agent-to-node affinity) and
 *    the account's execution routing, read-only with a link to change it;
 *  - Init Script — advisory v1 bootstrap script;
 *  - Permissions summary — read-only, editable in Settings.
 *
 * One composed API read (`GET /api/agents/:id/capabilities`) answers the
 * tools/permissions/init-script sections; skills, MCP servers, repos,
 * environments and the Fleet facts ride their own EXISTING endpoints —
 * this page composes them server-side and hands the client plain data.
 *
 * Every secondary read is defensive: a flaky skills / MCP / registry /
 * environments / fleet API degrades the section it feeds (empty picker,
 * empty list, hidden section) and never turns the page into a 500.
 *
 * ADDITIVE: the standalone MCP Servers tab, the Repositories card on the
 * Settings page and the Settings Environment picker all keep working —
 * this is one consolidated view over the same endpoints, not a move.
 */
export default async function AgentCapabilitiesPage({ params }: { params: Params }) {
    const { id } = await params;
    const agent = await agentsAPI.get(id);
    if (!agent) notFound();

    const [
        capabilities,
        boundSkills,
        installedSkills,
        catalogSkills,
        mcpServers,
        repos,
        environments,
        fleet,
    ] = await Promise.all([
        agentsAPI.getCapabilities(id),
        agentsAPI.listSkills(id).catch(() => ({ data: [] })),
        skillsAPI
            .listInstalled({ limit: 100 })
            .then((res) => res.data ?? [])
            .catch(() => []),
        skillsAPI
            .listCatalog({ limit: 100 })
            .then((res) => res.entries ?? [])
            .catch(() => []),
        mcpConnectionsAPI.listForAgent(id).catch(() => ({ data: [] })),
        repoConnectionsAPI.listForAgent(id).catch(() => []),
        // PUBLISHED only — the API refuses assigning a draft Environment
        // with a 422, so the picker offers exactly what it will accept.
        environmentsAPI.list('published').catch(() => []),
        loadAgentFleet(id).catch(() => null),
    ]);

    return (
        <AgentCapabilitiesClient
            agent={agent}
            initialCapabilities={capabilities}
            initialBoundSkills={boundSkills.data}
            installedSkills={installedSkills.map((skill) => ({
                id: skill.id,
                slug: skill.slug,
                title: skill.title,
                description: skill.description,
            }))}
            catalogSkills={catalogSkills.map((entry) => ({
                slug: entry.slug,
                title: entry.title,
                description: entry.description,
            }))}
            initialMcpServers={mcpServers.data}
            initialRepos={repos}
            environments={environments.map((environment) => ({
                id: environment.id,
                name: environment.name,
            }))}
            fleet={fleet}
        />
    );
}
