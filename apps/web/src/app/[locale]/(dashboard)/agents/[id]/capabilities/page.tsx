import { notFound } from 'next/navigation';
import { agentsAPI } from '@/lib/api/agents';
import { skillsAPI } from '@/lib/api/skills';
import { AgentCapabilitiesClient } from '@/components/agents/AgentCapabilitiesClient';

type Params = Promise<{ id: string; locale: string }>;

/**
 * Capabilities tab — the per-Agent "what can it do" surface:
 *
 *  - Agent tools (the tool-grant matrix's first web UI) — per-tool
 *    toggles writing the AGENT-scope grant row; parent-scope denials
 *    shown read-only (narrowing-only semantics);
 *  - Skills — agent-scope bindings (attach / detach) + inherited
 *    bindings read-only;
 *  - Init Script — advisory v1 bootstrap script;
 *  - Permissions summary — read-only, editable in Settings.
 *
 * One composed API read (`GET /api/agents/:id/capabilities`) answers the
 * tools/permissions/init-script sections; skills ride the existing
 * bindings endpoints. The skill pickers are defensive — a flaky skills
 * API degrades to an empty picker, never a 500 page.
 *
 * The client is SECTIONED on purpose: sibling features (MCP servers,
 * repositories, environments — built on parallel branches) add their own
 * sections/cards here in follow-ups.
 */
export default async function AgentCapabilitiesPage({ params }: { params: Params }) {
    const { id } = await params;
    const agent = await agentsAPI.get(id);
    if (!agent) notFound();

    const [capabilities, boundSkills, installedSkills, catalogSkills] = await Promise.all([
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
        />
    );
}
