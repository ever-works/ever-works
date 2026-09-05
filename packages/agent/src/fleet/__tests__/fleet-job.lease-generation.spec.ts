import { ConflictException } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { FLEET_JOB_STALE_LEASE_REASON } from '@ever-works/contracts';
import { FleetJobCompletedEvent, FleetJobLeasedEvent } from '../../events/fleet-job.events';
import { FleetJob } from '../../entities/fleet-job.entity';
import { FleetJobService, FleetJobStaleLeaseError } from '../fleet-job.service';

/**
 * Suspend-safe leases (self-build program note §6, finding R7).
 *
 * The defect: a desk PC sleeps mid-run, its lease lapses, the job is
 * reclaimed and leased AGAIN — to another machine, or to the same one
 * once it wakes and polls — while the first model run is still going.
 * Before generations, that first run's heartbeat and completion matched
 * the row on `nodeId` alone, so on the same-node re-lease it could renew
 * and finalize a claim it never held: status, result, branch, PR.
 *
 * What is pinned here is the CLAIM identity: every lease mints one, every
 * renew/complete must echo the current one, and a stale echo is refused
 * with the ONE differentiated error in this channel — without touching
 * the row and without emitting an event. The store below honours the
 * generation in the same conditional way the real WHERE clauses do,
 * because that predicate IS the guarantee.
 */

const NODE_A = '11111111-1111-4111-8111-111111111111';
const NODE_B = '22222222-2222-4222-8222-222222222222';
const USER = 'owner-1';
const sha256Hex = (value: string): string =>
    createHash('sha256').update(value, 'utf8').digest('hex');

type Row = FleetJob & { leaseGeneration: number };

function activeMatch(row: Row, id: string, nodeId: string, generation: number): boolean {
    return (
        row.id === id &&
        row.nodeId === nodeId &&
        row.leaseGeneration === generation &&
        (row.status === 'leased' || row.status === 'running')
    );
}

