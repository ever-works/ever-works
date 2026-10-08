import { createHash, randomBytes } from 'crypto';
import { FleetJob } from '../../entities/fleet-job.entity';
import { FleetNode } from '../../entities/fleet-node.entity';
import { FleetJobService } from '../fleet-job.service';
import { FleetService } from '../fleet.service';

/**
 * Node lifecycle (self-build slice AR) — the daemon version floor and the
 * pinned per-provider CLI versions, on the agent side.
 *
 * What is pinned:
 *   - the LEASE refuses a node whose reported daemon version is below
 *     `FLEET_MIN_NODE_VERSION` with `[]` (never null — null is the 401
 *     path, which a node reads as a revoked credential) and claims nothing;
 *   - it tells its caller WHY through `onUpgradeRequired`, which is how the
 *     API edge can answer `upgradeRequired: true`;
 *   - the floor fails OPEN on a version it cannot read, and the shipped
 *     default admits every daemon that exists;
 *   - a bad credential is STILL null, floor or not;
 *   - the HEARTBEAT is never refused for the floor; it carries the floor
 *     and the verdict, judged on the version THIS beat reports;
 *   - `cliVersions` follows the additive telemetry contract: absent leaves
 *     the stored list alone, an empty list replaces it, entries are
 *     sanitized and capped.
 */

const NODE = '11111111-1111-4111-8111-111111111111';
const JOB = '55555555-5555-4555-8555-555555555555';
const USER = 'user-1';
const sha256Hex = (value: string): string =>
    createHash('sha256').update(value, 'utf8').digest('hex');

function makeJob(): FleetJob {
    return {
        id: JOB,
        userId: USER,
        organizationId: null,
        nodeId: null,
        targetNodeId: null,
        kind: 'agent-task',
        status: 'queued',
        payload: { taskId: 'task-1', runId: 'run-1', agentId: 'agent-1' },
        requiredCapabilities: [],
        leaseExpiresAt: null,
        attempts: 0,
        maxAttempts: 3,
        idempotencyKey: null,
        result: null,
        error: null,
        queuedReason: null,
        cancelRequestedAt: null,
        startedAt: null,
        completedAt: null,
        createdAt: new Date('2026-09-05T10:00:00Z'),
        updatedAt: new Date('2026-09-05T10:00:00Z'),
        leaseGeneration: 1,
    } as FleetJob;
}

const ORIGINAL_FLOOR = process.env.FLEET_MIN_NODE_VERSION;

afterEach(() => {
    if (ORIGINAL_FLOOR === undefined) delete process.env.FLEET_MIN_NODE_VERSION;
    else process.env.FLEET_MIN_NODE_VERSION = ORIGINAL_FLOOR;
});

describe('FleetJobService — the daemon version floor on the lease path (slice AR)', () => {
    const secret = randomBytes(24).toString('base64url');
    let job: FleetJob;
    let jobs: Record<string, jest.Mock>;
    let version: string | null;

    const build = () =>
        new FleetJobService(
            jobs as never,
            {
                findById: jest.fn(async (id: string) =>
                    id === NODE
                        ? {
                              id: NODE,
                              userId: USER,
                              status: 'online',
                              enrollmentTokenHash: sha256Hex(secret),
                              capabilities: ['workspace'],
                              version,
                          }
                        : null,
                ),
            } as never,
            { findForOwnedAgent: jest.fn(async () => null) } as never,
        );

    beforeEach(() => {
        job = makeJob();
        version = '0.2.0';
        jobs = {
            findById: jest.fn(async (id: string) => (id === job.id ? job : null)),
            findQueuedForNode: jest.fn(async () => [job]),
            claim: jest.fn(async (_id: string, patch: Partial<FleetJob>) => {
                Object.assign(job, patch);
                return true;
            }),
            findExpiredLeases: jest.fn(async () => []),
            findQueuedOlderThan: jest.fn(async () => []),
        };
    });

    it('admits every shipped daemon under the default floor — introducing it bricks nobody', async () => {
        delete process.env.FLEET_MIN_NODE_VERSION;
        for (const shipped of ['0.1.0', '0.2.0']) {
            job = makeJob();
            version = shipped;
            const onUpgradeRequired = jest.fn();
            const leased = await build().lease({ nodeId: NODE, secret, max: 1, onUpgradeRequired });
            expect(leased).toHaveLength(1);
            expect(onUpgradeRequired).not.toHaveBeenCalled();
        }
    });

    it('refuses a below-floor daemon with [] (never null), claims nothing, and says why', async () => {
        process.env.FLEET_MIN_NODE_VERSION = '0.3.0';
        const onUpgradeRequired = jest.fn();

        const leased = await build().lease({ nodeId: NODE, secret, max: 1, onUpgradeRequired });

        expect(leased).toEqual([]);
        expect(jobs.claim).not.toHaveBeenCalled();
        expect(jobs.findQueuedForNode).not.toHaveBeenCalled();
        expect(job.status).toBe('queued');
        expect(onUpgradeRequired).toHaveBeenCalledWith({
            minNodeVersion: '0.3.0',
            reportedVersion: '0.2.0',
        });
    });

    it('leases again the moment the node reports a version at the floor', async () => {
        process.env.FLEET_MIN_NODE_VERSION = '0.3.0';
        version = '0.3.0';
        const onUpgradeRequired = jest.fn();
        const leased = await build().lease({ nodeId: NODE, secret, max: 1, onUpgradeRequired });
        expect(leased).toHaveLength(1);
        expect(onUpgradeRequired).not.toHaveBeenCalled();
    });

    it('fails OPEN on a version it cannot read (a dev build, a daemon that never reported one)', async () => {
        process.env.FLEET_MIN_NODE_VERSION = '9.0.0';
        for (const unreadable of [null, 'dev']) {
            job = makeJob();
            version = unreadable;
            const leased = await build().lease({ nodeId: NODE, secret, max: 1 });
            expect(leased).toHaveLength(1);
        }
    });

    it('a bad credential is STILL null below the floor — the two answers never merge', async () => {
        process.env.FLEET_MIN_NODE_VERSION = '0.3.0';
        const onUpgradeRequired = jest.fn();
        const leased = await build().lease({
            nodeId: NODE,
            secret: 'wrong-secret-wrong-secret',
            onUpgradeRequired,
        });
        expect(leased).toBeNull();
        // Saying "upgrade required" to an unauthenticated caller would
        // confirm the node id exists.
        expect(onUpgradeRequired).not.toHaveBeenCalled();
    });

    it('a throwing listener can never turn the refusal into a failed poll', async () => {
        process.env.FLEET_MIN_NODE_VERSION = '0.3.0';
        const leased = await build().lease({
            nodeId: NODE,
            secret,
            onUpgradeRequired: () => {
                throw new Error('listener bug');
            },
        });
        expect(leased).toEqual([]);
    });
});

