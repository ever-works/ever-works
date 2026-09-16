import 'server-only';
import type {
    ConnectionScopePresetId,
    ConnectionScopePresetProviderDto,
    ConnectionScopePresetStateDto,
    ToolGrantScope,
} from '@ever-works/contracts';
import { serverFetch, serverMutation } from './server-api';

/**
 * Tool-grant matrix (audit item G4) — the web WRITE client, first used
 * by the Agent Capabilities tab (the grant system's first web UI).
 *
 * Reads deliberately do NOT live here: the Capabilities tab consumes the
 * composed `GET /api/agents/:id/capabilities` payload (agentsAPI), which
 * already carries the resolved chain + the stored agent-scope row. Other
 * scopes' rows get their own surfaces later; the two mutations below are
 * scope-generic because the API endpoint is.
 *
 * Semantics to keep in mind when composing a PUT:
 *  - the row is REPLACED (an omitted `allow`/`deny` clears that field to
 *    "inherit"), so always send the full desired lists;
 *  - `allow` only ever NARROWS what the ancestors grant; `deny` is
 *    additive and permanent down the chain;
 *  - DELETE reverts the scope to inheriting.
 */

export interface UpsertToolGrantInput {
    scopeType: ToolGrantScope;
    scopeId: string;
    allow?: string[];
    deny?: string[];
    note?: string;
}

export interface ToolGrantRow {
    id: string;
    userId: string;
    scopeType: ToolGrantScope;
    scopeId: string;
    allow: string[] | null;
    deny: string[] | null;
    note: string | null;
    createdAt: string;
    updatedAt: string;
}

export const toolGrantsAPI = {
    /** Create-or-update the grant for ONE scope (`PUT /api/tool-grants`). */
    async upsert(input: UpsertToolGrantInput): Promise<ToolGrantRow> {
        return serverMutation<ToolGrantRow>({
            endpoint: '/tool-grants',
            data: input as unknown as Record<string, unknown>,
            method: 'PUT',
            wrapInData: false,
        });
    },

    /** Delete one grant row — the scope reverts to inheriting. */
    async remove(id: string): Promise<{ deleted: true }> {
        return serverMutation<{ deleted: true }>({
            endpoint: `/tool-grants/${id}`,
            data: {},
            method: 'DELETE',
            wrapInData: false,
        });
    },

    /**
     * AW-15 — providers whose plugins declare plain-English access levels
     * (`GET /api/tool-grants/presets`).
     */
    async listPresets(): Promise<{ providers: ConnectionScopePresetProviderDto[] }> {
        return serverFetch<{ providers: ConnectionScopePresetProviderDto[] }>(
            '/tool-grants/presets',
        );
    },

    /** AW-15 — the level one scope selects for one provider, and the level in effect there. */
    async getPresetState(input: {
        providerId: string;
        scopeType: ToolGrantScope;
        scopeId: string;
    }): Promise<ConnectionScopePresetStateDto> {
        const query = new URLSearchParams({
            providerId: input.providerId,
            scopeType: input.scopeType,
            scopeId: input.scopeId,
        });
        return serverFetch<ConnectionScopePresetStateDto>(`/tool-grants/presets/state?${query}`);
    },

    /**
     * AW-15 — choose a level at one scope (`PUT /api/tool-grants/presets`).
     * Written as deny patterns on that scope's grant row; a widening that
     * needs the connected account re-approved is refused with 409
     * `preset_requires_reapproval`.
     */
    async applyPreset(input: {
        providerId: string;
        scopeType: ToolGrantScope;
        scopeId: string;
        preset: ConnectionScopePresetId;
    }): Promise<ConnectionScopePresetStateDto> {
        return serverMutation<ConnectionScopePresetStateDto>({
            endpoint: '/tool-grants/presets',
            data: input,
            method: 'PUT',
            wrapInData: false,
        });
    },
};
