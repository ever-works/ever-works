import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Capabilities page — the access-levels loader's I/O decisions: one provider
 * list, one state read per provider settled independently, and a failed list
 * hides the section rather than failing the page.
 */

const { listPresetsMock, getPresetStateMock } = vi.hoisted(() => ({
    listPresetsMock: vi.fn(),
    getPresetStateMock: vi.fn(),
}));

vi.mock('@/lib/api/tool-grants', () => ({
    toolGrantsAPI: { listPresets: listPresetsMock, getPresetState: getPresetStateMock },
}));

import { loadAgentAccessLevels } from './agent-access-levels-data';

const AGENT_ID = 'agent-1';

function provider(providerId: string, providerName: string) {
    return {
        providerId,
        providerName,
        presets: [
            { id: 'read', toolPatterns: [] },
            { id: 'write', toolPatterns: ['commitToRepo'] },
        ],
    };
}

describe('loadAgentAccessLevels', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('reads each provider’s state at THIS agent’s scope', async () => {
        listPresetsMock.mockResolvedValue({ providers: [provider('github', 'GitHub')] });
        getPresetStateMock.mockResolvedValue({ requested: 'read' });

        const rows = await loadAgentAccessLevels(AGENT_ID);

        expect(getPresetStateMock).toHaveBeenCalledWith({
            providerId: 'github',
            scopeType: 'agent',
            scopeId: AGENT_ID,
        });
        expect(rows).toEqual([
            {
                providerId: 'github',
                providerName: 'GitHub',
                presets: ['read', 'write'],
                state: { requested: 'read' },
            },
        ]);
    });

    it('one unreadable provider degrades only its own row', async () => {
        listPresetsMock.mockResolvedValue({
            providers: [provider('zeta', 'Zeta'), provider('alpha', 'Alpha')],
        });
        getPresetStateMock.mockImplementation(async ({ providerId }: { providerId: string }) => {
            if (providerId === 'zeta') throw new Error('boom');
            return { requested: 'write' };
        });

        const rows = await loadAgentAccessLevels(AGENT_ID);

        expect(rows.map((row) => [row.providerId, row.state])).toEqual([
            ['alpha', { requested: 'write' }],
            ['zeta', null],
        ]);
    });

    it('returns no rows when the provider list cannot be read, or is empty', async () => {
        listPresetsMock.mockRejectedValueOnce(new Error('down'));
        await expect(loadAgentAccessLevels(AGENT_ID)).resolves.toEqual([]);

        listPresetsMock.mockResolvedValueOnce({ providers: [] });
        await expect(loadAgentAccessLevels(AGENT_ID)).resolves.toEqual([]);
        expect(getPresetStateMock).not.toHaveBeenCalled();
    });
});
