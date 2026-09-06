import {
    ConflictException,
    UnauthorizedException,
    UnprocessableEntityException,
} from '@nestjs/common';
import type { FleetJobView } from '@ever-works/contracts';
import { FLEET_JOB_STALE_LEASE_REASON } from '@ever-works/contracts';
import { FleetJobsController } from './fleet-jobs.controller';
import { FleetRunSecretsError, FleetRunSecretsService } from './fleet-run-secrets.service';
import { FleetJobStaleLeaseError } from '@ever-works/agent/fleet';
import type { FleetJobService } from '@ever-works/agent/fleet';

/**
 * The node work channel.
 *
 * The property under test at this layer is the EDGE contract, not the
 * protocol (that lives in `fleet-job.service.spec.ts`): every path the
 * service declines must become ONE undifferentiated 401. A
 * differentiated error here would let anyone holding a random uuid
 * enumerate which nodes and which jobs exist.
 *
 * The distinction that must survive is `null` (refused) vs `[]` (a valid
 * node with nothing to do) — collapsing those would either leak or make
 * a healthy idle fleet look broken.
 */

const NODE_ID = '11111111-1111-4111-8111-111111111111';
const JOB_ID = '22222222-2222-4222-8222-222222222222';
const SECRET = 'a'.repeat(43);
/** A repository registry row id (run secrets, slice Y). */
const ROW_ID = '33333333-3333-4333-8333-333333333333';
/** The claim identity every heartbeat/complete body must carry (suspend-safe leases). */
const GENERATION = 3;
// Frozen: `jobView()` is called on both sides of several assertions, and a
// fresh `new Date()` per call would make them differ by a millisecond.
const LEASE_EXPIRES_AT = '2026-07-26T00:00:00.000Z';

function jobView(overrides: Partial<FleetJobView> = {}): FleetJobView {
    return {
        id: JOB_ID,
        kind: 'acceptance-checks',
        status: 'leased',
        nodeId: NODE_ID,
        requiredCapabilities: [],
        payload: null,
        leaseExpiresAt: LEASE_EXPIRES_AT,
        attempts: 1,
        maxAttempts: 3,
        createdAt: null,
        startedAt: null,
        completedAt: null,
        ...overrides,
    };
}

function makeController(
    service: Partial<FleetJobService>,
    runSecrets: Partial<FleetRunSecretsService> = { resolve: jest.fn(async () => null) },
): FleetJobsController {
    return new FleetJobsController(
        service as FleetJobService,
        runSecrets as FleetRunSecretsService,
    );
}

