import { HttpException } from '@nestjs/common';
import { FLEET_DESKTOP_DISPLAYS_TOOL_NAME, FLEET_DESKTOP_TOOL_ANNOTATIONS, buildFleetDesktopTools } from '../agent-fleet-desktop-tools';

/** Desktop view & control (FL-07, T-28, FR-31) — the read-only display list, as the Agent's owner. */

const NODE = '11111111-1111-4111-8111-111111111111';

describe('fleet_desktop_displays', () => {
    it('is read-only and reads as the Agent’s owner', async () => {
        const readDisplays = jest.fn(async () => [
            { id: 'DP-1', name: 'Display 1', width: 1920, height: 1080, scale: 1, primary: true, virtual: false },
        ]);
        const [tool] = buildFleetDesktopTools({ agentId: 'agent-1', userId: 'owner-1', reader: { readDisplays } });
        expect(tool.name).toBe(FLEET_DESKTOP_DISPLAYS_TOOL_NAME);
        expect(FLEET_DESKTOP_TOOL_ANNOTATIONS[FLEET_DESKTOP_DISPLAYS_TOOL_NAME]).toMatchObject({ readOnly: true, destructive: false });
        const result = (await tool.invoke({ nodeId: NODE })) as { displays: unknown[] };
        expect(result.displays).toHaveLength(1);
        expect(readDisplays).toHaveBeenCalledWith({ agentId: 'agent-1', ownerUserId: 'owner-1' }, NODE);
    });

    it('answers the CONTRACTS envelope the port refused with, the same hint a person reads', async () => {
        const reader = {
            readDisplays: jest.fn(async () => {
                throw new HttpException(
                    { error: { code: 'consent_missing', hint: 'start the node with --attend on build-01' } },
                    409,
                );
            }),
        };
        const [tool] = buildFleetDesktopTools({ agentId: 'a', userId: 'u', reader });
        expect(await tool.invoke({ nodeId: NODE })).toEqual({
            error: { code: 'consent_missing', hint: 'start the node with --attend on build-01' },
        });
        expect(await tool.invoke({ nodeId: 'not-a-uuid' })).toEqual({ error: { code: 'invalid', hint: 'nodeId' } });
    });
});
