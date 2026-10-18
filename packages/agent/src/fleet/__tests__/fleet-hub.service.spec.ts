import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { FleetNode } from '../../entities/fleet-node.entity';
import { FLEET_SHARED_VIEW_FIELDS, FleetService } from '../fleet.service';
import { FleetAccessService } from '../fleet-access.service';

/**
 * Fleet hub (FL-01) — the registry acts and reads the hub adds to
 * `FleetService`: the favourite (owner only), the per-family policy (owner
 * only, legacy column as the `desktop` mirror, one `node.policy.change` row
 * per family changed) and the widened `listVisibleForUser`.
 */

const OWNER = 'owner-1';
const MEMBER = 'member-1';
const ORG = 'org-a';

const node = (overrides: Partial<FleetNode> = {}): FleetNode =>
    ({
        id: 'node-1',
        userId: OWNER,
        organizationId: ORG,
        name: 'build-01',
        kind: 'node',
        status: 'online',
        lastHeartbeatAt: new Date(),
        capabilities: [],
        capabilitiesPinned: false,
        platform: 'linux/x64',
        version: '1.0.0',
        modelIdentity: 'owner@example.test',
        controlPolicy: 'owner',
        controlPolicyFamilies: null,
        isFavorite: false,
        recordWatchSessions: false,
        recordingRetentionDays: 14,
        createdAt: new Date('2026-10-01T00:00:00.000Z'),
        ...overrides,
    }) as FleetNode;

type AuditRow = {
    action: string;
    actorUserId: string | null;
    before?: Record<string, unknown> | null;
    after?: Record<string, unknown> | null;
    extra?: Record<string, unknown> | null;
};

function build(rows: FleetNode[] = [node()]) {
    const store = new Map(rows.map((row) => [row.id, row]));
    const audits: AuditRow[] = [];
    const repository = {
        findById: jest.fn(async (id: string) => store.get(id) ?? null),
        findByUser: jest.fn(async (userId: string) =>
            [...store.values()].filter((row) => row.userId === userId),
        ),
        findByOrganizations: jest.fn(async (ids: readonly string[]) =>
            [...store.values()].filter(
                (row) => row.organizationId && ids.includes(row.organizationId),
            ),
        ),
        update: jest.fn(async (id: string, patch: Partial<FleetNode>) => {
            const current = store.get(id);
            if (current) store.set(id, { ...current, ...patch } as FleetNode);
        }),
        sweepOffline: jest.fn(async () => 0),
        findStaleOnline: jest.fn(async () => []),
        findOfflineUnnoticed: jest.fn(async () => []),
    };
    // MEMBER holds a `member` roster row in ORG; the Tenant owner is someone else.
    const directory = {
        tenantOwnerOf: jest.fn(async () => 'tenant-owner'),
        rosterRole: jest.fn(async (organizationId: string, userId: string) =>
            organizationId === ORG && userId === MEMBER ? 'member' : null,
        ),
        organizationsOwnedThroughTenant: jest.fn(async () => []),
        rosterRowsFor: jest.fn(async (userId: string) =>
            userId === MEMBER ? [{ organizationId: ORG, role: 'member' }] : [],
        ),
    };
    const access = new FleetAccessService(repository as never, directory as never);
    const audit = {
        recordNodeAction: jest.fn(async (input: AuditRow) => {
            audits.push(input);
            return true;
        }),
    };
    const service = new FleetService(
        repository as never,
        undefined,
        undefined,
        undefined,
        audit as never,
        access,
    );
    return { service, repository, store, audits };
}

describe('FleetService favourites (FR-24, spec §7)', () => {
    it('lets the owner star and unstar, persisted on the row, with no audit row', async () => {
        const { service, store, audits } = build();
        const starred = await service.setFavoriteForUser(OWNER, 'node-1', true);
        expect(starred.isFavorite).toBe(true);
        expect(store.get('node-1')?.isFavorite).toBe(true);
        const unstarred = await service.setFavoriteForUser(OWNER, 'node-1', false);
        expect(unstarred.isFavorite).toBe(false);
        expect(audits).toEqual([]);
    });

    it('refuses an Organization member with permission_denied, not a 404', async () => {
        const { service, repository } = build();
        const refusal = await service.setFavoriteForUser(MEMBER, 'node-1', true).catch((e) => e);
        expect(refusal).toBeInstanceOf(ForbiddenException);
        expect((refusal as ForbiddenException).getResponse()).toMatchObject({
            error: { code: 'permission_denied', hint: 'Only the owner of build-01 can do this.' },
        });
        expect(repository.update).not.toHaveBeenCalled();
    });

    it('answers a stranger with the 404 of an unknown id', async () => {
        const { service } = build();
        await expect(service.setFavoriteForUser('stranger', 'node-1', true)).rejects.toBeInstanceOf(
            NotFoundException,
        );
    });

    it('writes nothing when the star is already in place', async () => {
        const { service, repository } = build([node({ isFavorite: true })]);
        await service.setFavoriteForUser(OWNER, 'node-1', true);
        expect(repository.update).not.toHaveBeenCalled();
    });
});

