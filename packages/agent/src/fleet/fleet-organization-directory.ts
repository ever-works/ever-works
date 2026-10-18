import { Injectable, Optional } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';

/**
 * Fleet hub (FL-01) — the three Organization facts a caller's ROLE on a node
 * is derived from (`FleetAccessService`), read-only:
 *
 *   - the owner of the Tenant an Organization belongs to (`tenants.ownerUserId`
 *     through `organizations.tenantId`) — a member of every Organization of
 *     the Tenant by construction, who holds no roster row;
 *   - a person's roster role in one Organization (`organization_members.role`:
 *     `admin` | `member`);
 *   - every Organization a person has a role in (the Tenants they own, their
 *     roster rows), for the shared-node listing.
 *
 * The repositories are resolved BY TABLE NAME from the application's
 * DataSource rather than by importing the entity classes: the roster entity
 * pulls the whole user/work/zod entity graph in with it, and the fleet module
 * is imported by every consumer of the fleet registry (the API, the task
 * worker, dozens of specs). Name-based lookup keeps that graph out of the
 * fleet module while still going through TypeORM's metadata (a table name
 * resolves to the registered entity exactly as a class does) — identifiers
 * are escaped per driver, so the same reads run on SQLite and Postgres.
 *
 * Every read answers "nothing" when no DataSource is bound (unit contexts):
 * the role derivation then fails closed to `owner | stranger`.
 */

/** Tables of the registered `Organization`, `Tenant` and `OrganizationMember` entities. */
const ORGANIZATIONS = 'organizations';
const TENANTS = 'tenants';
const ORGANIZATION_MEMBERS = 'organization_members';

export interface FleetRosterRow {
    organizationId: string;
    role: string;
}

interface OrganizationRow {
    id: string;
    tenantId: string;
}

interface TenantRow {
    id: string;
    ownerUserId: string;
}

interface MemberRow {
    organizationId: string;
    userId: string;
    role: string;
}

@Injectable()
export class FleetOrganizationDirectory {
    constructor(@Optional() @InjectDataSource() private readonly dataSource?: DataSource) {}

    /** The owner of the Tenant `organizationId` belongs to, or null. */
    async tenantOwnerOf(organizationId: string): Promise<string | null> {
        if (!this.dataSource) return null;
        const org = await this.dataSource
            .getRepository<OrganizationRow>(ORGANIZATIONS)
            .findOne({ where: { id: organizationId }, select: { id: true, tenantId: true } });
        if (!org?.tenantId) return null;
        const tenant = await this.dataSource
            .getRepository<TenantRow>(TENANTS)
            .findOne({ where: { id: org.tenantId }, select: { id: true, ownerUserId: true } });
        return tenant?.ownerUserId ?? null;
    }

    /** `userId`'s roster role in `organizationId`, or null when they hold no row. */
    async rosterRole(organizationId: string, userId: string): Promise<string | null> {
        if (!this.dataSource) return null;
        const row = await this.dataSource.getRepository<MemberRow>(ORGANIZATION_MEMBERS).findOne({
            where: { organizationId, userId },
            select: { organizationId: true, userId: true, role: true },
        });
        return row?.role ?? null;
    }

    /** The Organizations of every Tenant `userId` owns. */
    async organizationsOwnedThroughTenant(userId: string): Promise<string[]> {
        if (!this.dataSource) return [];
        const tenants = await this.dataSource
            .getRepository<TenantRow>(TENANTS)
            .find({ where: { ownerUserId: userId }, select: { id: true, ownerUserId: true } });
        const ids: string[] = [];
        for (const tenant of tenants) {
            const orgs = await this.dataSource
                .getRepository<OrganizationRow>(ORGANIZATIONS)
                .find({ where: { tenantId: tenant.id }, select: { id: true, tenantId: true } });
            ids.push(...orgs.map((org) => org.id));
        }
        return ids;
    }

    /** Every roster row `userId` holds, in any Organization. */
    async rosterRowsFor(userId: string): Promise<FleetRosterRow[]> {
        if (!this.dataSource) return [];
        const rows = await this.dataSource.getRepository<MemberRow>(ORGANIZATION_MEMBERS).find({
            where: { userId },
            select: { organizationId: true, userId: true, role: true },
        });
        return rows.map((row) => ({ organizationId: row.organizationId, role: row.role }));
    }
}
