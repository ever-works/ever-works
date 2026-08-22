import { BadRequestException } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { FleetJobService } from '../fleet-job.service';
import { FleetJobRepository } from '../fleet-job.repository';
import { FleetNodeRepository } from '../fleet-node.repository';
import { FleetJob } from '../../entities/fleet-job.entity';
import { FleetNode } from '../../entities/fleet-node.entity';
import { FleetAgentNodeAffinity } from '../../entities/fleet-agent-node-affinity.entity';
import { FleetAgentNodeAffinityRepository } from '../fleet-agent-node-affinity.repository';

/**
 * The fleet lease protocol.
 *
 * The properties under test are the ones that decide whether an enrolled
 * machine can be trusted with real work:
 *   - exactly ONE node wins a contested job (atomic CAS claim);
 *   - a node only ever sees work it is capable of running;
 *   - a lapsed claim comes back without the dead node's cooperation;
 *   - every credential path fails CLOSED, indistinguishably.
 *
 * The repositories are backed by a tiny in-memory store whose `update`
 * honours the same conditional-WHERE semantics TypeORM applies, because
 * that condition IS the concurrency guarantee — a fake that ignored it
 * would make the race test meaningless.
 */

const sha256Hex = (value: string): string =>
    createHash('sha256').update(value, 'utf8').digest('hex');

interface Stores {
    nodes: FleetNode[];
    jobs: FleetJob[];
    affinities: FleetAgentNodeAffinity[];
}

/** Conditional update over an in-memory table, mirroring TypeORM's semantics. */
function applyUpdate<T extends { id: string }>(
    rows: T[],
    where: Partial<T> & { id?: string },
    patch: Partial<T>,
): number {
    let affected = 0;
    for (const row of rows) {
        const matches = Object.entries(where).every(([key, expected]) => {
            const actual = (row as Record<string, unknown>)[key];
            if (expected && typeof expected === 'object' && '_in' in (expected as object)) {
                return ((expected as { _in: unknown[] })._in ?? []).includes(actual);
            }
            return actual === expected;
        });
        if (!matches) continue;
        Object.assign(row, patch);
        affected += 1;
    }
    return affected;
}

