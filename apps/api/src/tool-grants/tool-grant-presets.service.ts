import { BadRequestException, ConflictException, Injectable, Optional } from '@nestjs/common';
import {
    applyConnectionScopePresetWithOwnership,
    connectionScopePresetBlockingDeny,
    connectionScopePresetClampSource,
    resolveEffectiveConnectionScopePreset,
    storedConnectionScopePresetWithOwnership,
    type ConnectionScopePresetDeclaration,
    type ConnectionScopePresetId,
    type ConnectionScopePresetProviderDto,
    type ConnectionScopePresetStateDto,
    type ToolGrantScope,
} from '@ever-works/contracts';
import { ConnectionScopesFacadeService } from '@ever-works/agent/facades';
import {
    ToolGrantRepository,
    ToolGrantService,
    type ToolGrantResolveInput,
} from '@ever-works/agent/policy';
import { AuthAccountRepository, buildPluginProviderId } from '@ever-works/agent/database';

/** One (scope, provider) the preset control is asked about. */
export interface ToolGrantPresetTarget {
    userId: string;
    scopeType: ToolGrantScope;
    scopeId: string;
    providerId: string;
}

/** Stable machine-readable code for the widening refusal. */
export const PRESET_REQUIRES_REAPPROVAL = 'preset_requires_reapproval' as const;

/**
 * Scope presets (AW-15) — the I/O half of "Read only / Read and write" on
 * the tool-grant lattice.
 *
 * Reads a provider's declared levels from `ConnectionScopesFacadeService`,
 * and reads/writes ONE scope's existing `tool_grants` row through the
 * policy module. The mapping itself is the pure
 * `applyConnectionScopePresetWithOwnership` in `@ever-works/contracts`, so
 * there is no second permission model: a level is ordinary deny patterns,
 * `decideToolGrant` stays the only decision point, and the resolution chain
 * already explains which scope narrowed a tool.
 *
 * An operator's own deny is never removed. The row's `presetOwnership`
 * records exactly which patterns THIS control added; a pattern that was
 * already denied when the control first touched the row stays operator-owned
 * through every level change, and the state reports it as
 * `blockedByExistingDeny` whenever it holds a tool of the chosen level closed.
 *
 * Owner scoping is NOT done here — every caller goes through
 * `ToolGrantsController`, which runs the same ownership checks as a raw
 * tool-grant write before this service is reached.
 */
@Injectable()
export class ToolGrantPresetsService {
    constructor(
        private readonly scopes: ConnectionScopesFacadeService,
        private readonly toolGrants: ToolGrantService,
        private readonly grants: ToolGrantRepository,
        /**
         * Used only to tell whether widening needs the owner to re-approve
         * the connected account. Unbound ⇒ no re-approval check, never a
         * refusal.
         */
        @Optional() private readonly accounts?: AuthAccountRepository,
    ) {}

    listProviders(): Promise<ConnectionScopePresetProviderDto[]> {
        return this.scopes.listProviders();
    }

    /** The level this scope selects, and the level actually in effect there. */
    async getState(target: ToolGrantPresetTarget): Promise<ConnectionScopePresetStateDto> {
        const presets = await this.requirePresets(target.providerId);
        return this.buildState(target, presets);
    }