describe('FleetJobService — lease generations', () => {
    const secretA = randomBytes(24).toString('base64url');
    const secretB = randomBytes(24).toString('base64url');
    let rows: Row[];
    let jobs: Record<string, jest.Mock>;
    let emitter: { emit: jest.Mock };
    let service: FleetJobService;

    const node = (id: string, secret: string) => ({
        id,
        userId: USER,
        status: 'online',
        enrollmentTokenHash: sha256Hex(secret),
        capabilities: [],
    });

    beforeEach(() => {
        rows = [];
        jobs = {
            create: jest.fn(async (data: Record<string, unknown>) => {
                const row = {
                    id: `job-${rows.length + 1}`,
                    status: 'queued',
                    nodeId: null,
                    attempts: 0,
                    maxAttempts: 3,
                    leaseGeneration: 0,
                    requiredCapabilities: [],
                    result: null,
                    error: null,
                    leaseExpiresAt: null,
                    createdAt: new Date(),
                    updatedAt: new Date(),
                    ...data,
                } as unknown as Row;
                rows.push(row);
                return row;
            }),
            findById: jest.fn(async (id: string) => rows.find((r) => r.id === id) ?? null),
            findByIdempotencyKey: jest.fn(async () => null),
            findQueuedForNode: jest.fn(async (userId: string, nodeId: string) =>
                rows.filter(
                    (r) =>
                        r.userId === userId &&
                        r.status === 'queued' &&
                        (!r.targetNodeId || r.targetNodeId === nodeId),
                ),
            ),
            claim: jest.fn(async (id: string, patch: Record<string, unknown>) => {
                const row = rows.find(
                    (r) =>
                        r.id === id &&
                        r.status === 'queued' &&
                        !r.cancelRequestedAt &&
                        r.leaseGeneration === (patch.leaseGeneration as number) - 1,
                );
                if (!row) return false;
                Object.assign(row, patch);
                return true;
            }),
            extendLease: jest.fn(
                async (
                    id: string,
                    nodeId: string,
                    leaseExpiresAt: Date,
                    startedAt: Date | undefined,
                    leaseGeneration: number,
                ) => {
                    const row = rows.find((r) => activeMatch(r, id, nodeId, leaseGeneration));
                    if (!row) return false;
                    row.status = 'running';
                    row.leaseExpiresAt = leaseExpiresAt;
                    if (startedAt) row.startedAt = startedAt;
                    return true;
                },
            ),
            complete: jest.fn(
                async (
                    id: string,
                    nodeId: string,
                    patch: Record<string, unknown>,
                    leaseGeneration: number,
                ) => {
                    const row = rows.find((r) => activeMatch(r, id, nodeId, leaseGeneration));
                    if (!row) return false;
                    Object.assign(row, patch, { leaseExpiresAt: null });
                    return true;
                },
            ),
            findExpiredLeases: jest.fn(async (cutoff: Date, _limit: number, userId?: string) =>
                rows.filter(
                    (r) =>
                        (!userId || r.userId === userId) &&
                        (r.status === 'leased' || r.status === 'running') &&
                        r.leaseExpiresAt instanceof Date &&
                        r.leaseExpiresAt.getTime() < cutoff.getTime(),
                ),
            ),
            reclaim: jest.fn(
                async (
                    id: string,
                    observed: {
                        status: string;
                        nodeId: string;
                        leaseExpiresAt: Date;
                        leaseGeneration: number;
                    },
                ) => {
                    const row = rows.find(
                        (r) =>
                            r.id === id &&
                            r.status === observed.status &&
                            r.nodeId === observed.nodeId &&
                            r.leaseGeneration === observed.leaseGeneration &&
                            r.leaseExpiresAt?.getTime() === observed.leaseExpiresAt.getTime(),
                    );
                    if (!row) return false;
                    Object.assign(row, { status: 'queued', nodeId: null, leaseExpiresAt: null });
                    return true;
                },
            ),
            failExhausted: jest.fn(async () => false),
        };
        emitter = { emit: jest.fn() };
        service = new FleetJobService(
            jobs as never,
            {
                findById: jest.fn(async (id: string) =>
                    id === NODE_A
                        ? node(NODE_A, secretA)
                        : id === NODE_B
                          ? node(NODE_B, secretB)
                          : null,
                ),
            } as never,
            { findForOwnedAgent: jest.fn(async () => null) } as never,
            emitter as never,
        );
    });

    const enqueue = () => service.enqueue({ userId: USER, kind: 'acceptance-checks' });
    const leaseAs = async (nodeId: string, secret: string) => {
        const leased = await service.lease({ nodeId, secret, max: 1 });
        expect(leased).not.toBeNull();
        return leased!;
    };
    const lapse = (row: Row) => {
        row.leaseExpiresAt = new Date(Date.now() - 1_000);
    };
    const completedEvents = () =>
        emitter.emit.mock.calls.filter(([name]) => name === FleetJobCompletedEvent.EVENT_NAME);

    describe('minting', () => {
        it('starts every job at generation 0 and mints 1 on the first lease', async () => {
            const queued = await enqueue();
            expect(queued.leaseGeneration).toBe(0);
            const [leased] = await leaseAs(NODE_A, secretA);
            expect(leased.leaseGeneration).toBe(1);
            expect(rows[0].leaseGeneration).toBe(1);
            expect(jobs.claim).toHaveBeenCalledWith(
                queued.id,
                expect.objectContaining({ leaseGeneration: 1 }),
            );
        });

        it('carries the generation on the leased event', async () => {
            await enqueue();
            await leaseAs(NODE_A, secretA);
            const [name, event] = emitter.emit.mock.calls[0];
            expect(name).toBe(FleetJobLeasedEvent.EVENT_NAME);
            expect(event.job.leaseGeneration).toBe(1);
        });

        it('mints a NEW generation when another node re-leases a lapsed claim', async () => {
            await enqueue();
            await leaseAs(NODE_A, secretA);
            lapse(rows[0]);
            const [relaesed] = await leaseAs(NODE_B, secretB);
            expect(relaesed.nodeId).toBe(NODE_B);
            expect(relaesed.leaseGeneration).toBe(2);
        });

        it('mints a NEW generation when the SAME node re-leases the job it slept through', async () => {
            // The case a nodeId guard cannot see: the holder and the
            // re-leaser are one machine.
            await enqueue();
            const [first] = await leaseAs(NODE_A, secretA);
            lapse(rows[0]);
            const [second] = await leaseAs(NODE_A, secretA);
            expect(second.id).toBe(first.id);
            expect(second.nodeId).toBe(NODE_A);
            expect(first.leaseGeneration).toBe(1);
            expect(second.leaseGeneration).toBe(2);
        });

        it('refuses to mint a generation the platform already issued (CAS on the observed value)', async () => {
            await enqueue();
            // Between the candidate read and the CAS, the row was leased and
            // lost by someone else: it is queued again but at generation 1.
            jobs.findQueuedForNode.mockImplementationOnce(async () => [
                { ...rows[0], leaseGeneration: 0 },
            ]);
            rows[0].leaseGeneration = 1;
            await expect(service.lease({ nodeId: NODE_A, secret: secretA })).resolves.toEqual([]);
            expect(rows[0].status).toBe('queued');
            expect(rows[0].leaseGeneration).toBe(1);
        });
    });

    describe('a stale holder on the SAME node (slept through its lease, re-leased it on wake)', () => {
        let jobId: string;
        let staleGeneration: number;
        let currentExpiry: Date;

        beforeEach(async () => {
            await enqueue();
            const [first] = await leaseAs(NODE_A, secretA);
            jobId = first.id;
            staleGeneration = first.leaseGeneration!;
            lapse(rows[0]);
            await leaseAs(NODE_A, secretA);
            currentExpiry = rows[0].leaseExpiresAt!;
            emitter.emit.mockClear();
        });

        it('cannot renew: heartbeat throws stale-lease and the row is untouched', async () => {
            await expect(
                service.heartbeatJob(NODE_A, secretA, jobId, 300, staleGeneration),
            ).rejects.toBeInstanceOf(FleetJobStaleLeaseError);
            expect(jobs.extendLease).not.toHaveBeenCalled();
            expect(rows[0]).toMatchObject({
                status: 'leased',
                nodeId: NODE_A,
                leaseGeneration: 2,
                leaseExpiresAt: currentExpiry,
            });
            expect(emitter.emit).not.toHaveBeenCalled();
        });

        it('cannot flip the status or land a result: complete throws stale-lease before any write', async () => {
            await expect(
                service.completeJob({
                    nodeId: NODE_A,
                    secret: secretA,
                    jobId,
                    success: true,
                    result: { branch: 'task/from-the-run-that-slept' },
                    leaseGeneration: staleGeneration,
                }),
            ).rejects.toBeInstanceOf(FleetJobStaleLeaseError);
            expect(jobs.complete).not.toHaveBeenCalled();
            expect(rows[0]).toMatchObject({
                status: 'leased',
                result: null,
                error: null,
                leaseGeneration: 2,
                leaseExpiresAt: currentExpiry,
            });
            // No completion event → the reconciler never opens a PR for it.
            expect(completedEvents()).toEqual([]);
        });

        it('cannot record a failure over the current claim either', async () => {
            await expect(
                service.completeJob({
                    nodeId: NODE_A,
                    secret: secretA,
                    jobId,
                    success: false,
                    error: 'lease-lapsed-while-suspended',
                    leaseGeneration: staleGeneration,
                }),
            ).rejects.toBeInstanceOf(FleetJobStaleLeaseError);
            expect(rows[0].status).toBe('leased');
            expect(rows[0].error).toBeNull();
        });

        it('while the CURRENT claim on the same node renews and completes normally', async () => {
            const beat = await service.heartbeatJob(NODE_A, secretA, jobId, 300, 2);
            expect(beat?.status).toBe('running');
            expect(beat?.leaseGeneration).toBe(2);
            const done = await service.completeJob({
                nodeId: NODE_A,
                secret: secretA,
                jobId,
                success: true,
                result: { branch: 'task/from-the-current-run' },
                leaseGeneration: 2,
            });
            expect(done?.status).toBe('done');
            expect(rows[0].result).toEqual({ branch: 'task/from-the-current-run' });
            const [, event] = completedEvents()[0];
            expect(event.job.leaseGeneration).toBe(2);
        });

        it('surfaces as a 409 with the stable machine-readable reason', async () => {
            const error = await service
                .heartbeatJob(NODE_A, secretA, jobId, 300, staleGeneration)
                .catch((e: unknown) => e);
            expect(error).toBeInstanceOf(ConflictException);
            expect((error as ConflictException).getStatus()).toBe(409);
            expect((error as ConflictException).getResponse()).toMatchObject({
                statusCode: 409,
                reason: FLEET_JOB_STALE_LEASE_REASON,
                message: expect.any(String),
            });
        });
    });

    describe('a stale holder on ANOTHER node (job re-leased elsewhere)', () => {
        it('is refused on the undifferentiated 401 path, and the new holder is never disturbed', async () => {
            await enqueue();
            const [first] = await leaseAs(NODE_A, secretA);
            lapse(rows[0]);
            await leaseAs(NODE_B, secretB);
            emitter.emit.mockClear();

            await expect(
                service.heartbeatJob(NODE_A, secretA, first.id, 300, first.leaseGeneration),
            ).resolves.toBeNull();
            await expect(
                service.completeJob({
                    nodeId: NODE_A,
                    secret: secretA,
                    jobId: first.id,
                    success: true,
                    result: { pushed: true },
                    leaseGeneration: first.leaseGeneration,
                }),
            ).resolves.toBeNull();
            expect(rows[0]).toMatchObject({
                status: 'leased',
                nodeId: NODE_B,
                leaseGeneration: 2,
                result: null,
            });
            expect(emitter.emit).not.toHaveBeenCalled();
        });
    });

    describe('fail-closed generation shapes', () => {
        let jobId: string;

        beforeEach(async () => {
            await enqueue();
            const [leased] = await leaseAs(NODE_A, secretA);
            jobId = leased.id;
            emitter.emit.mockClear();
        });

        it.each([
            ['missing (a node built before generations)', undefined],
            ['null', null],
            ['zero (the migration backfill / a pre-protocol lease)', 0],
            ['a negative number', -1],
            ['a non-integer', 1.5],
            ['a numeric string', '1'],
            ['a future generation', 2],
            ['NaN', Number.NaN],
        ])('refuses heartbeat and complete when the generation is %s', async (_label, value) => {
            await expect(
                service.heartbeatJob(NODE_A, secretA, jobId, 300, value),
            ).rejects.toBeInstanceOf(FleetJobStaleLeaseError);
            await expect(
                service.completeJob({
                    nodeId: NODE_A,
                    secret: secretA,
                    jobId,
                    success: true,
                    leaseGeneration: value,
                }),
            ).rejects.toBeInstanceOf(FleetJobStaleLeaseError);
            expect(jobs.extendLease).not.toHaveBeenCalled();
            expect(jobs.complete).not.toHaveBeenCalled();
            expect(rows[0].status).toBe('leased');
            expect(emitter.emit).not.toHaveBeenCalled();
        });

        it('keeps the status check ahead of the generation check (a terminal job is a 401, not a 409)', async () => {
            await service.completeJob({
                nodeId: NODE_A,
                secret: secretA,
                jobId,
                success: true,
                leaseGeneration: 1,
            });
            // Replay with a nonsense generation: the row is terminal, so
            // the answer is the undifferentiated null, revealing nothing.
            await expect(service.heartbeatJob(NODE_A, secretA, jobId, 300, 99)).resolves.toBeNull();
            await expect(
                service.completeJob({
                    nodeId: NODE_A,
                    secret: secretA,
                    jobId,
                    success: false,
                    leaseGeneration: 99,
                }),
            ).resolves.toBeNull();
        });

        it('keeps the holder check ahead of the generation check (a foreign node is a 401, not a 409)', async () => {
            await expect(
                service.heartbeatJob(NODE_B, secretB, jobId, 300, 999),
            ).resolves.toBeNull();
            await expect(
                service.completeJob({
                    nodeId: NODE_B,
                    secret: secretB,
                    jobId,
                    success: true,
                    leaseGeneration: 999,
                }),
            ).resolves.toBeNull();
        });
    });

    describe('reclaim', () => {
        it('pins the observed generation so a claim re-issued between scan and write is left alone', async () => {
            await enqueue();
            await leaseAs(NODE_A, secretA);
            lapse(rows[0]);

            const summary = await service.reclaimExpired(USER);
            expect(summary).toMatchObject({ requeued: 1, failed: 0 });
            expect(jobs.reclaim).toHaveBeenCalledWith(
                rows[0].id,
                expect.objectContaining({ nodeId: NODE_A, leaseGeneration: 1 }),
            );
            // The generation is NOT reset by reclaim: the next claim
            // advances it, which is what voids the lapsed run.
            expect(rows[0]).toMatchObject({ status: 'queued', nodeId: null, leaseGeneration: 1 });

            // A scan snapshot from before a re-lease matches nothing.
            const [again] = await leaseAs(NODE_A, secretA);
            expect(again.leaseGeneration).toBe(2);
            jobs.findExpiredLeases.mockResolvedValueOnce([
                {
                    ...rows[0],
                    leaseGeneration: 1,
                    leaseExpiresAt: new Date(Date.now() - 5_000),
                },
            ]);
            const stale = await service.reclaimExpired(USER);
            expect(stale).toMatchObject({ requeued: 0, failed: 0 });
            expect(rows[0]).toMatchObject({ status: 'leased', nodeId: NODE_A, leaseGeneration: 2 });
        });
    });
});
