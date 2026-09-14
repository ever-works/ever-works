import {
    isNarrowerConnectionScopePreset,
    type ConnectionScopePresetId,
    type ConnectionScopePresetStateDto,
    type ToolGrantSource,
} from '@ever-works/contracts';

/**
 * Capabilities tab — Access levels section: the POLICY half (no React).
 *
 * One row per provider whose plugin declares plain-English levels. Which
 * option is selected, whether a parent scope narrowed it, and what the hint
 * under the picker says are decisions, so they live here and are tested
 * here; `AgentAccessLevelsSection.tsx` is layout.
 */

export interface AgentAccessLevelRow {
    providerId: string;
    providerName: string;
    /** Declared levels, least → most access. */
    presets: ConnectionScopePresetId[];
    /** `null` when the current level could not be read. */
    state: ConnectionScopePresetStateDto | null;
}

export type AgentAccessLevelHint =
    | { kind: 'unavailable' }
    | { kind: 'narrowed'; effective: ConnectionScopePresetId | null; scope: ToolGrantSource }
    | { kind: 'level'; level: ConnectionScopePresetId };

/** The option the picker shows as chosen. Never optimistic — always the stored level. */
export function selectedAccessLevel(row: AgentAccessLevelRow): ConnectionScopePresetId | null {
    return row.state?.requested ?? null;
}

/**
 * What the line under the picker should explain, in priority order: a level
 * that could not be read, a level a parent scope narrowed, then the plain
 * meaning of the chosen level.
 */
export function describeAccessLevel(row: AgentAccessLevelRow): AgentAccessLevelHint {
    const state = row.state;
    if (!state || state.requested === null) return { kind: 'unavailable' };
    if (
        state.clampedBy !== null &&
        (state.effective === null ||
            isNarrowerConnectionScopePreset(state.effective, state.requested))
    ) {
        return { kind: 'narrowed', effective: state.effective, scope: state.clampedBy };
    }
    return { kind: 'level', level: state.requested };
}

/** Rows sorted by provider name, dropping providers that declare nothing. */
export function composeAgentAccessLevels(rows: AgentAccessLevelRow[]): AgentAccessLevelRow[] {
    return rows
        .filter((row) => row.presets.length > 0)
        .sort((a, b) => a.providerName.localeCompare(b.providerName));
}
