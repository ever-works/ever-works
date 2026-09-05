import { BadRequestException, Injectable, Logger, Optional } from '@nestjs/common';
import {
    DEFAULT_FLEET_EXECUTION_MODE,
    FLEET_EXECUTION_SCOPE_TYPES,
    isFleetExecutionMode,
    resolveFleetExecutionMode,
} from '@ever-works/contracts';
import type {
    FleetExecutionMode,
    FleetExecutionPreferenceView,
    FleetExecutionScopeQuery,
    FleetExecutionScopeType,
} from '@ever-works/contracts';
import { FleetExecutionPreference } from '../entities/fleet-execution-preference.entity';
import { FleetAuditService } from './fleet-audit.service';
import { FleetExecutionPreferenceRepository } from './fleet-execution-preference.repository';

/** A UUID, loosely — the shape every platform id has. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SetFleetExecutionPreferenceInput {
    scopeType: FleetExecutionScopeType;
    /** Required for `work` / `goal`; must be absent for `user`. */
    scopeId?: string | null;
    mode: FleetExecutionMode;
    organizationId?: string | null;
}

/**
 * Execution routing preference — owner-scoped CRUD plus the resolution
 * read the run router performs on every dispatch.
 *
 * The RULE (narrowest wins: Work → Goal → account → default) is NOT
 * implemented here. It lives in `resolveFleetExecutionMode` in
 * `@ever-works/contracts` as a pure function, so the router, this
 * service and the settings UI share exactly one definition instead of
 * three that agree until they don't.
 *
 * Everything is owner-scoped: a preference names a Work or Goal id, but
 * the row is only ever read or written under the session's `userId`, so
 * a Work id belonging to someone else resolves to nothing rather than to
 * their setting.
 */
@Injectable()
export class FleetExecutionPreferenceService {
    private readonly logger = new Logger(FleetExecutionPreferenceService.name);

    constructor(
        private readonly repository: FleetExecutionPreferenceRepository,
        // APPENDED and @Optional(): existing constructions pass only the
        // repository, and routing must never fail because bookkeeping is
        // unavailable.
        @Optional() private readonly audit?: FleetAuditService,
    ) {}

    /** Every preference row this owner has configured. */
    async listForUser(userId: string): Promise<FleetExecutionPreferenceView[]> {
        const rows = await this.repository.findByUser(userId);
        return rows.map((row) => toView(row));
    }

    /**
     * Create or update one scope's preference.
     *
     * Validation is deliberately strict about the scope/scopeId pairing:
     * a `work` row without an id would silently behave like an
     * account-wide default, and an account-wide row carrying an id would
     * be invisible to resolution. Both are the kind of "saved fine, did
     * nothing" failure this whole surface exists to avoid.
     */
    async setForUser(
        userId: string,
        input: SetFleetExecutionPreferenceInput,
    ): Promise<FleetExecutionPreferenceView> {
        if (!FLEET_EXECUTION_SCOPE_TYPES.includes(input.scopeType)) {
            throw new BadRequestException(
                `Scope must be one of: ${FLEET_EXECUTION_SCOPE_TYPES.join(', ')}`,
            );
        }
        if (!isFleetExecutionMode(input.mode)) {
            throw new BadRequestException('Unsupported execution mode');
        }
        const scopeId = normalizeScopeId(input.scopeType, input.scopeId);
        // Read the existing row FIRST so the audit delta says what
        // actually changed. Best-effort: a failed read must not stop the
        // write, so `before` degrades to null rather than throwing.
        const before = await this.findExisting(userId, input.scopeType, scopeId);
        const row = await this.repository.upsert({
            userId,
            organizationId: input.organizationId ?? null,
            scopeType: input.scopeType,
            scopeId,
            mode: input.mode,
        });
        // Act first, then audit (EW-799). No node id: a preference is an
        // owner-level routing decision, not a per-machine one.
        await this.audit?.recordNodeAction({
            action: 'execution-preference.set',
            actorUserId: userId,
            ownerUserId: userId,
            nodeId: null,
            before: before ? { mode: before.mode } : null,
            after: { mode: row.mode },
            extra: { scopeType: input.scopeType, scopeId },
        });
        return toView(row);
    }

