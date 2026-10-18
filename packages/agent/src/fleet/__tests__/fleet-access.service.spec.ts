import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { FleetNode } from '../../entities/fleet-node.entity';
import { FleetAccessService, resolveFleetViewerRole } from '../fleet-access.service';

/**
 * Fleet hub (FL-01) — role derivation and the family check every Fleet
 * action runs through (CONTRACTS §2.1, ACC-FL01-14 / -16).
 */

const OWNER = 'owner-1';
const ADMIN = 'admin-1';
const MEMBER = 'member-1';
const OTHER_ORG_MEMBER = 'member-2';
const TENANT_OWNER = 'tenant-owner-1';
const OUTSIDER = 'outsider-1';
const ORG = 'org-a';
const OTHER_ORG = 'org-b';
const TENANT = 'tenant-a';

const node = (overrides: Partial<FleetNode> = {}): FleetNode =>
    ({
        id: 'node-1',
        userId: OWNER,
        organizationId: ORG,
        name: 'build-01',
        controlPolicy: 'owner',
        controlPolicyFamilies: null,
        ...overrides,
    }) as FleetNode;

interface Roster {
    organizationId: string;
    userId: string;
    role: string;
}

function build(options: { rows?: FleetNode[]; roster?: Roster[]; wired?: boolean } = {}) {
    const rows = options.rows ?? [node()];
    const roster: Roster[] = options.roster ?? [
        { organizationId: ORG, userId: ADMIN, role: 'admin' },
        { organizationId: ORG, userId: MEMBER, role: 'member' },
        { organizationId: OTHER_ORG, userId: OTHER_ORG_MEMBER, role: 'member' },
    ];
    const nodes = {
        findById: jest.fn(async (id: string) => rows.find((row) => row.id === id) ?? null),
        findByOrganizations: jest.fn(async (ids: readonly string[]) =>
            rows.filter((row) => row.organizationId && ids.includes(row.organizationId)),
        ),
    };
    // ORG belongs to TENANT, owned by TENANT_OWNER; OTHER_ORG to another Tenant.
    const tenantOf: Record<string, string> = { [ORG]: TENANT, [OTHER_ORG]: 't-b' };
    const tenantOwner: Record<string, string> = { [TENANT]: TENANT_OWNER };
    const directory = {
        tenantOwnerOf: jest.fn(
            async (organizationId: string) => tenantOwner[tenantOf[organizationId]] ?? null,
        ),
        rosterRole: jest.fn(
            async (organizationId: string, userId: string) =>
                roster.find((row) => row.organizationId === organizationId && row.userId === userId)
                    ?.role ?? null,
        ),
        organizationsOwnedThroughTenant: jest.fn(async (userId: string) =>
            Object.entries(tenantOf)
                .filter(([, tenant]) => tenantOwner[tenant] === userId)
                .map(([organizationId]) => organizationId),
        ),
        rosterRowsFor: jest.fn(async (userId: string) =>
            roster
                .filter((row) => row.userId === userId)
                .map((row) => ({ organizationId: row.organizationId, role: row.role })),
        ),
    };
    const service =
        options.wired === false
            ? new FleetAccessService(nodes as never)
            : new FleetAccessService(nodes as never, directory as never);
    jest.spyOn(
        (service as never as { logger: Record<string, () => void> }).logger,
        'warn',
    ).mockImplementation(() => undefined);
    return { service, nodes, directory };
}

