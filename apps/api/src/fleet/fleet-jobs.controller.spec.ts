import { ConflictException, UnauthorizedException } from '@nestjs/common';
import type { FleetJobView } from '@ever-works/contracts';
import { FLEET_JOB_STALE_LEASE_REASON } from '@ever-works/contracts';
import { FleetJobsController } from './fleet-jobs.controller';
import { FleetJobStaleLeaseError } from '@ever-works/agent/fleet';
import type { FleetJobService, FleetRunCredentialService } from '@ever-works/agent/fleet';

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
    runCredentials: Partial<FleetRunCredentialService> = {},
): FleetJobsController {
    return new FleetJobsController(
        service as FleetJobService,
        runCredentials as FleetRunCredentialService,
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
        ]) {
            await call().catch((error: Error) => messages.push(error.message));
        }

        expect(messages).toHaveLength(3);
        expect(new Set(messages).size).toBe(1);
    });
});

/**
 * Self-build slice Z (EW-796) — the run-credential routes on the node
 * channel.
 *
 * Same edge contract as every other route here: the service decides, and
 * every refusal it returns becomes ONE undifferentiated 401. That matters
 * more on these routes than anywhere else, because the caller is asking
 * "may I have a credential for job X" — and a differentiated answer would
 * turn a valid node secret into a probe for which jobs exist, which are
 * active, and which have the bridge enabled.
 */
describe('FleetJobsController — MCP run credentials', () => {
    const body = { nodeId: NODE_ID, secret: SECRET };

    describe('POST /api/fleet/jobs/:id/mcp-credential', () => {
        it('returns the minted credential for the node holding the lease', async () => {
            const credential = {
                token: 'ew_run_0123456789abcdef',
                expiresAt: '2026-07-26T00:05:00.000Z',
                serverUrl: 'https://mcp.ever.works/mcp',
            };
            const mint = jest.fn(async () => credential);
            const controller = makeController({}, { mint });

            await expect(controller.mintMcpCredential(JOB_ID, body)).resolves.toEqual(credential);
            expect(mint).toHaveBeenCalledWith({
                nodeId: NODE_ID,
                secret: SECRET,
                jobId: JOB_ID,
            });
        });

        it('scopes the mint to the id in the PATH, never to one in the body', async () => {
            const mint = jest.fn(async () => null);
            const controller = makeController({}, { mint });

            await expect(
                controller.mintMcpCredential(JOB_ID, {
                    ...body,
                    // A body field the DTO does not declare cannot reach the
                    // service; this pins that the path param is the source.
                    jobId: 'someone-elses-job',
                } as never),
            ).rejects.toThrow(UnauthorizedException);
            expect(mint).toHaveBeenCalledWith(expect.objectContaining({ jobId: JOB_ID }));
        });

        it('collapses EVERY refusal to one undifferentiated 401', async () => {
            // The service returns `null` for a foreign node, a missing job, a
            // settled job, a cancel-pending job, a bridge-disabled payload and
            // an operator switch that is off. The controller must not be able
            // to tell them apart, so there is exactly one message.
            const controller = makeController({}, { mint: jest.fn(async () => null) });

            await expect(controller.mintMcpCredential(JOB_ID, body)).rejects.toThrow(
                new UnauthorizedException('Invalid node credential'),
            );
        });

        it('uses the SAME 401 message the lease and complete routes use', async () => {
            const mintController = makeController({}, { mint: jest.fn(async () => null) });
            const leaseController = makeController({ lease: jest.fn(async () => null) });

            const mintError = await mintController
                .mintMcpCredential(JOB_ID, body)
                .catch((error: Error) => error);
            const leaseError = await leaseController.lease(body).catch((error: Error) => error);

            expect((mintError as Error).message).toBe((leaseError as Error).message);
        });
    });

    describe('POST /api/fleet/jobs/:id/mcp-credential/revoke', () => {
        it('reports how many credentials were dropped', async () => {
            const revokeForNode = jest.fn(async () => 2);
            const controller = makeController({}, { revokeForNode });

            await expect(controller.revokeMcpCredential(JOB_ID, body)).resolves.toEqual({
                ok: true,
                revoked: 2,
            });
            expect(revokeForNode).toHaveBeenCalledWith({
                nodeId: NODE_ID,
                secret: SECRET,
                jobId: JOB_ID,
            });
        });

        it('answers ok with 0 — not a 401 — when there was nothing to revoke', async () => {
            // The distinction that must survive: `null` (refused) vs `0` (a
            // valid node whose job had no live credential). Collapsing those
            // would make an ordinary double-revoke look like an auth failure.
            const controller = makeController({}, { revokeForNode: jest.fn(async () => 0) });
            await expect(controller.revokeMcpCredential(JOB_ID, body)).resolves.toEqual({
                ok: true,
                revoked: 0,
            });
        });

        it('collapses a refused revoke to the same 401', async () => {
            const controller = makeController({}, { revokeForNode: jest.fn(async () => null) });
            await expect(controller.revokeMcpCredential(JOB_ID, body)).rejects.toThrow(
                new UnauthorizedException('Invalid node credential'),
            );
        });
    });
});
