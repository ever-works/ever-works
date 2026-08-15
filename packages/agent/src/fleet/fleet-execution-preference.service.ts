import { BadRequestException, Injectable, Logger } from '@nestjs/common';
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

    constructor(private readonly repository: FleetExecutionPreferenceRepository) {}

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
        const row = await this.repository.upsert({
            userId,
            organizationId: input.organizationId ?? null,
            scopeType: input.scopeType,
            scopeId,
            mode: input.mode,
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
        await this.repository.remove(userId, scopeType, normalizeScopeId(scopeType, scopeId));
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
