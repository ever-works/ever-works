import { toolGrantsAPI } from '@/lib/api/tool-grants';
import {
    composeAgentAccessLevels,
    type AgentAccessLevelRow,
} from '@/components/agents/agent-access-levels.shared';

/**
 * Access-level rows for the Capabilities page (AW-15): every provider whose
 * plugin declares "Read only" / "Read and write", with this agent's current
 * level each.
 *
 * The provider list is one read; each provider's state is settled
 * independently so one unreadable provider shows "couldn't load" on its own
 * row instead of hiding the section. A failed provider list returns `[]` —
 * the section then simply does not render, and nothing else on the page is
 * affected.
 */
export async function loadAgentAccessLevels(agentId: string): Promise<AgentAccessLevelRow[]> {
    let providers: Awaited<ReturnType<typeof toolGrantsAPI.listPresets>>['providers'];
    try {
        providers = (await toolGrantsAPI.listPresets()).providers ?? [];
    } catch {
        return [];
    }
    if (providers.length === 0) return [];

    const states = await Promise.allSettled(
        providers.map((provider) =>
            toolGrantsAPI.getPresetState({
                providerId: provider.providerId,
                scopeType: 'agent',
                scopeId: agentId,
            }),
        ),
    );

    return composeAgentAccessLevels(
        providers.map((provider, index) => {
            const settled = states[index];
            return {
                providerId: provider.providerId,
                providerName: provider.providerName,
                presets: provider.presets.map((preset) => preset.id),
                state: settled.status === 'fulfilled' ? settled.value : null,
            };
        }),
    );
}
