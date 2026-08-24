import { IsNull, type FindOptionsWhere } from 'typeorm';

/** Request ownership selected by SessionScopeGuard / X-Scope-Slug. */
export interface OwnershipScope {
    tenantId: string | null;
    organizationId: string | null;
}

export interface OwnershipStamp {
    tenantId?: string | null;
    organizationId?: string | null;
}

export interface OwnershipScopedRow {
    tenantId?: string | null;
    organizationId?: string | null;
}

export interface OwnershipSqlPredicate {
    clause: string;
    parameters: Record<string, string>;
}

/**
 * User + request-scope predicates for Tier C entities.
 *
 * Personal scope includes rows stamped with the current Tenant and legacy
 * rows that pre-date Tenant stamping, while excluding rows from every other
 * Tenant and every Organization. An omitted scope preserves background-job
 * and legacy service-call behavior; HTTP controllers always pass one.
 */
export function ownershipWhere<T>(userId: string, scope?: OwnershipScope): FindOptionsWhere<T>[] {
    const base = { userId } as unknown as FindOptionsWhere<T>;
    if (!scope) return [base];

    if (scope.organizationId) {
        return [
            {
                ...base,
                tenantId: scope.tenantId ?? IsNull(),
                organizationId: scope.organizationId,
            } as FindOptionsWhere<T>,
        ];
    }

    const personal = {
        ...base,
        organizationId: IsNull(),
    } as FindOptionsWhere<T>;
    if (!scope.tenantId) {
        return [{ ...personal, tenantId: IsNull() } as FindOptionsWhere<T>];
    }
    return [
        { ...personal, tenantId: scope.tenantId } as FindOptionsWhere<T>,
        { ...personal, tenantId: IsNull() } as FindOptionsWhere<T>,
    ];
}

/** Add an entity-specific predicate without weakening either ownership branch. */
export function ownershipWhereWith<T>(
    userId: string,
    scope: OwnershipScope | undefined,
    where: FindOptionsWhere<T>,
): FindOptionsWhere<T> | FindOptionsWhere<T>[] {
    if (!scope) {
        return { ...where, ...ownershipWhere<T>(userId)[0] };
    }
    return ownershipWhere<T>(userId, scope).map((branch) => ({ ...where, ...branch }));
}

/** Explicit scope columns for new Tier C rows; omitted legacy calls keep subscriber behavior. */
export function ownershipStamp(scope?: OwnershipScope): OwnershipStamp {
    return scope ? { tenantId: scope.tenantId, organizationId: scope.organizationId } : {};
}

/**
 * In-memory equivalent of {@link ownershipWhere} for rows already loaded by
 * a legacy/custom repository. Keep this beside the TypeORM and SQL builders
 * so service-level validation cannot drift from database-level filtering.
 */
export function ownershipScopeMatches(row: OwnershipScopedRow, scope?: OwnershipScope): boolean {
    if (!scope) return true;

    const tenantId = row.tenantId ?? null;
    const organizationId = row.organizationId ?? null;
    if (scope.organizationId) {
        return tenantId === scope.tenantId && organizationId === scope.organizationId;
    }
    return (
        organizationId === null &&
        (tenantId === scope.tenantId || (scope.tenantId !== null && tenantId === null))
    );
}

/** Scope persisted on a row, normalized away from optional/undefined fields. */
export function ownershipScopeOf(row: OwnershipScopedRow): OwnershipScope {
    return {
        tenantId: row.tenantId ?? null,
        organizationId: row.organizationId ?? null,
    };
}

/**
 * Scope to use when following an already-validated relationship pointer.
 *
 * A null/null stamp means the source row predates ownership stamping; turning
 * that stamp into a query scope would mean "legacy targets only" and hide the
 * same owner's current-tenant target. Scoped source rows remain exact and
 * therefore keep cross-Organization relationships fail-closed.
 */
export function ownershipRelationScopeOf(row: OwnershipScopedRow): OwnershipScope | undefined {
    const scope = ownershipScopeOf(row);
    return scope.tenantId === null && scope.organizationId === null ? undefined : scope;
}

/**
 * QueryBuilder equivalent of {@link ownershipWhere}. The parameter prefix
 * keeps the primitive safe to compose more than once in a single query.
 */
export function ownershipSqlPredicate(
    alias: string,
    scope?: OwnershipScope,
    parameterPrefix = 'ownership',
): OwnershipSqlPredicate | undefined {
    if (!scope) return undefined;

    const tenantParameter = `${parameterPrefix}TenantId`;
    const organizationParameter = `${parameterPrefix}OrganizationId`;
    const columnPrefix = alias ? `${alias}.` : '';
    const tenantColumn = `${columnPrefix}tenantId`;
    const organizationColumn = `${columnPrefix}organizationId`;

    if (scope.organizationId) {
        const tenantClause = scope.tenantId
            ? `${tenantColumn} = :${tenantParameter}`
            : `${tenantColumn} IS NULL`;
        return {
            clause: `(${tenantClause} AND ${organizationColumn} = :${organizationParameter})`,
            parameters: {
                ...(scope.tenantId ? { [tenantParameter]: scope.tenantId } : {}),
                [organizationParameter]: scope.organizationId,
            },
        };
    }

    if (!scope.tenantId) {
        return {
            clause: `(${organizationColumn} IS NULL AND ${tenantColumn} IS NULL)`,
            parameters: {},
        };
    }

    return {
        clause: `(${organizationColumn} IS NULL AND (${tenantColumn} = :${tenantParameter} OR ${tenantColumn} IS NULL))`,
        parameters: { [tenantParameter]: scope.tenantId },
    };
}