describe('FleetService control policy families (FR-27 … FR-31)', () => {
    it('applies a partial map, keeps the rest, and audits one node.policy.change per family', async () => {
        const { service, store, audits } = build();
        const view = await service.setControlPolicyFamiliesForUser(OWNER, 'node-1', {
            sessions: 'org-admins',
            services: 'owner',
        });
        expect(view.controlPolicyFamilies?.sessions).toBe('org-admins');
        expect(view.controlPolicyFamilies?.services).toBe('owner');
        expect(view.controlPolicyFamilies?.view).toBe('org-members');
        expect(store.get('node-1')?.controlPolicyFamilies).toEqual({
            sessions: 'org-admins',
            services: 'owner',
        });
        // `services` did not change (owner → owner), so only one row.
        expect(audits).toEqual([
            {
                action: 'node.policy.change',
                actorUserId: OWNER,
                ownerUserId: OWNER,
                nodeId: 'node-1',
                before: { audience: 'owner' },
                after: { audience: 'org-admins' },
                extra: {
                    family: 'sessions',
                    from: 'owner',
                    to: 'org-admins',
                    target: 'sessions',
                    requestedBy: `user:${OWNER}`,
                    confirmationClass: 'plain',
                    outcome: 'success',
                },
            },
        ]);
    });

    it('writes the legacy controlPolicy back whenever desktop changes (the AW-11 mirror)', async () => {
        const { service, store, repository } = build([node({ controlPolicy: 'org-admins' })]);
        await service.setControlPolicyFamiliesForUser(OWNER, 'node-1', { desktop: 'owner' });
        // ONE update carrying both columns, so the mirror can never be half-written.
        expect(repository.update).toHaveBeenCalledTimes(1);
        expect(repository.update).toHaveBeenCalledWith('node-1', {
            controlPolicyFamilies: { desktop: 'owner' },
            controlPolicy: 'owner',
        });
        expect(store.get('node-1')?.controlPolicy).toBe('owner');
        expect(store.get('node-1')?.controlPolicyFamilies).toEqual({ desktop: 'owner' });
    });

    it('leaves the legacy column alone when desktop is not named', async () => {
        const { service, repository } = build([node({ controlPolicy: 'org-admins' })]);
        await service.setControlPolicyFamiliesForUser(OWNER, 'node-1', { logs: 'org-members' });
        expect(repository.update).toHaveBeenCalledWith('node-1', {
            controlPolicyFamilies: { logs: 'org-members' },
        });
    });

    it('reads a legacy row as desktop = the old value, other families default (U13)', async () => {
        const { service } = build([node({ controlPolicy: 'org-members' })]);
        const { view } = await service.getVisibleForUser(OWNER, 'node-1');
        expect(view.controlPolicy).toBe('org-members');
        expect(view.controlPolicyFamilies?.desktop).toBe('org-members');
        expect(view.controlPolicyFamilies?.machines).toBe('owner');
    });

    it('writes nothing and audits nothing when the audiences are unchanged', async () => {
        const { service, repository, audits } = build();
        await service.setControlPolicyFamiliesForUser(OWNER, 'node-1', { view: 'org-members' });
        expect(repository.update).not.toHaveBeenCalled();
        expect(audits).toEqual([]);
    });

    it.each([
        ['an unknown family', { lifecycle: 'owner' }],
        ['an unknown audience', { sessions: 'everyone' }],
        ['an empty map', {}],
        ['a non-map', ['sessions']],
    ])('refuses %s as invalid', async (_name, input) => {
        const { service, repository } = build();
        const refusal = await service
            .setControlPolicyFamiliesForUser(OWNER, 'node-1', input)
            .catch((error) => error);
        expect(refusal).toBeInstanceOf(BadRequestException);
        expect((refusal as BadRequestException).getResponse()).toMatchObject({
            error: { code: 'invalid', details: { field: 'controlPolicyFamilies' } },
        });
        expect(repository.update).not.toHaveBeenCalled();
    });

    it('is owner-only: a member who can see the node is refused, a stranger gets 404', async () => {
        const { service } = build();
        await expect(
            service.setControlPolicyFamiliesForUser(MEMBER, 'node-1', { sessions: 'org-members' }),
        ).rejects.toBeInstanceOf(ForbiddenException);
        await expect(
            service.setControlPolicyFamiliesForUser('stranger', 'node-1', {
                sessions: 'org-members',
            }),
        ).rejects.toBeInstanceOf(NotFoundException);
    });
});