describe('resolveFleetViewerRole (pure truth table)', () => {
    it.each([
        ['the owner', { callerUserId: OWNER }, 'owner'],
        [
            'the Tenant owner of the bound Organization',
            { callerUserId: TENANT_OWNER, tenantOwnerUserId: TENANT_OWNER },
            'org-admin',
        ],
        ['a roster admin', { callerUserId: ADMIN, rosterRole: 'admin' }, 'org-admin'],
        ['a roster member', { callerUserId: MEMBER, rosterRole: 'member' }, 'org-member'],
        ['someone with no roster row', { callerUserId: OUTSIDER }, 'stranger'],
        ['an unknown roster role', { callerUserId: OUTSIDER, rosterRole: 'guest' }, 'stranger'],
    ])('derives %s', (_name, facts, expected) => {
        expect(
            resolveFleetViewerRole({ nodeOwnerUserId: OWNER, organizationId: ORG, ...facts }),
        ).toBe(expected);
    });

    it('derives stranger for every non-owner of a node bound to no Organization (FR-26)', () => {
        expect(
            resolveFleetViewerRole({
                nodeOwnerUserId: OWNER,
                callerUserId: ADMIN,
                organizationId: null,
                rosterRole: 'admin',
                tenantOwnerUserId: ADMIN,
            }),
        ).toBe('stranger');
    });

    it('never derives owner for an empty caller', () => {
        expect(
            resolveFleetViewerRole({ nodeOwnerUserId: '', callerUserId: '', organizationId: ORG }),
        ).toBe('stranger');
    });
});

describe('FleetAccessService.roleFor (ACC-FL01-14)', () => {
    it.each([
        ['owner', OWNER, 'owner'],
        ['admin of the bound Organization', ADMIN, 'org-admin'],
        ['Tenant owner of the bound Organization', TENANT_OWNER, 'org-admin'],
        ['member of the bound Organization', MEMBER, 'org-member'],
        ['member of another Organization', OTHER_ORG_MEMBER, 'stranger'],
        ['nobody in particular', OUTSIDER, 'stranger'],
    ])('the %s is %s', async (_name, caller, expected) => {
        const { service } = build();
        await expect(service.roleFor(node(), caller)).resolves.toBe(expected);
        await expect(service.roleFor(node(), { userId: caller })).resolves.toBe(expected);
    });

    it('derives stranger for everyone but the owner when the node is bound to no Organization', async () => {
        const { service } = build();
        const unbound = node({ organizationId: null });
        await expect(service.roleFor(unbound, ADMIN)).resolves.toBe('stranger');
        await expect(service.roleFor(unbound, OWNER)).resolves.toBe('owner');
    });

    it('fails closed to stranger without the Organization directory', async () => {
        const { service } = build({ wired: false });
        await expect(service.roleFor(node(), ADMIN)).resolves.toBe('stranger');
        await expect(service.roleFor(node(), OWNER)).resolves.toBe('owner');
    });

    it('fails closed to stranger when the roster cannot be read', async () => {
        const { service, directory } = build();
        directory.rosterRole.mockRejectedValueOnce(new Error('db down'));
        await expect(service.roleFor(node(), ADMIN)).resolves.toBe('stranger');
    });
});

describe('FleetAccessService.assertFamily (ACC-FL01-16)', () => {
    it('answers the role when the family admits the caller', async () => {
        const { service } = build();
        const shared = node({ controlPolicyFamilies: { sessions: 'org-admins' } });
        await expect(service.assertFamily(shared, ADMIN, 'sessions')).resolves.toBe('org-admin');
        await expect(service.assertFamily(shared, OWNER, 'machines')).resolves.toBe('owner');
    });

    it('refuses a viewer outside the family with permission_denied and the hint (S10)', async () => {
        const { service } = build();
        const shared = node({ controlPolicyFamilies: { sessions: 'org-admins' } });
        const refusal = await service
            .assertFamily(shared, ADMIN, 'services')
            .catch((error) => error);
        expect(refusal).toBeInstanceOf(ForbiddenException);
        expect((refusal as ForbiddenException).getResponse()).toEqual({
            statusCode: 403,
            message: 'Ask the owner of build-01 to allow org admins: services.',
            error: {
                code: 'permission_denied',
                hint: 'Ask the owner of build-01 to allow org admins: services.',
                details: { family: 'services' },
            },
        });
    });

    it('names the machines family "lifecycle" in the hint', async () => {
        const { service } = build();
        const refusal = await service.assertFamily(node(), MEMBER, 'machines').catch((e) => e);
        expect((refusal as ForbiddenException).getResponse()).toMatchObject({
            error: { hint: 'Ask the owner of build-01 to allow org members: lifecycle.' },
        });
    });

    it('answers 404 — not 403 — to anyone outside the view audience, whatever the family (FR-30)', async () => {
        const { service } = build();
        for (const family of ['view', 'machines', 'sessions'] as const) {
            await expect(
                service.assertFamily(node(), OTHER_ORG_MEMBER, family),
            ).rejects.toBeInstanceOf(NotFoundException);
        }
        const hidden = node({ controlPolicyFamilies: { view: 'owner' } });
        await expect(service.assertFamily(hidden, MEMBER, 'view')).rejects.toBeInstanceOf(
            NotFoundException,
        );
    });

    it('answers the same 404 for an unknown id and a hidden one', async () => {
        const { service } = build();
        const unknown = await service.resolveVisible('nope', OWNER).catch((error) => error);
        const hidden = await service.resolveVisible('node-1', OUTSIDER).catch((error) => error);
        expect((unknown as NotFoundException).getStatus()).toBe(404);
        expect((hidden as NotFoundException).getStatus()).toBe(404);
        expect((hidden as NotFoundException).message).toBe('Fleet node node-1 not found');
    });

    it('reads desktop through from the legacy single value (ACC-FL01-15)', async () => {
        const { service } = build();
        const legacy = node({ controlPolicy: 'org-admins', controlPolicyFamilies: null });
        await expect(service.canAct(legacy, ADMIN, 'desktop')).resolves.toBe(true);
        await expect(service.canAct(legacy, MEMBER, 'desktop')).resolves.toBe(false);
        await expect(service.canAct(legacy, ADMIN, 'services')).resolves.toBe(false);
    });
});

