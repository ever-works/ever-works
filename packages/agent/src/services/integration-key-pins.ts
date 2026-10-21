import type { EntityManager } from 'typeorm';
import type { ApiKey } from '../entities/api-key.entity';
import { OrganizationMember } from '../entities/organization-member.entity';
import { Tenant } from '../entities/tenant.entity';
import { User } from '../entities/user.entity';

/**
 * EW-P2-6 — the Organization pins an integration key may use right now. This is the
 * same rule as `ApiKeyService.effectivePins` (request time), for the paths that act on
 * the key outside a request (webhook deliveries):
 *  - none once the key's creator is inactive or no longer in the key's Tenant, whoever
 *    the creator is (review 2026-10-17 F33: the request path refuses such a key with
 *    401, so its webhooks must stop too — the Tenant owner's keys included);
 *  - a key the Tenant owner created keeps every pin;
 *  - a key an Organization admin created keeps only the pins its creator still
 *    administers (roster role `admin`) — so a demotion or removal takes the pins away
 *    at once;
 *  - a legacy row with no `tenantId` keeps its stored pins (no rule to apply).
 */
export async function effectiveIntegrationKeyPins(
    manager: EntityManager,
    key: Pick<ApiKey, 'userId' | 'tenantId' | 'organizationIds'>,
): Promise<string[]> {
    const pins = Array.isArray(key.organizationIds) ? [...key.organizationIds] : [];
    if (!key.tenantId) return pins;
    const tenant = await manager
        .getRepository(Tenant)
        .findOne({ where: { id: key.tenantId }, select: { id: true, ownerUserId: true } });
    if (!tenant) return [];
    const creator = await manager.getRepository(User).findOne({
        where: { id: key.userId },
        select: { id: true, tenantId: true, isActive: true },
    });
    if (!creator || !creator.isActive || creator.tenantId !== key.tenantId) return [];
    if (tenant.ownerUserId === key.userId) return pins;
    const rows = await manager.getRepository(OrganizationMember).find({
        where: { userId: key.userId, tenantId: key.tenantId, role: 'admin' },
        select: { organizationId: true },
    });
    const administered = new Set(rows.map((row) => row.organizationId));
    return pins.filter((id) => administered.has(id));
}
