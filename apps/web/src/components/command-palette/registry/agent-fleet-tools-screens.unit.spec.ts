import { describe, expect, it } from 'vitest';
import { agentFleetToolsScreens, getAgentIdFromPath, screensFor } from './screens';

/** FL-19 (spec §5.4) — "Fleet tools for this Agent" while an Agent's pages are open. */
const AGENT = '11111111-2222-4333-8444-555555555555';

describe('agent fleet tools palette entry', () => {
    it('reads the Agent id off its pages, any locale prefix', () => {
        expect(getAgentIdFromPath(`/agents/${AGENT}`)).toBe(AGENT);
        expect(getAgentIdFromPath(`/fr/agents/${AGENT}/capabilities`)).toBe(AGENT);
        expect(getAgentIdFromPath('/agents/activity')).toBeNull();
        expect(getAgentIdFromPath('/tasks')).toBeNull();
    });

    it('offers the Fleet tools block of that Agent', () => {
        const [screen] = agentFleetToolsScreens(`/agents/${AGENT}/settings`);
        expect(screen.href).toBe(`/agents/${AGENT}/capabilities#fleet-tools`);
        const t = Object.assign((key: string) => key, { has: () => true });
        expect(screen.title(t)).toBe('fleet.tools.palette.forThisAgent');
    });

    it('is absent elsewhere and with the hub off', () => {
        expect(agentFleetToolsScreens('/tasks')).toEqual([]);
        expect(agentFleetToolsScreens(`/agents/${AGENT}`, { fleetEnabled: false })).toEqual([]);
        expect(
            screensFor(`/agents/${AGENT}`).some((screen) =>
                screen.id.startsWith('agent.fleetTools.'),
            ),
        ).toBe(true);
    });
});