const SECRET = 'a'.repeat(43);

const node = (overrides: Partial<FleetNode> = {}): FleetNode =>
    ({
        id: NODE,
        userId: USER,
        organizationId: null,
        name: 'office pc',
        kind: 'node',
        status: 'online',
        enrollmentTokenHash: sha256Hex(SECRET),
        lastHeartbeatAt: new Date(),
        capabilities: [],
        capabilitiesPinned: false,
        platform: 'win32/x64',
        version: '0.2.0',
        cliVersion: null,
        cliVersions: null,
        diskFreeBytes: null,
        modelIdentity: null,
        dailyCostCeilingCents: null,
        dailyCostTrippedOn: null,
        previousCredentialHash: null,
        previousCredentialExpiresAt: null,
        rotationRequestedAt: null,
        rotationRequestedByUserId: null,
        createdAt: new Date(),
        ...overrides,
    }) as FleetNode;

describe('FleetService — node lifecycle on the heartbeat (slice AR)', () => {
    let repository: { findById: jest.Mock; update: jest.Mock };

    beforeEach(() => {
        repository = {
            findById: jest.fn(async () => node()),
            update: jest.fn(async () => undefined),
        };
    });

    const build = () => new FleetService(repository as never);

    it('accepts a below-floor beat and says so — liveness is never gated on the floor', async () => {
        process.env.FLEET_MIN_NODE_VERSION = '0.3.0';
        const result = await build().heartbeat(NODE, SECRET, { version: '0.2.0' });

        expect(result).not.toBeNull();
        expect(repository.update).toHaveBeenCalledTimes(1);
        expect(result?.minNodeVersion).toBe('0.3.0');
        expect(result?.upgradeRequired).toBe(true);
        expect(result?.node.upgradeRequired).toBe(true);
        expect(result?.node.minNodeVersion).toBe('0.3.0');
    });

    it('judges the version THIS beat reports, so an upgraded daemon is cleared on its first beat', async () => {
        process.env.FLEET_MIN_NODE_VERSION = '0.3.0';
        // The row still says 0.2.0; the restarted daemon reports 0.3.1.
        const result = await build().heartbeat(NODE, SECRET, { version: '0.3.1' });
        expect(result?.upgradeRequired).toBe(false);
    });

    it('carries the default floor when none is configured', async () => {
        delete process.env.FLEET_MIN_NODE_VERSION;
        const result = await build().heartbeat(NODE, SECRET, {});
        expect(result?.minNodeVersion).toBe('0.1.0');
        expect(result?.upgradeRequired).toBe(false);
    });

    it('stores the pinned CLI versions, sanitized, deduplicated and capped', async () => {
        await build().heartbeat(NODE, SECRET, {
            cliVersions: [
                ' claude-code 2.1.3 ',
                'claude-code 2.1.3',
                `codex\u0000 0.48.0`,
                '',
                7 as unknown as string,
                'x'.repeat(200),
                ...Array.from({ length: 10 }, (_, index) => `extra-${index} 1.0.0`),
            ],
        });
        const patch = repository.update.mock.calls[0][1] as Partial<FleetNode>;
        expect(patch.cliVersions?.slice(0, 3)).toEqual([
            'claude-code 2.1.3',
            'codex  0.48.0',
            'x'.repeat(64),
        ]);
        expect(patch.cliVersions).toHaveLength(8);
    });

    it('leaves the stored list alone when a beat says nothing (an older daemon)', async () => {
        repository.findById.mockResolvedValue(node({ cliVersions: ['claude-code 2.1.3'] }));
        const result = await build().heartbeat(NODE, SECRET, { version: '0.2.0' });
        const patch = repository.update.mock.calls[0][1] as Partial<FleetNode>;
        expect(patch).not.toHaveProperty('cliVersions');
        expect(result?.node.cliVersions).toEqual(['claude-code 2.1.3']);
    });

    it('replaces it with an EMPTY list — "nothing is pinned any more" is a report', async () => {
        repository.findById.mockResolvedValue(node({ cliVersions: ['claude-code 2.1.3'] }));
        await build().heartbeat(NODE, SECRET, { cliVersions: [] });
        const patch = repository.update.mock.calls[0][1] as Partial<FleetNode>;
        expect(patch.cliVersions).toEqual([]);
    });
});
