import { OrganizationMember } from '../../entities/organization-member.entity';
import { Tenant } from '../../entities/tenant.entity';
import { User } from '../../entities/user.entity';
import { effectiveIntegrationKeyPins } from '../integration-key-pins';

/**
 * EW-P2-6 key pins outside a request (webhook deliveries). Review 2026-10-17 F33:
 * the creator check applies to the Tenant owner's keys too, as at request time.
 */
describe('effectiveIntegrationKeyPins', () => {
    const TENANT = 'tenant-1';
    const OWNER = 'owner-1';
    const ADMIN = 'admin-1';
    const key = (userId: string) => ({ userId, tenantId: TENANT, organizationIds: ['o-1', 'o-2'] });

    function manager(users: Record<string, { isActive: boolean; tenantId: string }>) {
        const repos = new Map<unknown, unknown>([
            [Tenant, { findOne: async () => ({ id: TENANT, ownerUserId: OWNER }) }],
            [
                User,
                {
                    findOne: async ({ where }: { where: { id: string } }) =>
                        users[where.id] ? { id: where.id, ...users[where.id] } : null,
                },
            ],
            [OrganizationMember, { find: async () => [{ organizationId: 'o-2' }] }],
        ]);
        return { getRepository: (entity: unknown) => repos.get(entity) } as never;
    }

    it('keeps every pin of an active Tenant owner, and only the administered ones of an admin', async () => {
        const users = {
            [OWNER]: { isActive: true, tenantId: TENANT },
            [ADMIN]: { isActive: true, tenantId: TENANT },
        };
        await expect(effectiveIntegrationKeyPins(manager(users), key(OWNER))).resolves.toEqual([
            'o-1',
            'o-2',
        ]);
        await expect(effectiveIntegrationKeyPins(manager(users), key(ADMIN))).resolves.toEqual([
            'o-2',
        ]);
    });

    it("keeps no pin once the key's creator is inactive, the Tenant owner included (F33)", async () => {
        const inactive = { [OWNER]: { isActive: false, tenantId: TENANT } };
        await expect(effectiveIntegrationKeyPins(manager(inactive), key(OWNER))).resolves.toEqual(
            [],
        );
        const moved = { [OWNER]: { isActive: true, tenantId: 'another-tenant' } };
        await expect(effectiveIntegrationKeyPins(manager(moved), key(OWNER))).resolves.toEqual([]);
        await expect(effectiveIntegrationKeyPins(manager({}), key(OWNER))).resolves.toEqual([]);
    });
});