describe('FleetAccessService.listSharedWith', () => {
    const shared = node({ id: 'node-shared' });
    const hidden = node({ id: 'node-hidden', controlPolicyFamilies: { view: 'org-admins' } });
    const other = node({ id: 'node-other-org', organizationId: OTHER_ORG, userId: 'someone' });
    const mine = node({ id: 'node-mine', userId: MEMBER });

    it('lists another owner’s nodes bound to the caller’s Organization when view admits them (S9)', async () => {
        const { service } = build({ rows: [shared, hidden, other, mine] });
        const result = await service.listSharedWith(MEMBER);
        expect(result.map((entry) => [entry.node.id, entry.role])).toEqual([
            ['node-shared', 'org-member'],
        ]);
    });

    it('gives a roster admin the nodes whose view is narrowed to admins', async () => {
        const { service } = build({ rows: [shared, hidden, other] });
        const result = await service.listSharedWith(ADMIN);
        expect(result.map((entry) => [entry.node.id, entry.role])).toEqual([
            ['node-shared', 'org-admin'],
            ['node-hidden', 'org-admin'],
        ]);
    });

    it('treats the Tenant owner as an admin of every Organization in the Tenant', async () => {
        const { service } = build({ rows: [shared, hidden, other] });
        const result = await service.listSharedWith(TENANT_OWNER);
        expect(result.map((entry) => entry.node.id)).toEqual(['node-shared', 'node-hidden']);
    });

    it('lists nothing for a caller in no Organization, without reading nodes', async () => {
        const { service, nodes } = build({ rows: [shared] });
        await expect(service.listSharedWith(OUTSIDER)).resolves.toEqual([]);
        expect(nodes.findByOrganizations).not.toHaveBeenCalled();
    });

    it('never lists an enrolling row — an outstanding token is the owner’s alone', async () => {
        const enrolling = node({ id: 'node-enrolling', status: 'enrolling' } as Partial<FleetNode>);
        const { service } = build({ rows: [shared, enrolling] });
        const result = await service.listSharedWith(MEMBER);
        expect(result.map((entry) => entry.node.id)).toEqual(['node-shared']);
    });

    it('degrades to nothing, never throws, when a read fails', async () => {
        const { service, directory } = build({ rows: [shared] });
        directory.rosterRowsFor.mockRejectedValueOnce(new Error('db down'));
        await expect(service.listSharedWith(MEMBER)).resolves.toEqual([]);
    });

    it('lists nothing without the Organization directory (fail-closed)', async () => {
        const { service } = build({ rows: [shared], wired: false });
        await expect(service.listSharedWith(MEMBER)).resolves.toEqual([]);
    });
});
