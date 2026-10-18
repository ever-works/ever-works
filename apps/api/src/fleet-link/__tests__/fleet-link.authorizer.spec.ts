import { OwnerOnlyFleetLinkAudience } from '../fleet-link-audience';
import { FleetLinkAuthorizer, resolveFleetLinkRequirement } from '../fleet-link.authorizer';
import { FleetLinkRegistry } from '../fleet-link.registry';
import type { FleetLinkAudience, FleetLinkCaller, FleetLinkNodeFacts } from '../fleet-link.types';
import { hello, NODE_ID, OWNER, RecordingPort } from './link-test-kit';

/**
 * FleetLinkAuthorizer (FL-02, spec FR-23, CONTRACTS §2.1): existence → kill
 * switch → consent → family audience, first refusal wins, nothing reaches
 * the node on a refusal.
 */

const node = (overrides: Partial<FleetLinkNodeFacts> = {}): FleetLinkNodeFacts => ({
    id: NODE_ID,
    userId: OWNER,
    organizationId: 'org-1',
    name: 'build-01',
    kind: 'node',
    lastHeartbeatAt: new Date(),
    storedConsents: { work: true, attend: false, manage: true, usageScan: false },
    capabilities: [],
    workerState: 'idle',
    ...overrides,
});

const owner: FleetLinkCaller = { kind: 'user', userId: OWNER };
const stranger: FleetLinkCaller = { kind: 'user', userId: 'someone-else' };

function setup(options: { stopped?: boolean | Error; audience?: FleetLinkAudience } = {}) {
    const killSwitch = {
        isStopped: jest.fn(async () => {
            if (options.stopped instanceof Error) throw options.stopped;
            return options.stopped === true;
        }),
    };
    const registry = new FleetLinkRegistry();
    const authorizer = new FleetLinkAuthorizer(
        killSwitch as never,
        registry,
        options.audience ?? new OwnerOnlyFleetLinkAudience(),
    );
    return { authorizer, killSwitch, registry };
}

describe('resolveFleetLinkRequirement', () => {
    it('takes the family table, and a machine verb’s own consent and action family', () => {
        expect(resolveFleetLinkRequirement('logs', null)).toEqual({
            consent: 'manage',
            actionFamily: 'logs',
            stateChanging: false,
            target: null,
        });
        expect(resolveFleetLinkRequirement('command', null)).toMatchObject({
            stateChanging: true,
            actionFamily: 'commands',
        });
        expect(resolveFleetLinkRequirement('machine', 'health.now')).toMatchObject({
            consent: 'link',
            actionFamily: 'view',
            stateChanging: false,
        });
        expect(resolveFleetLinkRequirement('machine', 'services.action')).toMatchObject({
            consent: 'manage',
            actionFamily: 'services',
            stateChanging: true,
        });
    });

    it('lets a caller narrow the consent but never widen it', () => {
        expect(resolveFleetLinkRequirement('session', null, { consent: 'work' }).consent).toBe(
            'work',
        );
        expect(resolveFleetLinkRequirement('session', null, { consent: 'manage' }).consent).toBe(
            'manage',
        );
        expect(resolveFleetLinkRequirement('logs', null, { consent: 'link' }).consent).toBe(
            'manage',
        );
        expect(
            resolveFleetLinkRequirement('machine', 'services.list', { consent: 'link' }).consent,
        ).toBe('manage');
        expect(
            resolveFleetLinkRequirement('logs', null, { target: '/var/log/syslog' }).target,
        ).toBe('/var/log/syslog');
    });
});

