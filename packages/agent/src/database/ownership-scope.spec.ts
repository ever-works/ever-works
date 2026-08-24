import { IsNull } from 'typeorm';
import {
    ownershipRelationScopeOf,
    ownershipScopeOf,
    ownershipWhere,
    type OwnershipScope,
} from './ownership-scope';

const TENANT = '11111111-1111-4111-8111-111111111111';
const ORG = '22222222-2222-4222-8222-222222222222';

/**
 * `ownershipRelationScopeOf` exists because a row's PERSISTED scope is not a
 * usable QUERY scope for its related entities. These tests pin the exact
 * difference — remove the helper and the legacy case below goes red.
 */
describe('ownershipRelationScopeOf', () => {
    it('keeps an Organization-stamped row confined to its exact Organization', () => {
        expect(ownershipRelationScopeOf({ tenantId: TENANT, organizationId: ORG })).toEqual({
            tenantId: TENANT,
            organizationId: ORG,
        });
    });

    it('keeps a personal row on its own Tenant surface', () => {
        expect(ownershipRelationScopeOf({ tenantId: TENANT, organizationId: null })).toEqual({
            tenantId: TENANT,
            organizationId: null,
        });
    });

    it('returns owner-scoped (undefined) for a fully legacy row instead of "legacy rows only"', () => {
        // The regression this prevents: ownershipScopeOf() reports
        // {null, null}, which ownershipWhere() reads as "tenantId IS NULL AND
        // organizationId IS NULL" — so a Task/Goal/Agent created before Tenant
        // stamping would reject every Agent the same user has created since,
        // and become permanently unrunnable / unassignable.
        const row = { tenantId: null, organizationId: null };
        expect(ownershipScopeOf(row)).toEqual({ tenantId: null, organizationId: null });
        expect(ownershipRelationScopeOf(row)).toBeUndefined();
    });

    it('proves the difference at the predicate level', () => {
        const row = { tenantId: null, organizationId: null };
        const persisted = ownershipWhere('user-1', ownershipScopeOf(row) as OwnershipScope);
        // Only legacy rows match — a current-Tenant Agent of the same user does not.
        expect(persisted).toEqual([
            { userId: 'user-1', organizationId: IsNull(), tenantId: IsNull() },
        ]);

        const relation = ownershipWhere('user-1', ownershipRelationScopeOf(row));
        // Owner-scoped: the same user's Agents are reachable again, and no
        // other user's rows ever are (userId is always in the predicate).
        expect(relation).toEqual([{ userId: 'user-1' }]);
    });

    it('never widens an Organization row to another workspace', () => {
        const relation = ownershipWhere(
            'user-1',
            ownershipRelationScopeOf({ tenantId: TENANT, organizationId: ORG }),
        );
        expect(relation).toEqual([{ userId: 'user-1', tenantId: TENANT, organizationId: ORG }]);
    });
});
