import { DataSource } from 'typeorm';
import { ENTITIES } from '../../database/_entities-inventory';
import { FleetNode } from '../../entities/fleet-node.entity';
import { Organization } from '../../entities/organization.entity';
import { OrganizationMember } from '../../entities/organization-member.entity';
import { Tenant } from '../../entities/tenant.entity';
import { User } from '../../entities/user.entity';
import { FleetAccessService } from '../fleet-access.service';
import { FleetNodeRepository } from '../fleet-node.repository';
import { FleetOrganizationDirectory } from '../fleet-organization-directory';

/**
 * Fleet hub (FL-01) — role derivation against a REAL (better-sqlite3,
 * synchronize) schema.
 *
 * `FleetOrganizationDirectory` reads the roster tables BY TABLE NAME (so the
 * fleet module imports no roster entity); a service-level mock cannot prove
 * that a table name resolves to the registered entity, that its camelCase
 * columns are escaped for the driver, or that the new `fleet_nodes` columns
 * round-trip. This does, end to end through `FleetAccessService`
 * (ACC-FL01-14, S9).
 */
describe('fleet access — roles from the real roster (better-sqlite3)', () => {
    let dataSource: DataSource;
    let access: FleetAccessService;
    let nodeRows: FleetNodeRepository;
    const ids: Record<string, string> = {};

    const user = async (name: string, tenantId: string | null = null) => {
        const users = dataSource.getRepository(User);
        const saved = await users.save(
            users.create({
                username: name,
                email: `${name}@example.com`,
                password: 'x',
                tenantId,
            } as Partial<User>),
        );
        return saved.id;
    };

    beforeAll(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: ENTITIES,
            synchronize: true,
            logging: false,
        });
        await dataSource.initialize();

        ids.tenantOwner = await user('tenant-owner');
        const tenant = await dataSource
            .getRepository(Tenant)
            .save({
                ownerUserId: ids.tenantOwner,
                slug: 'acme',
                displayName: 'Acme',
            } as Partial<Tenant>);
        const org = await dataSource.getRepository(Organization).save({
            tenantId: tenant.id,
            slug: 'acme-org',
            displayName: 'Acme',
        } as Partial<Organization>);
        const otherTenantOwner = await user('other-owner');
        const otherTenant = await dataSource
            .getRepository(Tenant)
            .save({
                ownerUserId: otherTenantOwner,
                slug: 'other',
                displayName: 'Other',
            } as Partial<Tenant>);
        const otherOrg = await dataSource.getRepository(Organization).save({
            tenantId: otherTenant.id,
            slug: 'other-org',
            displayName: 'Other',
        } as Partial<Organization>);
        ids.org = org.id;
        ids.otherOrg = otherOrg.id;

        ids.owner = await user('node-owner', tenant.id);
        ids.admin = await user('org-admin', tenant.id);
        ids.member = await user('org-member', tenant.id);
        ids.otherMember = await user('other-member', otherTenant.id);
        ids.tenantMemberNoRow = await user('tenant-member-no-row', tenant.id);
        ids.outsider = await user('outsider');

        const roster = dataSource.getRepository(OrganizationMember);
        await roster.save([
            {
                organizationId: org.id,
                tenantId: tenant.id,
                userId: ids.owner,
                role: 'member',
                joinedAt: new Date(),
            },
            {
                organizationId: org.id,
                tenantId: tenant.id,
                userId: ids.admin,
                role: 'admin',
                joinedAt: new Date(),
            },
            {
                organizationId: org.id,
                tenantId: tenant.id,
                userId: ids.member,
                role: 'member',
                joinedAt: new Date(),
            },
            {
                organizationId: otherOrg.id,
                tenantId: otherTenant.id,
                userId: ids.otherMember,
                role: 'member',
                joinedAt: new Date(),
            },
        ] as Partial<OrganizationMember>[]);

        nodeRows = new FleetNodeRepository(dataSource.getRepository(FleetNode));
        const make = (name: string, overrides: Partial<FleetNode> = {}) =>
            dataSource.getRepository(FleetNode).save({
                userId: ids.owner,
                organizationId: org.id,
                name,
                kind: 'node',
                status: 'online',
                enrollmentTokenHash: `hash-${name}`,
                capabilities: [],
                ...overrides,
            } as Partial<FleetNode>);
        ids.bound = (await make('build-01')).id;
        ids.hidden = (await make('build-02', { controlPolicyFamilies: { view: 'org-admins' } })).id;
        ids.unbound = (await make('win-lab', { organizationId: null })).id;

        access = new FleetAccessService(nodeRows, new FleetOrganizationDirectory(dataSource));
    });

    afterAll(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    const node = async (id: string) => (await nodeRows.findById(id)) as FleetNode;

    it('stores the new columns with their defaults and round-trips the family map', async () => {
        const plain = await node(ids.bound);
        expect(plain.isFavorite).toBe(false);
        expect(plain.controlPolicy).toBe('owner');
        expect(plain.controlPolicyFamilies ?? null).toBeNull();
        expect((await node(ids.hidden)).controlPolicyFamilies).toEqual({ view: 'org-admins' });
    });

    it.each([
        ['the owner', 'owner', 'owner'],
        ['the Tenant owner of the bound Organization', 'tenantOwner', 'org-admin'],
        ['a roster admin of it', 'admin', 'org-admin'],
        ['a roster member of it', 'member', 'org-member'],
        ['a member of another Organization', 'otherMember', 'stranger'],
        ['a Tenant member with no roster row', 'tenantMemberNoRow', 'stranger'],
        ['someone in no Tenant', 'outsider', 'stranger'],
    ])('derives %s', async (_name, who, expected) => {
        await expect(access.roleFor(await node(ids.bound), ids[who])).resolves.toBe(expected);
    });

    it('derives stranger for everyone but the owner on an unbound node (FR-26)', async () => {
        const unbound = await node(ids.unbound);
        await expect(access.roleFor(unbound, ids.admin)).resolves.toBe('stranger');
        await expect(access.roleFor(unbound, ids.owner)).resolves.toBe('owner');
    });

    it('lists the shared nodes the view audience admits, per role (S9)', async () => {
        const forMember = await access.listSharedWith(ids.member);
        expect(forMember.map((entry) => [entry.node.name, entry.role])).toEqual([
            ['build-01', 'org-member'],
        ]);
        const forAdmin = await access.listSharedWith(ids.admin);
        expect(forAdmin.map((entry) => [entry.node.name, entry.role])).toEqual([
            ['build-01', 'org-admin'],
            ['build-02', 'org-admin'],
        ]);
        const forTenantOwner = await access.listSharedWith(ids.tenantOwner);
        expect(forTenantOwner.map((entry) => entry.node.name)).toEqual(['build-01', 'build-02']);
        await expect(access.listSharedWith(ids.otherMember)).resolves.toEqual([]);
        // The owner's own nodes are never "shared with" them.
        await expect(access.listSharedWith(ids.owner)).resolves.toEqual([]);
    });

    it('answers 404 to a member of another Organization, identical to an unknown id', async () => {
        const hidden = await access.resolveVisible(ids.bound, ids.otherMember).catch((e) => e);
        const unknown = await access
            .resolveVisible('00000000-0000-4000-8000-000000000000', ids.otherMember)
            .catch((e) => e);
        expect(hidden.getStatus()).toBe(404);
        expect(unknown.getStatus()).toBe(404);
    });
});
