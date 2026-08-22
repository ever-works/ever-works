import { IsNull, type FindOptionsWhere } from 'typeorm';

/** Request ownership selected by SessionScopeGuard / X-Scope-Slug. */
export interface OwnershipScope {
    tenantId: string | null;
    organizationId: string | null;
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
