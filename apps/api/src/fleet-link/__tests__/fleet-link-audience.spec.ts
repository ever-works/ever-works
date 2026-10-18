import { OwnerOnlyFleetLinkAudience, RoleBasedFleetLinkAudience } from '../fleet-link-audience';
import type { FleetLinkCaller, FleetLinkNodeFacts } from '../fleet-link.types';
import { NODE_ID, OWNER } from './link-test-kit';

/**
 * The link's family audience (FL-02 × FL-01, CONTRACTS §2.1): the caller's
 * role on the node, from the Fleet hub's derivation, against the node's
 * per-family control policy — `not_found` outside `view`, the hub's
 * `permission_denied` hint inside it, owner-only for Agents and for a context
 * without the role derivation.
 */

const node = (overrides: Partial<FleetLinkNodeFacts> = {}): FleetLinkNodeFacts => ({
    id: NODE_ID,
    userId: OWNER,
    organizationId: 'org-1',
    name: 'build-01',
    kind: 'node',
    lastHeartbeatAt: null,
    storedConsents: null,
    capabilities: [],
    workerState: null,
    controlPolicy: 'owner',
    controlPolicyFamilies: null,
    ...overrides,
});

const user = (userId: string): FleetLinkCaller => ({ kind: 'user', userId });

function roleBased(role: string) {
    const access = { roleFor: jest.fn(async () => role) };
    return { audience: new RoleBasedFleetLinkAudience(access as never), access };
}

describe('RoleBasedFleetLinkAudience', () => {
    it('admits the owner in every family', async () => {
        const { audience } = roleBased('owner');
        await expect(
            audience.check({ node: node(), caller: user(OWNER), actionFamily: 'services' }),
        ).resolves.toEqual({ allowed: true });
    });

    it('lets an org member see the node by default, and answers the hub’s hint for a family not opened to them', async () => {
        const { audience, access } = roleBased('org-member');
        await expect(
            audience.check({ node: node(), caller: user('member-1'), actionFamily: 'view' }),
        ).resolves.toEqual({ allowed: true });
        await expect(
            audience.check({ node: node(), caller: user('member-1'), actionFamily: 'services' }),
        ).resolves.toEqual({
            allowed: false,
            hint: 'Ask the owner of build-01 to allow org members: services.',
        });
        // The role is derived from the node's own facts, never the request.
        expect(access.roleFor).toHaveBeenCalledWith(
            expect.objectContaining({ id: NODE_ID, userId: OWNER, organizationId: 'org-1' }),
            'member-1',
        );
    });

    it('admits an org admin in a family the owner opened to org admins', async () => {
        const { audience } = roleBased('org-admin');
        const opened = node({ controlPolicyFamilies: { services: 'org-admins' } });
        await expect(
            audience.check({ node: opened, caller: user('admin-1'), actionFamily: 'services' }),
        ).resolves.toEqual({ allowed: true });
        await expect(
            audience.check({ node: opened, caller: user('admin-1'), actionFamily: 'files' }),
        ).resolves.toMatchObject({
            allowed: false,
            hint: expect.stringContaining('org admins: files'),
        });
    });

    it('answers not_found for a stranger, and for a member when the owner closed `view`', async () => {
        await expect(
            roleBased('stranger').audience.check({
                node: node(),
                caller: user('someone'),
                actionFamily: 'view',
            }),
        ).resolves.toEqual({ allowed: false, asNotFound: true });
        await expect(
            roleBased('org-member').audience.check({
                node: node({ controlPolicyFamilies: { view: 'owner' } }),
                caller: user('member-1'),
                actionFamily: 'logs',
            }),
        ).resolves.toEqual({ allowed: false, asNotFound: true });
    });

    it('judges a schedule by its owner’s role, and admits a system job', async () => {
        const { audience, access } = roleBased('owner');
        await expect(
            audience.check({
                node: node(),
                caller: { kind: 'schedule', commandId: 'cmd-1', ownerUserId: OWNER },
                actionFamily: 'commands',
            }),
        ).resolves.toEqual({ allowed: true });
        expect(access.roleFor).toHaveBeenCalledWith(expect.anything(), OWNER);
        await expect(
            audience.check({
                node: node(),
                caller: { kind: 'system', job: 'drain-all' },
                actionFamily: 'sessions',
            }),
        ).resolves.toEqual({ allowed: true });
    });

    it('keeps an Agent owner-only (its gates are the Agent tools’), without deriving a role', async () => {
        const { audience, access } = roleBased('org-admin');
        const agent: FleetLinkCaller = { kind: 'agent', agentId: 'a-1', ownerUserId: OWNER };
        await expect(
            audience.check({ node: node(), caller: agent, actionFamily: 'view' }),
        ).resolves.toEqual({ allowed: true });
        await expect(
            audience.check({ node: node(), caller: agent, actionFamily: 'services' }),
        ).resolves.toMatchObject({ allowed: false });
        await expect(
            audience.check({
                node: node(),
                caller: { kind: 'agent', agentId: 'a-2', ownerUserId: 'someone' },
                actionFamily: 'view',
            }),
        ).resolves.toEqual({ allowed: false, asNotFound: true });
        expect(access.roleFor).not.toHaveBeenCalled();
    });

    it('answers owner-only in a context without the role derivation', async () => {
        const audience = new RoleBasedFleetLinkAudience();
        const owned = new OwnerOnlyFleetLinkAudience();
        for (const [caller, family] of [
            [user(OWNER), 'services'],
            [user('member-1'), 'view'],
        ] as const) {
            await expect(
                audience.check({ node: node(), caller, actionFamily: family }),
            ).resolves.toEqual(owned.check({ node: node(), caller, actionFamily: family }));
        }
    });
});
