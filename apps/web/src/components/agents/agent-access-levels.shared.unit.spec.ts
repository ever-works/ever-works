import { describe, expect, it } from 'vitest';
import type { ConnectionScopePresetStateDto } from '@ever-works/contracts';
import {
    composeAgentAccessLevels,
    describeAccessLevel,
    selectedAccessLevel,
    type AgentAccessLevelRow,
} from './agent-access-levels.shared';

function state(over: Partial<ConnectionScopePresetStateDto> = {}): ConnectionScopePresetStateDto {
    return {
        providerId: 'github',
        scopeType: 'agent',
        scopeId: 'agent-1',
        presets: ['read', 'write'],
        requested: 'write',
        effective: 'write',
        clampedBy: null,
        ...over,
    };
}

function row(over: Partial<AgentAccessLevelRow> = {}): AgentAccessLevelRow {
    return {
        providerId: 'github',
        providerName: 'GitHub',
        presets: ['read', 'write'],
        state: state(),
        ...over,
    };
}

describe('agent access levels policy', () => {
    it('selects the stored level, never a guess', () => {
        expect(selectedAccessLevel(row())).toBe('write');
        expect(
            selectedAccessLevel(row({ state: state({ requested: 'read', effective: 'read' }) })),
        ).toBe('read');
        expect(selectedAccessLevel(row({ state: null }))).toBeNull();
    });

    it('explains the chosen level when nothing narrowed it', () => {
        expect(describeAccessLevel(row())).toEqual({ kind: 'level', level: 'write' });
        expect(
            describeAccessLevel(row({ state: state({ requested: 'read', effective: 'read' }) })),
        ).toEqual({
            kind: 'level',
            level: 'read',
        });
    });

    it('says which scope narrowed a wider choice', () => {
        expect(
            describeAccessLevel(
                row({ state: state({ requested: 'write', effective: 'read', clampedBy: 'work' }) }),
            ),
        ).toEqual({ kind: 'narrowed', effective: 'read', scope: 'work' });
    });

    it('reports no access when even the narrowest level is out of reach', () => {
        expect(
            describeAccessLevel(
                row({
                    state: state({ requested: 'read', effective: null, clampedBy: 'organization' }),
                }),
            ),
        ).toEqual({ kind: 'narrowed', effective: null, scope: 'organization' });
    });

    it('flags an unreadable level instead of implying one', () => {
        expect(describeAccessLevel(row({ state: null }))).toEqual({ kind: 'unavailable' });
        expect(describeAccessLevel(row({ state: state({ requested: null }) }))).toEqual({
            kind: 'unavailable',
        });
    });

    it('drops providers without levels and sorts by name', () => {
        const rows = composeAgentAccessLevels([
            row({ providerId: 'zeta', providerName: 'Zeta' }),
            row({ providerId: 'none', providerName: 'Aaa', presets: [] }),
            row({ providerId: 'alpha', providerName: 'Alpha' }),
        ]);
        expect(rows.map((entry) => entry.providerId)).toEqual(['alpha', 'zeta']);
    });
});