describe('FleetLinkAuthorizer', () => {
    it('answers a stranger not_found before anything else is read', async () => {
        const h = setup({ stopped: true });
        await expect(
            h.authorizer.authorize({ node: node(), caller: stranger, family: 'logs' }),
        ).rejects.toMatchObject({
            linkError: { code: 'not_found' },
        });
        expect(h.killSwitch.isStopped).not.toHaveBeenCalled();
    });

    it('refuses kill_switch before consent (order, FR-23)', async () => {
        const h = setup({ stopped: true });
        await expect(
            h.authorizer.authorize({
                node: node({ storedConsents: { work: true } }),
                caller: owner,
                family: 'logs',
            }),
        ).rejects.toMatchObject({
            linkError: { code: 'kill_switch', hint: 'clear it under Settings → Fleet' },
        });
    });

    it('reads an unreadable kill switch as on (fail-closed)', async () => {
        const h = setup({ stopped: new Error('db down') });
        await expect(
            h.authorizer.authorize({ node: node(), caller: owner, family: 'logs' }),
        ).rejects.toMatchObject({
            linkError: { code: 'kill_switch' },
        });
    });

    it('names the missing consent and the command to run (S4)', async () => {
        const h = setup();
        await expect(
            h.authorizer.authorize({
                node: node({
                    storedConsents: { work: true, attend: false, manage: false, usageScan: false },
                }),
                caller: owner,
                family: 'logs',
            }),
        ).rejects.toMatchObject({
            linkError: {
                code: 'consent_missing',
                hint: 'start the node with --manage on build-01',
                details: { family: 'logs', consent: 'manage' },
            },
        });
    });

    it('lets health.now through on a --work-only node (R-31)', async () => {
        const h = setup();
        await expect(
            h.authorizer.authorize({
                node: node({
                    storedConsents: { work: true, attend: false, manage: false, usageScan: false },
                }),
                caller: owner,
                family: 'machine',
                verb: 'health.now',
            }),
        ).resolves.toMatchObject({ consent: 'link', actionFamily: 'view' });
    });

    it('prefers the consents the live link presented over the stored ones', async () => {
        const h = setup();
        h.registry.accept({
            nodeId: NODE_ID,
            ownerUserId: OWNER,
            nodeName: 'build-01',
            nodeKind: 'node',
            hello: hello({
                consents: { work: true, attend: false, manage: false, usageScan: false },
            }),
            socket: new RecordingPort(),
        });
        await expect(
            h.authorizer.authorize({ node: node(), caller: owner, family: 'logs' }),
        ).rejects.toMatchObject({
            linkError: { code: 'consent_missing' },
        });
    });

    it('never infers manage for a daemon that never reported consents (U12)', async () => {
        const h = setup();
        await expect(
            h.authorizer.authorize({
                node: node({
                    storedConsents: null,
                    capabilities: ['managed'],
                    workerState: 'idle',
                }),
                caller: owner,
                family: 'logs',
            }),
        ).rejects.toMatchObject({ linkError: { code: 'consent_missing' } });
    });

    it('refuses consent_missing before asking the family audience (order, ACC-FL02-10)', async () => {
        const asked: string[] = [];
        const audience: FleetLinkAudience = {
            check: ({ actionFamily }) => {
                asked.push(actionFamily);
                return actionFamily === 'view'
                    ? { allowed: true }
                    : { allowed: false, hint: 'not you' };
            },
        };
        const h = setup({ audience });
        await expect(
            h.authorizer.authorize({
                node: node({
                    storedConsents: { work: true, attend: false, manage: false, usageScan: false },
                }),
                caller: owner,
                family: 'logs',
            }),
        ).rejects.toMatchObject({ linkError: { code: 'consent_missing' } });
        expect(asked).toEqual(['view']);
    });

    it('refuses permission_denied with who to ask when the family audience excludes the caller (S5)', async () => {
        const audience: FleetLinkAudience = {
            check: ({ actionFamily }) =>
                actionFamily === 'view'
                    ? { allowed: true }
                    : {
                          allowed: false,
                          hint: 'ask the owner of build-01 to allow org admins: services',
                      },
        };
        const h = setup({ audience });
        await expect(
            h.authorizer.authorize({
                node: node(),
                caller: { kind: 'user', userId: 'org-admin' },
                family: 'machine',
                verb: 'services.action',
            }),
        ).rejects.toMatchObject({
            linkError: {
                code: 'permission_denied',
                hint: 'ask the owner of build-01 to allow org admins: services',
            },
        });
    });

    it('admits the owner, the owner’s schedule and a system job; refuses an Agent until its gates exist', async () => {
        const h = setup();
        await expect(
            h.authorizer.authorize({ node: node(), caller: owner, family: 'logs' }),
        ).resolves.toBeDefined();
        await expect(
            h.authorizer.authorize({
                node: node(),
                caller: { kind: 'schedule', commandId: 'c-1', ownerUserId: OWNER },
                family: 'command',
            }),
        ).resolves.toMatchObject({ stateChanging: true });
        await expect(
            h.authorizer.authorize({
                node: node(),
                caller: { kind: 'system', job: 'drain-all' },
                family: 'session',
            }),
        ).resolves.toBeDefined();
        await expect(
            h.authorizer.authorize({
                node: node(),
                caller: { kind: 'agent', agentId: 'a-1', ownerUserId: OWNER },
                family: 'command',
            }),
        ).rejects.toMatchObject({ linkError: { code: 'permission_denied' } });
    });
});