    /**
     * Clear one scope's preference so it falls back to the next scope
     * out. Idempotent: clearing an unset scope is a no-op, not a 404 —
     * "make this scope inherit" is already true when there is no row.
     */
    async clearForUser(
        userId: string,
        scopeType: FleetExecutionScopeType,
        scopeId?: string | null,
    ): Promise<void> {
        if (!FLEET_EXECUTION_SCOPE_TYPES.includes(scopeType)) {
            throw new BadRequestException(
                `Scope must be one of: ${FLEET_EXECUTION_SCOPE_TYPES.join(', ')}`,
            );
        }
        const normalized = normalizeScopeId(scopeType, scopeId);
        const before = await this.findExisting(userId, scopeType, normalized);
        await this.repository.remove(userId, scopeType, normalized);
        // Recorded even when there was nothing to remove: "someone asked
        // this scope to inherit" is the decision, and a clear that found
        // no row is exactly the case an operator later wonders about.
        await this.audit?.recordNodeAction({
            action: 'execution-preference.clear',
            actorUserId: userId,
            ownerUserId: userId,
            nodeId: null,
            before: before ? { mode: before.mode } : null,
            after: null,
            extra: { scopeType, scopeId: normalized, existed: before !== null },
        });
    }

    /**
     * The owner's row for one scope, or null. Never throws: it exists to
     * enrich an audit delta, and a lookup hiccup must not cost the caller
     * their write.
     */
    private async findExisting(
        userId: string,
        scopeType: FleetExecutionScopeType,
        scopeId: string | null,
    ): Promise<FleetExecutionPreference | null> {
        try {
            const rows = await this.repository.findByUser(userId);
            return (
                rows.find(
                    (row) => row.scopeType === scopeType && (row.scopeId ?? null) === scopeId,
                ) ?? null
            );
        } catch (err) {
            this.logger.debug(
                `Execution-preference audit delta unavailable for user ${userId}: ${
                    err instanceof Error ? err.message : String(err)
                }`,
            );
            return null;
        }
    }

    /**
     * The mode that governs a run in this scope.
     *
     * NEVER throws: a preference lookup that fails degrades to
     * {@link DEFAULT_FLEET_EXECUTION_MODE}. Deciding where to run is
     * infrastructure, and an infrastructure hiccup must not cost the
     * user a run — the same posture the fleet routing seam already takes
     * for its runtime lookup.
     */
    async resolveForUser(
        userId: string,
        scope: FleetExecutionScopeQuery = {},
    ): Promise<FleetExecutionMode> {
        try {
            const rows = await this.repository.findByUser(userId);
            return resolveFleetExecutionMode(
                rows.map((row) => toView(row)),
                scope,
            );
        } catch (err) {
            this.logger.warn(
                `Execution-preference lookup failed for user ${userId} — using '${DEFAULT_FLEET_EXECUTION_MODE}': ${
                    err instanceof Error ? err.message : String(err)
                }`,
            );
            return DEFAULT_FLEET_EXECUTION_MODE;
        }
    }
}

/**
 * `user` rows carry no id; `work` / `goal` rows must carry a real one.
 * Rejecting rather than coercing — see `setForUser`.
 */
function normalizeScopeId(
    scopeType: FleetExecutionScopeType,
    scopeId?: string | null,
): string | null {
    if (scopeType === 'user') {
        return null;
    }
    const trimmed = typeof scopeId === 'string' ? scopeId.trim() : '';
    if (!UUID_RE.test(trimmed)) {
        throw new BadRequestException(`A ${scopeType} preference requires that ${scopeType}'s id`);
    }
    return trimmed;
}

function toView(row: FleetExecutionPreference): FleetExecutionPreferenceView {
    return {
        id: row.id,
        scopeType: row.scopeType,
        scopeId: row.scopeId ?? null,
        mode: row.mode,
        createdAt: row.createdAt ? toIso(row.createdAt) : null,
        updatedAt: row.updatedAt ? toIso(row.updatedAt) : null,
    };
}

function toIso(value: Date | string): string {
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