describe('FleetJobsController', () => {
    describe('POST /api/fleet/jobs/lease', () => {
        it('returns the claimed jobs', async () => {
            const controller = makeController({
                lease: jest.fn(async () => [jobView()]),
            });
            await expect(controller.lease({ nodeId: NODE_ID, secret: SECRET })).resolves.toEqual({
                jobs: [jobView()],
            });
        });

        it('returns an EMPTY list — not a 401 — for a valid node with no work', async () => {
            const controller = makeController({ lease: jest.fn(async () => []) });
            await expect(controller.lease({ nodeId: NODE_ID, secret: SECRET })).resolves.toEqual({
                jobs: [],
            });
        });

        it('maps a refused credential to one undifferentiated 401', async () => {
            const controller = makeController({ lease: jest.fn(async () => null) });
            await expect(
                controller.lease({ nodeId: NODE_ID, secret: SECRET }),
            ).rejects.toBeInstanceOf(UnauthorizedException);
        });

        it('forwards only the knobs the node actually supplied', async () => {
            const lease = jest.fn(async () => []);
            const controller = makeController({ lease });
            await controller.lease({ nodeId: NODE_ID, secret: SECRET });
            expect(lease).toHaveBeenCalledWith({ nodeId: NODE_ID, secret: SECRET });

            await controller.lease({
                nodeId: NODE_ID,
                secret: SECRET,
                max: 3,
                leaseTtlSec: 120,
                capabilities: ['workspace'],
            });
            expect(lease).toHaveBeenLastCalledWith({
                nodeId: NODE_ID,
                secret: SECRET,
                max: 3,
                leaseTtlSec: 120,
                capabilities: ['workspace'],
            });
        });
    });

    describe('POST /api/fleet/jobs/:id/heartbeat', () => {
        it('returns the extended job', async () => {
            const controller = makeController({
                heartbeatJob: jest.fn(async () => jobView({ status: 'running' })),
            });
            const result = await controller.heartbeat(JOB_ID, {
                nodeId: NODE_ID,
                secret: SECRET,
                leaseGeneration: GENERATION,
            });
            expect(result).toEqual({ ok: true, job: jobView({ status: 'running' }) });
        });

        it('maps a foreign or finished job to the SAME 401 as a bad credential', async () => {
            const controller = makeController({ heartbeatJob: jest.fn(async () => null) });
            await expect(
                controller.heartbeat(JOB_ID, {
                    nodeId: NODE_ID,
                    secret: SECRET,
                    leaseGeneration: GENERATION,
                }),
            ).rejects.toBeInstanceOf(UnauthorizedException);
        });

        it('threads the requested lease extension and the lease generation through', async () => {
            const heartbeatJob = jest.fn(async () => jobView());
            const controller = makeController({ heartbeatJob });
            await controller.heartbeat(JOB_ID, {
                nodeId: NODE_ID,
                secret: SECRET,
                leaseTtlSec: 90,
                leaseGeneration: GENERATION,
            });
            expect(heartbeatJob).toHaveBeenCalledWith(NODE_ID, SECRET, JOB_ID, 90, GENERATION);
        });

        it('surfaces a stale generation as 409 with the stable stale-lease reason', async () => {
            const controller = makeController({
                heartbeatJob: jest.fn(async () => {
                    throw new FleetJobStaleLeaseError();
                }),
            });
            const error: unknown = await controller
                .heartbeat(JOB_ID, { nodeId: NODE_ID, secret: SECRET, leaseGeneration: 1 })
                .catch((e: unknown) => e);
            expect(error).toBeInstanceOf(ConflictException);
            expect((error as ConflictException).getStatus()).toBe(409);
            expect((error as ConflictException).getResponse()).toMatchObject({
                statusCode: 409,
                reason: FLEET_JOB_STALE_LEASE_REASON,
            });
        });
    });

    describe('POST /api/fleet/jobs/:id/complete', () => {
        it('records a success with its result', async () => {
            const completeJob = jest.fn(async () => jobView({ status: 'done' }));
            const controller = makeController({ completeJob });
            const result = await controller.complete(JOB_ID, {
                nodeId: NODE_ID,
                secret: SECRET,
                success: true,
                result: { gateStatus: 'green' },
                leaseGeneration: GENERATION,
            });
            expect(result.job.status).toBe('done');
            expect(completeJob).toHaveBeenCalledWith(
                expect.objectContaining({
                    jobId: JOB_ID,
                    success: true,
                    result: { gateStatus: 'green' },
                    error: null,
                    leaseGeneration: GENERATION,
                }),
            );
        });

        it('records a failure with its error', async () => {
            const completeJob = jest.fn(async () => jobView({ status: 'failed' }));
            const controller = makeController({ completeJob });
            await controller.complete(JOB_ID, {
                nodeId: NODE_ID,
                secret: SECRET,
                success: false,
                error: 'exit 1',
                leaseGeneration: GENERATION,
            });
            expect(completeJob).toHaveBeenCalledWith(
                expect.objectContaining({
                    success: false,
                    error: 'exit 1',
                    result: null,
                    leaseGeneration: GENERATION,
                }),
            );
        });

        it('maps a replayed or foreign completion to the same 401', async () => {
            const controller = makeController({ completeJob: jest.fn(async () => null) });
            await expect(
                controller.complete(JOB_ID, {
                    nodeId: NODE_ID,
                    secret: SECRET,
                    success: true,
                    leaseGeneration: GENERATION,
                }),
            ).rejects.toBeInstanceOf(UnauthorizedException);
        });

        it('surfaces a stale generation as 409 with the stable stale-lease reason', async () => {
            const controller = makeController({
                completeJob: jest.fn(async () => {
                    throw new FleetJobStaleLeaseError();
                }),
            });
            const error: unknown = await controller
                .complete(JOB_ID, {
                    nodeId: NODE_ID,
                    secret: SECRET,
                    success: true,
                    leaseGeneration: 1,
                })
                .catch((e: unknown) => e);
            expect(error).toBeInstanceOf(ConflictException);
            expect((error as ConflictException).getStatus()).toBe(409);
            expect((error as ConflictException).getResponse()).toMatchObject({
                statusCode: 409,
                reason: FLEET_JOB_STALE_LEASE_REASON,
            });
        });
    });

    it('never varies the 401 message across endpoints or failure causes', async () => {
        const controller = makeController({
            lease: jest.fn(async () => null),
            heartbeatJob: jest.fn(async () => null),
            completeJob: jest.fn(async () => null),
        });

        const messages: string[] = [];
        for (const call of [
            () => controller.lease({ nodeId: NODE_ID, secret: SECRET }),
            () =>
                controller.heartbeat(JOB_ID, {
                    nodeId: NODE_ID,
                    secret: SECRET,
                    leaseGeneration: GENERATION,
                }),
            () =>
                controller.complete(JOB_ID, {
                    nodeId: NODE_ID,
                    secret: SECRET,
                    success: true,
                    leaseGeneration: GENERATION,
                }),
            // Run secrets (slice Y) is the FOURTH route on this channel and
            // must not become the one that says something different.
            () =>
                controller.envFiles(JOB_ID, {
                    nodeId: NODE_ID,
                    secret: SECRET,
                    leaseGeneration: GENERATION,
                    refs: [{ repoConnectionId: ROW_ID, paths: ['.env'] }],
                }),
        ]) {
            await call().catch((error: Error) => messages.push(error.message));
        }

        expect(messages).toHaveLength(4);
        expect(new Set(messages).size).toBe(1);
    });

    /**
     * Run secrets (self-build slice Y, EW-781) — the only route on this
     * channel that returns a decrypted secret. It keeps the channel's two
     * existing answers (one 401, one 409 stale-lease) and adds exactly one
     * of its own: a 422 carrying a STABLE reason token, which is reachable
     * only by the authenticated holder of an active job.
     */
    describe('POST /api/fleet/jobs/:id/env-files', () => {
        const body = {
            nodeId: NODE_ID,
            secret: SECRET,
            leaseGeneration: GENERATION,
            refs: [{ repoConnectionId: ROW_ID, paths: ['apps/api/.env'] }],
        };

        it('returns the resolved files and forwards the claim as the node sent it', async () => {
            const resolve = jest.fn(async () => ({
                files: [{ repoConnectionId: ROW_ID, path: 'apps/api/.env', content: 'A=1' }],
            }));
            const controller = makeController({}, { resolve });
            await expect(controller.envFiles(JOB_ID, body)).resolves.toEqual({
                files: [{ repoConnectionId: ROW_ID, path: 'apps/api/.env', content: 'A=1' }],
            });
            expect(resolve).toHaveBeenCalledWith({
                nodeId: NODE_ID,
                secret: SECRET,
                jobId: JOB_ID,
                leaseGeneration: GENERATION,
                refs: body.refs,
            });
        });

        it('collapses a refused claim to the SAME 401 as every other route', async () => {
            const controller = makeController({}, { resolve: jest.fn(async () => null) });
            await expect(controller.envFiles(JOB_ID, body)).rejects.toBeInstanceOf(
                UnauthorizedException,
            );
        });

        it('answers 422 with the stable reason token, and nothing else', async () => {
            const controller = makeController(
                {},
                {
                    resolve: jest.fn(async () => {
                        throw new FleetRunSecretsError('run-secrets-unresolved');
                    }),
                },
            );
            const error = await controller.envFiles(JOB_ID, body).catch((e: unknown) => e);
            expect(error).toBeInstanceOf(UnprocessableEntityException);
            expect((error as UnprocessableEntityException).getStatus()).toBe(422);
            expect((error as UnprocessableEntityException).getResponse()).toMatchObject({
                reason: 'run-secrets-unresolved',
            });
        });

        it('lets a stale lease surface as the channel-wide 409, not as a 422', async () => {
            const controller = makeController(
                {},
                {
                    resolve: jest.fn(async () => {
                        throw new FleetJobStaleLeaseError();
                    }),
                },
            );
            const error = await controller.envFiles(JOB_ID, body).catch((e: unknown) => e);
            expect(error).toBeInstanceOf(ConflictException);
            expect((error as ConflictException).getResponse()).toMatchObject({
                reason: FLEET_JOB_STALE_LEASE_REASON,
            });
        });
    });
});
