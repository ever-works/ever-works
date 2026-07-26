import { UnauthorizedException } from '@nestjs/common';
import type { FleetJobView } from '@ever-works/contracts';
import { FleetJobsController } from './fleet-jobs.controller';
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

function makeController(service: Partial<FleetJobService>): FleetJobsController {
    return new FleetJobsController(service as FleetJobService);
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
            });
            expect(result).toEqual({ ok: true, job: jobView({ status: 'running' }) });
        });

        it('maps a foreign or finished job to the SAME 401 as a bad credential', async () => {
            const controller = makeController({ heartbeatJob: jest.fn(async () => null) });
            await expect(
                controller.heartbeat(JOB_ID, { nodeId: NODE_ID, secret: SECRET }),
            ).rejects.toBeInstanceOf(UnauthorizedException);
        });

        it('threads the requested lease extension through', async () => {
            const heartbeatJob = jest.fn(async () => jobView());
            const controller = makeController({ heartbeatJob });
            await controller.heartbeat(JOB_ID, {
                nodeId: NODE_ID,
                secret: SECRET,
                leaseTtlSec: 90,
            });
            expect(heartbeatJob).toHaveBeenCalledWith(NODE_ID, SECRET, JOB_ID, 90);
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
            });
            expect(result.job.status).toBe('done');
            expect(completeJob).toHaveBeenCalledWith(
                expect.objectContaining({
                    jobId: JOB_ID,
                    success: true,
                    result: { gateStatus: 'green' },
                    error: null,
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
            });
            expect(completeJob).toHaveBeenCalledWith(
                expect.objectContaining({ success: false, error: 'exit 1', result: null }),
            );
        });

        it('maps a replayed or foreign completion to the same 401', async () => {
            const controller = makeController({ completeJob: jest.fn(async () => null) });
            await expect(
                controller.complete(JOB_ID, {
                    nodeId: NODE_ID,
                    secret: SECRET,
                    success: true,
                }),
            ).rejects.toBeInstanceOf(UnauthorizedException);
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
            () => controller.heartbeat(JOB_ID, { nodeId: NODE_ID, secret: SECRET }),
            () =>
                controller.complete(JOB_ID, {
                    nodeId: NODE_ID,
                    secret: SECRET,
                    success: true,
                }),
        ]) {
            await call().catch((error: Error) => messages.push(error.message));
        }

        expect(messages).toHaveLength(3);
        expect(new Set(messages).size).toBe(1);
    });
});