function makeRepos(stores: Stores): {
    jobs: FleetJobRepository;
    nodes: FleetNodeRepository;
    affinities: FleetAgentNodeAffinityRepository;
} {
    const jobs = {
        create: jest.fn(async (data: Record<string, unknown>) => {
            const row = {
                id: `job-${stores.jobs.length + 1}`,
                status: 'queued',
                attempts: 0,
                maxAttempts: 3,
                requiredCapabilities: [],
                createdAt: new Date(),
                updatedAt: new Date(),
                ...data,
            } as unknown as FleetJob;
            stores.jobs.push(row);
            return row;
        }),
        findById: jest.fn(async (id: string) => stores.jobs.find((j) => j.id === id) ?? null),
        findByIdempotencyKey: jest.fn(
            async (key: string) => stores.jobs.find((j) => j.idempotencyKey === key) ?? null,
        ),
        findQueuedForUser: jest.fn(async (userId: string, limit: number) =>
            stores.jobs.filter((j) => j.userId === userId && j.status === 'queued').slice(0, limit),
        ),
        findQueuedForNode: jest.fn(async (userId: string, nodeId: string, limit: number) =>
            stores.jobs
                .filter(
                    (job) =>
                        job.userId === userId &&
                        job.status === 'queued' &&
                        (!job.targetNodeId || job.targetNodeId === nodeId),
                )
                .slice(0, limit),
        ),
        claim: jest.fn(async (id: string, patch: Record<string, unknown>) => {
            // The real guarantee: the row must STILL be queued.
            return (
                applyUpdate(stores.jobs, { id, status: 'queued' } as never, patch as never) === 1
            );
        }),
        extendLease: jest.fn(
            async (id: string, nodeId: string, leaseExpiresAt: Date, startedAt?: Date) => {
                const row = stores.jobs.find(
                    (j) =>
                        j.id === id &&
                        j.nodeId === nodeId &&
                        (j.status === 'leased' || j.status === 'running'),
                );
                if (!row) return false;
                row.status = 'running';
                row.leaseExpiresAt = leaseExpiresAt;
                if (startedAt) row.startedAt = startedAt;
                return true;
            },
        ),
        complete: jest.fn(async (id: string, nodeId: string, patch: Record<string, unknown>) => {
            const row = stores.jobs.find(
                (j) =>
                    j.id === id &&
                    j.nodeId === nodeId &&
                    (j.status === 'leased' || j.status === 'running'),
            );
            if (!row) return false;
            Object.assign(row, patch, { leaseExpiresAt: null });
            return true;
        }),
        findExpiredLeases: jest.fn(async (cutoff: Date, limit: number, userId?: string) =>
            stores.jobs
                .filter(
                    (j) =>
                        (!userId || j.userId === userId) &&
                        (j.status === 'leased' || j.status === 'running') &&
                        j.leaseExpiresAt !== null &&
                        j.leaseExpiresAt !== undefined &&
                        j.leaseExpiresAt.getTime() < cutoff.getTime(),
                )
                .slice(0, limit),
        ),
        reclaim: jest.fn(async (id: string, previousStatus: string) => {
            const row = stores.jobs.find((j) => j.id === id && j.status === previousStatus);
            if (!row) return false;
            row.status = 'queued';
            row.nodeId = null;
            row.leaseExpiresAt = null;
            return true;
        }),
        failExhausted: jest.fn(
            async (id: string, previousStatus: string, error: string, completedAt: Date) => {
                const row = stores.jobs.find((j) => j.id === id && j.status === previousStatus);
                if (!row) return false;
                row.status = 'failed';
                row.leaseExpiresAt = null;
                row.error = error;
                row.completedAt = completedAt;
                return true;
            },
        ),
        findActiveForUser: jest.fn(async (userId: string) =>
            stores.jobs.filter(
                (j) =>
                    j.userId === userId &&
                    (j.status === 'leased' || j.status === 'running') &&
                    Boolean(j.nodeId),
            ),
        ),
        findByUser: jest.fn(async (userId: string, limit: number) =>
            stores.jobs.filter((j) => j.userId === userId).slice(0, limit),
        ),
    } as unknown as FleetJobRepository;

    const nodes = {
        findById: jest.fn(async (id: string) => stores.nodes.find((n) => n.id === id) ?? null),
    } as unknown as FleetNodeRepository;

    const affinities = {
        findForAgent: jest.fn(
            async (userId: string, organizationId: string, agentId: string) =>
                stores.affinities.find(
                    (row) =>
                        row.userId === userId &&
                        row.organizationId === organizationId &&
                        row.agentId === agentId,
                ) ?? null,
        ),
    } as unknown as FleetAgentNodeAffinityRepository;

    return { jobs, nodes, affinities };
}

const NODE_A = '11111111-1111-4111-8111-111111111111';
const NODE_B = '22222222-2222-4222-8222-222222222222';
const ORGANIZATION = '33333333-3333-4333-8333-333333333333';
const AGENT = '44444444-4444-4444-8444-444444444444';

function enrolledNode(id: string, secret: string, overrides: Partial<FleetNode> = {}): FleetNode {
    return {
        id,
        userId: 'owner-1',
        name: `node-${id.slice(0, 4)}`,
        kind: 'node',
        status: 'online',
        enrollmentTokenHash: sha256Hex(secret),
        capabilities: ['workspace', 'git'],
        createdAt: new Date(),
        ...overrides,
    } as FleetNode;
}

