import { notFound } from 'next/navigation';
import { agentsAPI, type AgentFileBody, type AgentFileName } from '@/lib/api/agents';
import { AgentInstructionsEditor } from '@/components/agents/AgentInstructionsEditor';
import { readFleetFeatureFlags } from '@/lib/fleet-flags';

const FILES: AgentFileName[] = ['SOUL.md', 'AGENTS.md', 'HEARTBEAT.md', 'TOOLS.md', 'agent.yml'];

/**
 * Agents/Skills/Tasks PR #1017 — Phase 5.6. Instructions tab —
 * 5-pill editor for the canonical Agent definition files. v1
 * uses a plain textarea per pill; the Tiptap upgrade reusing
 * `KbEditor.tsx` lands in a later sub-tick once the shared
 * editor toolbar is extracted from the KB surface. 800ms
 * autosave debounce is enforced client-side by
 * `AgentInstructionsEditor`.
 */
export default async function AgentInstructionsPage({
    params,
}: {
    params: Promise<{ id: string }>;
}) {
    const { id } = await params;
    const agent = await agentsAPI.get(id);
    if (!agent) notFound();

    const files: AgentFileBody[] = await Promise.all(
        FILES.map((name) =>
            agentsAPI.readFile(id, name).catch(
                () =>
                    ({
                        name,
                        body: '',
                        hash: '',
                        storage: 'db' as const,
                    }) satisfies AgentFileBody,
            ),
        ),
    );

    // FL-06 P3 (spec FR-27): the Fleet actions section, while sessions on computers are on.
    const fleetActions = readFleetFeatureFlags(['FLEET_SESSIONS_ENABLED'] as const).FLEET_SESSIONS_ENABLED === true;

    return <AgentInstructionsEditor agentId={id} files={files} fleetActions={fleetActions} />;
}