describe('FleetService.listVisibleForUser (S9)', () => {
    const others = node({
        id: 'node-shared',
        userId: 'someone',
        name: 'design-mac',
        isFavorite: true,
    });

    it('lists the caller’s own nodes as owner, unchanged from listForUser', async () => {
        const { service } = build();
        const own = await service.listForUser(OWNER);
        const visible = await service.listVisibleForUser(OWNER);
        expect(visible).toEqual(own.map((view) => ({ ...view, viewerRole: 'owner' })));
    });

    it('adds another owner’s Organization-bound node, narrowed for a member', async () => {
        const { service } = build([others]);
        const visible = await service.listVisibleForUser(MEMBER);
        expect(visible).toHaveLength(1);
        expect(visible[0]).toMatchObject({
            id: 'node-shared',
            viewerRole: 'org-member',
            isFavorite: false,
        });
    });

    it('shares an ALLOW-LIST of fields — nothing the owner did not decide to share', async () => {
        const holder = node({
            id: 'node-shared',
            userId: 'someone',
            modelIdentity: 'owner@example.test',
            dailyCostCeilingCents: 500,
            workerState: 'quarantined',
            workerStateReason:
                'process tree under /home/owner/secret-project could not be proven dead',
            controlHolderUserId: 'someone',
            controlHolderSessionId: 'session-1',
            controlExpiresAt: new Date(Date.now() + 60_000),
            rotationRequestedAt: new Date(),
            modelThrottles: [
                {
                    provider: 'claude-code',
                    window: 'weekly',
                    until: new Date(Date.now() + 3_600_000).toISOString(),
                    reason: "You've hit your weekly limit for owner@example.test",
                    since: new Date().toISOString(),
                },
            ],
        } as Partial<FleetNode>);
        const { service } = build([holder]);
        const [shared] = await service.listVisibleForUser(MEMBER);
        expect(Object.keys(shared).sort()).toEqual([...FLEET_SHARED_VIEW_FIELDS].sort());
        const serialized = JSON.stringify(shared);
        expect(serialized).not.toContain('owner@example.test');
        expect(serialized).not.toContain('secret-project');
        expect(shared.workerState).toBe('quarantined');
        expect(shared.modelThrottles?.[0]).toMatchObject({ provider: 'claude-code', reason: '' });
    });

    it('keeps the needs-a-look read off the live cluster merge', async () => {
        const { service } = build([others]);
        const listForUser = jest.spyOn(service, 'listForUser');
        await service.listVisibleForUser(MEMBER, { includeClusters: false });
        expect(listForUser).not.toHaveBeenCalled();
    });

    it('shows a shared node whose heartbeat is stale as offline without writing anything', async () => {
        const stale = node({
            id: 'node-shared',
            userId: 'someone',
            status: 'online',
            lastHeartbeatAt: new Date(Date.now() - 24 * 60 * 60_000),
        });
        const { service, repository } = build([stale]);
        const [view] = await service.listVisibleForUser(MEMBER);
        expect(view.status).toBe('offline');
        expect(repository.update).not.toHaveBeenCalled();
    });

    it('keeps a shared node out of the owner-only listForUser (runner pill, panic controls)', async () => {
        const { service } = build([others]);
        await expect(service.listForUser(MEMBER)).resolves.toEqual([]);
    });

    it('opens a shared node for a member and 404s it for a stranger (FR-30, FR-32)', async () => {
        const { service } = build([others]);
        await expect(service.getVisibleForUser(MEMBER, 'node-shared')).resolves.toMatchObject({
            role: 'org-member',
            view: { id: 'node-shared', viewerRole: 'org-member' },
        });
        await expect(service.getVisibleForUser('stranger', 'node-shared')).rejects.toBeInstanceOf(
            NotFoundException,
        );
    });
});