    /**
     * Choose a level at one scope. Narrowing never needs re-approval;
     * widening is refused with `preset_requires_reapproval` — before anything
     * is written — when the owner's connected account reports permissions
     * that do not cover the wider level.
     */
    async apply(
        target: ToolGrantPresetTarget,
        preset: ConnectionScopePresetId,
    ): Promise<ConnectionScopePresetStateDto> {
        const presets = await this.requirePresets(target.providerId);
        const chosen = presets.find((candidate) => candidate.id === preset);
        if (!chosen) {
            throw new BadRequestException(
                `Provider '${target.providerId}' does not offer the '${preset}' access level.`,
            );
        }

        const row = await this.grants.findOne(target.userId, target);
        const current = row ? { allow: row.allow ?? undefined, deny: row.deny ?? undefined } : null;
        const ownership = row?.presetOwnership ?? null;
        const before = storedConnectionScopePresetWithOwnership(
            current,
            ownership,
            target.providerId,
            presets,
        );

        if (before !== preset && presets[presets.length - 1].id === preset) {
            await this.assertNoReapprovalNeeded(target, chosen);
        }

        const next = applyConnectionScopePresetWithOwnership(
            current,
            ownership,
            target.providerId,
            presets,
            preset,
        );
        const nothingLeft = next.grant.allow === undefined && (next.grant.deny ?? []).length === 0;
        if (nothingLeft) {
            // The scope no longer narrows anything — no operator rule, no
            // level-owned pattern: remove the row so it inherits again,
            // exactly as a DELETE /api/tool-grants/:id would.
            if (row) await this.toolGrants.remove(target.userId, row.id);
        } else {
            await this.toolGrants.upsert({
                userId: target.userId,
                scopeType: target.scopeType,
                scopeId: target.scopeId,
                grant: next.grant,
                // A preset change must not erase the operator's note.
                note: row?.note ?? null,
                presetOwnership: next.ownership,
            });
        }

        return this.buildState(target, presets);
    }

    // ── internals ─────────────────────────────────────────────────────

    private async requirePresets(providerId: string): Promise<ConnectionScopePresetDeclaration[]> {
        const presets = await this.scopes.getPresets(providerId);
        if (presets.length === 0) {
            throw new BadRequestException(
                `Provider '${providerId}' does not declare access levels (it keeps standard access).`,
            );
        }
        return presets;
    }

    private async buildState(
        target: ToolGrantPresetTarget,
        presets: ConnectionScopePresetDeclaration[],
    ): Promise<ConnectionScopePresetStateDto> {
        const row = await this.grants.findOne(target.userId, target);
        const requested = storedConnectionScopePresetWithOwnership(
            row ? { allow: row.allow ?? undefined, deny: row.deny ?? undefined } : null,
            row?.presetOwnership ?? null,
            target.providerId,
            presets,
        );
        const resolved = await this.toolGrants.resolve(resolveInputFor(target));
        const effective = resolveEffectiveConnectionScopePreset(presets, resolved.matrix);
        return {
            providerId: target.providerId,
            scopeType: target.scopeType,
            scopeId: target.scopeId,
            presets: presets.map((preset) => preset.id),
            requested,
            effective,
            clampedBy: connectionScopePresetClampSource(presets, requested, effective, resolved),
            // An operator's own deny on THIS row that holds a tool of the
            // chosen level closed. Never removed by a level change, so the
            // UI must say so rather than look like the choice did nothing.
            blockedByExistingDeny: connectionScopePresetBlockingDeny(
                presets,
                requested,
                row?.deny ?? null,
                row?.presetOwnership ?? null,
            ),
        };
    }

    private async assertNoReapprovalNeeded(
        target: ToolGrantPresetTarget,
        preset: ConnectionScopePresetDeclaration,
    ): Promise<void> {
        if (!this.accounts || preset.providerScopes.length === 0) return;
        const account = await this.accounts.findProviderAccount(
            target.userId,
            buildPluginProviderId(target.providerId),
        );
        // No connected account, or a provider that does not report granted
        // permissions: nothing to compare, so nothing to refuse.
        if (!account?.accessToken || !account.scope || account.scope.trim().length === 0) return;
        if (this.accounts.hasRequiredScopes(account, preset.providerScopes)) return;
        throw new ConflictException({
            statusCode: 409,
            code: PRESET_REQUIRES_REAPPROVAL,
            providerId: target.providerId,
            message: `Reconnect ${target.providerId} and approve the additional access before widening this level.`,
        });
    }
}

/** Resolve the chain as it applies AT this scope (its ancestors plus itself). */
function resolveInputFor(target: ToolGrantPresetTarget): ToolGrantResolveInput {
    switch (target.scopeType) {
        case 'agent':
            return { userId: target.userId, agentId: target.scopeId };
        case 'work':
            return { userId: target.userId, workId: target.scopeId };
        case 'organization':
            return { userId: target.userId, organizationId: target.scopeId };
        case 'tenant':
            return { userId: target.userId, tenantId: target.scopeId };
    }
}