describe('FleetJobService', () => {
    let stores: Stores;
    let service: FleetJobService;
    const secretA = randomBytes(32).toString('base64url');
    const secretB = randomBytes(32).toString('base64url');

    beforeEach(() => {
        stores = { nodes: [], jobs: [], affinities: [] };
        const repos = makeRepos(stores);
        service = new FleetJobService(repos.jobs, repos.nodes, repos.affinities);
    });

    describe('enqueue', () => {
        it('writes a queued, lease-able row', async () => {
            const view = await service.enqueue({
                userId: 'owner-1',
                kind: 'acceptance-checks',
                payload: { workspacePath: '/w', checks: [] },
                requiredCapabilities: ['workspace'],
            });
            expect(view.status).toBe('queued');
            expect(view.nodeId).toBeNull();
            expect(view.requiredCapabilities).toEqual(['workspace']);
        });

        it('reuses the row on an idempotency-key repeat instead of doubling the work', async () => {
            const first = await service.enqueue({
                userId: 'owner-1',
                kind: 'acceptance-checks',
                idempotencyKey: 'run:42',
            });
            const second = await service.enqueue({
                userId: 'owner-1',
                kind: 'acceptance-checks',
                idempotencyKey: 'run:42',
            });
            expect(second.id).toBe(first.id);
            expect(stores.jobs).toHaveLength(1);
        });

        it('refuses an unsupported kind rather than queuing work nothing can run', async () => {
            await expect(
                service.enqueue({ userId: 'owner-1', kind: 'nope' as never }),
            ).rejects.toBeInstanceOf(BadRequestException);
        });

        it('rejects an oversize payload instead of silently truncating it', async () => {
            await expect(
                service.enqueue({
                    userId: 'owner-1',
                    kind: 'acceptance-checks',
                    payload: { blob: 'x'.repeat(300_000) },
                }),
            ).rejects.toBeInstanceOf(BadRequestException);
        });

        it('snapshots the scoped Agent binding so a later change only affects future jobs', async () => {
            stores.affinities.push({
                id: '55555555-5555-4555-8555-555555555555',
                userId: 'owner-1',
                organizationId: ORGANIZATION,
                agentId: AGENT,
                nodeId: NODE_A,
            } as FleetAgentNodeAffinity);

            const first = await service.enqueue({
                userId: 'owner-1',
                organizationId: ORGANIZATION,
                kind: 'agent-task',
                payload: { taskId: 'task-1', agentId: AGENT },
            });
            stores.affinities[0].nodeId = NODE_B;
            const second = await service.enqueue({
                userId: 'owner-1',
                organizationId: ORGANIZATION,
                kind: 'agent-task',
                payload: { taskId: 'task-2', agentId: AGENT },
            });

            expect(first.targetNodeId).toBe(NODE_A);
            expect(stores.jobs[0].targetNodeId).toBe(NODE_A);
            expect(second.targetNodeId).toBe(NODE_B);
        });

        it('keeps non-agent and unbound jobs eligible for the existing owner-wide scheduler', async () => {
            const ordinary = await service.enqueue({
                userId: 'owner-1',
                organizationId: ORGANIZATION,
                kind: 'acceptance-checks',
            });
            const unbound = await service.enqueue({
                userId: 'owner-1',
                organizationId: ORGANIZATION,
                kind: 'agent-task',
                payload: { taskId: 'task-1', agentId: AGENT },
            });

            expect(ordinary.targetNodeId).toBeNull();
            expect(unbound.targetNodeId).toBeNull();
        });
    });

    describe('lease', () => {
        beforeEach(() => {
            stores.nodes.push(enrolledNode(NODE_A, secretA), enrolledNode(NODE_B, secretB));
        });

        it('claims a queued job and stamps the lease', async () => {
            await service.enqueue({ userId: 'owner-1', kind: 'acceptance-checks' });
            const leased = await service.lease({ nodeId: NODE_A, secret: secretA });
            expect(leased).toHaveLength(1);
            expect(leased?.[0].status).toBe('leased');
            expect(leased?.[0].nodeId).toBe(NODE_A);
            expect(leased?.[0].attempts).toBe(1);
            expect(leased?.[0].leaseExpiresAt).not.toBeNull();
        });

        it('gives a contested job to EXACTLY ONE of two racing nodes', async () => {
            await service.enqueue({ userId: 'owner-1', kind: 'acceptance-checks' });

            const [a, b] = await Promise.all([
                service.lease({ nodeId: NODE_A, secret: secretA }),
                service.lease({ nodeId: NODE_B, secret: secretB }),
            ]);

            const winners = [...(a ?? []), ...(b ?? [])];
            expect(winners).toHaveLength(1);
            // And the loser got an empty list, NOT an error: "no work" and
            // "you lost a race" are the same thing from a node's point of view.
            expect(a).not.toBeNull();
            expect(b).not.toBeNull();
        });

        it('never hands a node a job whose capability tags it does not advertise', async () => {
            await service.enqueue({
                userId: 'owner-1',
                kind: 'acceptance-checks',
                requiredCapabilities: ['docker'],
            });
            const leased = await service.lease({ nodeId: NODE_A, secret: secretA });
            expect(leased).toEqual([]);
        });

        it('lets a node narrow its own eligibility for one poll', async () => {
            await service.enqueue({
                userId: 'owner-1',
                kind: 'acceptance-checks',
                requiredCapabilities: ['git'],
            });
            // The node is capable of `git`, but advertises only `workspace`
            // right now (e.g. it is draining a capability).
            const leased = await service.lease({
                nodeId: NODE_A,
                secret: secretA,
                capabilities: ['workspace'],
            });
            expect(leased).toEqual([]);
        });

        it('honours the batch cap', async () => {
            for (let i = 0; i < 4; i += 1) {
                await service.enqueue({ userId: 'owner-1', kind: 'acceptance-checks' });
            }
            const leased = await service.lease({ nodeId: NODE_A, secret: secretA, max: 2 });
            expect(leased).toHaveLength(2);
        });

        it("never leases another owner's work", async () => {
            await service.enqueue({ userId: 'someone-else', kind: 'acceptance-checks' });
            const leased = await service.lease({ nodeId: NODE_A, secret: secretA });
            expect(leased).toEqual([]);
        });

        it('keeps a targeted job for its selected node even when another node has matching capabilities', async () => {
            await service.enqueue({
                userId: 'owner-1',
                kind: 'acceptance-checks',
                requiredCapabilities: ['workspace', 'git'],
            });
            (stores.jobs[0] as FleetJob & { targetNodeId: string | null }).targetNodeId = NODE_A;

            const wrongNode = await service.lease({ nodeId: NODE_B, secret: secretB });
            expect(wrongNode).toEqual([]);
            expect(stores.jobs[0].status).toBe('queued');

            const selectedNode = await service.lease({ nodeId: NODE_A, secret: secretA });
            expect(selectedNode).toHaveLength(1);
            expect(selectedNode?.[0].nodeId).toBe(NODE_A);
        });

        it("does not let another node's targeted backlog hide later eligible work", async () => {
            for (let index = 0; index < 6; index += 1) {
                await service.enqueue({ userId: 'owner-1', kind: 'acceptance-checks' });
                stores.jobs[index].targetNodeId = NODE_A;
            }
            const unbound = await service.enqueue({
                userId: 'owner-1',
                kind: 'acceptance-checks',
            });

            const leased = await service.lease({ nodeId: NODE_B, secret: secretB });

            expect(leased).toHaveLength(1);
            expect(leased?.[0].id).toBe(unbound.id);
        });

        it('reclaims lapsed claims inline, so a dead node does not freeze the queue', async () => {
            await service.enqueue({ userId: 'owner-1', kind: 'acceptance-checks' });
            await service.lease({ nodeId: NODE_A, secret: secretA });

            // Node A dies holding the claim; its lease lapses.
            stores.jobs[0].leaseExpiresAt = new Date(Date.now() - 1_000);

            const leasedByB = await service.lease({ nodeId: NODE_B, secret: secretB });
            expect(leasedByB).toHaveLength(1);
            expect(leasedByB?.[0].nodeId).toBe(NODE_B);
            expect(leasedByB?.[0].attempts).toBe(2);
        });
    });

    describe('lease auth — fail-closed and indistinguishable', () => {
        beforeEach(() => {
            stores.nodes.push(enrolledNode(NODE_A, secretA));
        });

        it.each([
            ['a wrong secret', NODE_A, randomBytes(32).toString('base64url')],
            ['a malformed node id', 'not-a-uuid', 'x'.repeat(40)],
            ['a too-short secret', NODE_A, 'short'],
            ['an unknown node', NODE_B, 'x'.repeat(40)],
        ])('returns null for %s', async (_label, nodeId, secret) => {
            await expect(service.lease({ nodeId, secret })).resolves.toBeNull();
        });

        it('refuses a DISABLED node — draining must stop new work immediately', async () => {
            stores.nodes[0].status = 'disabled';
            await service.enqueue({ userId: 'owner-1', kind: 'acceptance-checks' });
            await expect(service.lease({ nodeId: NODE_A, secret: secretA })).resolves.toBeNull();
        });

        it('refuses a still-ENROLLING node whose hash is a token, not a secret', async () => {
            stores.nodes[0].status = 'enrolling';
            await expect(service.lease({ nodeId: NODE_A, secret: secretA })).resolves.toBeNull();
        });
    });

    describe('job heartbeat', () => {
        beforeEach(() => {
            stores.nodes.push(enrolledNode(NODE_A, secretA), enrolledNode(NODE_B, secretB));
        });

        it('extends the lease and acknowledges the claim (leased → running)', async () => {
            await service.enqueue({ userId: 'owner-1', kind: 'acceptance-checks' });
            const leased = await service.lease({ nodeId: NODE_A, secret: secretA });
            const before = stores.jobs[0].leaseExpiresAt?.getTime() ?? 0;

            // Push the stored expiry back so any extension is unambiguous.
            stores.jobs[0].leaseExpiresAt = new Date(before - 60_000);

            const beat = await service.heartbeatJob(NODE_A, secretA, leased![0].id);
            expect(beat?.status).toBe('running');
            expect(new Date(beat!.leaseExpiresAt!).getTime()).toBeGreaterThan(before - 60_000);
            expect(beat?.startedAt).not.toBeNull();
        });

        it("refuses to extend another node's claim", async () => {
            await service.enqueue({ userId: 'owner-1', kind: 'acceptance-checks' });
            const leased = await service.lease({ nodeId: NODE_A, secret: secretA });
            await expect(service.heartbeatJob(NODE_B, secretB, leased![0].id)).resolves.toBeNull();
        });

        it('refuses to extend a job that is still queued', async () => {
            const queued = await service.enqueue({
                userId: 'owner-1',
                kind: 'acceptance-checks',
            });
            await expect(service.heartbeatJob(NODE_A, secretA, queued.id)).resolves.toBeNull();
        });
    });

    describe('complete', () => {
        beforeEach(() => {
            stores.nodes.push(enrolledNode(NODE_A, secretA), enrolledNode(NODE_B, secretB));
        });

        it('records success with the executor result', async () => {
            await service.enqueue({ userId: 'owner-1', kind: 'acceptance-checks' });
            const leased = await service.lease({ nodeId: NODE_A, secret: secretA });

            const done = await service.completeJob({
                nodeId: NODE_A,
                secret: secretA,
                jobId: leased![0].id,
                success: true,
                result: { gateStatus: 'green' },
            });

            expect(done?.status).toBe('done');
            expect(done?.completedAt).not.toBeNull();
            expect(done?.leaseExpiresAt).toBeNull();
        });

        it('records failure with the error, and does NOT auto-retry a real verdict', async () => {
            await service.enqueue({ userId: 'owner-1', kind: 'acceptance-checks' });
            const leased = await service.lease({ nodeId: NODE_A, secret: secretA });

            const failed = await service.completeJob({
                nodeId: NODE_A,
                secret: secretA,
                jobId: leased![0].id,
                success: false,
                error: 'check `pnpm build` exited 1',
            });

            expect(failed?.status).toBe('failed');
            expect(stores.jobs[0].error).toContain('pnpm build');
            // A reported red is a verdict, not a lost lease — re-running it
            // would turn a legitimate failure into an infinite retry.
            const requeued = await service.lease({ nodeId: NODE_B, secret: secretB });
            expect(requeued).toEqual([]);
        });

        it('is not replayable — completing twice matches zero rows', async () => {
            await service.enqueue({ userId: 'owner-1', kind: 'acceptance-checks' });
            const leased = await service.lease({ nodeId: NODE_A, secret: secretA });
            const input = {
                nodeId: NODE_A,
                secret: secretA,
                jobId: leased![0].id,
                success: true,
            };
            await expect(service.completeJob(input)).resolves.not.toBeNull();
            await expect(service.completeJob(input)).resolves.toBeNull();
        });

        it("refuses to complete another node's job", async () => {
            await service.enqueue({ userId: 'owner-1', kind: 'acceptance-checks' });
            const leased = await service.lease({ nodeId: NODE_A, secret: secretA });
            await expect(
                service.completeJob({
                    nodeId: NODE_B,
                    secret: secretB,
                    jobId: leased![0].id,
                    success: true,
                }),
            ).resolves.toBeNull();
        });
    });

    describe('reclaimExpired', () => {
        beforeEach(() => {
            stores.nodes.push(enrolledNode(NODE_A, secretA));
        });

        it('returns a lapsed claim to the pool while attempts remain', async () => {
            await service.enqueue({ userId: 'owner-1', kind: 'acceptance-checks' });
            await service.lease({ nodeId: NODE_A, secret: secretA });
            stores.jobs[0].leaseExpiresAt = new Date(Date.now() - 1_000);

            const summary = await service.reclaimExpired();
            expect(summary).toMatchObject({ requeued: 1, failed: 0 });
            expect(stores.jobs[0].status).toBe('queued');
            expect(stores.jobs[0].nodeId).toBeNull();
        });

        it('fails a claim that has burned its whole attempt budget', async () => {
            await service.enqueue({
                userId: 'owner-1',
                kind: 'acceptance-checks',
                maxAttempts: 1,
            });
            await service.lease({ nodeId: NODE_A, secret: secretA });
            stores.jobs[0].leaseExpiresAt = new Date(Date.now() - 1_000);

            const summary = await service.reclaimExpired();
            expect(summary).toMatchObject({ requeued: 0, failed: 1 });
            expect(stores.jobs[0].status).toBe('failed');
            expect(stores.jobs[0].error).toContain('attempt budget');
        });

        it('leaves a live claim alone', async () => {
            await service.enqueue({ userId: 'owner-1', kind: 'acceptance-checks' });
            await service.lease({ nodeId: NODE_A, secret: secretA });

            const summary = await service.reclaimExpired();
            expect(summary).toMatchObject({ requeued: 0, failed: 0 });
            expect(stores.jobs[0].status).toBe('leased');
        });
    });

    describe('loadByNodeForUser', () => {
        beforeEach(() => {
            stores.nodes.push(enrolledNode(NODE_A, secretA));
        });

        it('reports a node with no live claim as absent (the UI renders idle)', async () => {
            await expect(service.loadByNodeForUser('owner-1')).resolves.toEqual({});
        });

        it('counts live claims and names the current job', async () => {
            await service.enqueue({ userId: 'owner-1', kind: 'acceptance-checks' });
            await service.enqueue({ userId: 'owner-1', kind: 'acceptance-checks' });
            await service.lease({ nodeId: NODE_A, secret: secretA, max: 2 });

            const load = await service.loadByNodeForUser('owner-1');
            expect(load[NODE_A]).toMatchObject({
                activeJobCount: 2,
                currentJobKind: 'acceptance-checks',
            });
        });
    });
});
