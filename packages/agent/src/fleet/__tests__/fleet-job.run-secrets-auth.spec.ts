import { createHash, randomBytes } from 'crypto';
import { FleetJob } from '../../entities/fleet-job.entity';
import { FleetJobService, FleetJobStaleLeaseError } from '../fleet-job.service';

/**
 * Run secrets (self-build slice Y, EW-781) —
 * `FleetJobService.authorizeRunSecretRequest`.
 *
 * This is the gate in front of the only endpoint that hands a decrypted
 * `.env` to a machine, so it must prove exactly what `completeJob` proves
 * and in the same order: the credential verifies, the job's recorded
 * holder IS this node, the job is still active, and the echoed
 * `leaseGeneration` is the current one. Anything less would let a node
 * that merely authenticated — or one whose claim lapsed while it slept —
 * pull another run's secrets.
 *
 * The one deliberate asymmetry with `lease` is the intent: a PAUSED node
 * is served, because pausing is a drain and a drain has to let in-flight
 * work finish. It already holds the checkout; refusing its env files
 * would strand the run rather than end it.
 */

const NODE_A = '11111111-1111-4111-8111-111111111111';
const NODE_B = '22222222-2222-4222-8222-222222222222';
const USER = 'owner-1';
const sha256Hex = (value: string): string =>
    createHash('sha256').update(value, 'utf8').digest('hex');

describe('FleetJobService.authorizeRunSecretRequest', () => {
    const secretA = randomBytes(24).toString('base64url');
    const secretB = randomBytes(24).toString('base64url');
    let row: FleetJob & { leaseGeneration: number };
    let nodeStatus: string;
    let service: FleetJobService;

    beforeEach(() => {
        nodeStatus = 'online';
        row = {
            id: 'job-1',
            userId: USER,
            kind: 'agent-task',
            status: 'running',
            nodeId: NODE_A,
            leaseGeneration: 3,
        } as unknown as FleetJob & { leaseGeneration: number };

        service = new FleetJobService(
            { findById: jest.fn(async (id: string) => (id === row.id ? row : null)) } as never,
            {
                findById: jest.fn(async (id: string) => {
                    if (id === NODE_A) {
                        return {
                            id: NODE_A,
                            userId: USER,
                            status: nodeStatus,
                            enrollmentTokenHash: sha256Hex(secretA),
                            capabilities: [],
                        };
                    }
                    if (id === NODE_B) {
                        return {
                            id: NODE_B,
                            userId: 'owner-2',
                            status: 'online',
                            enrollmentTokenHash: sha256Hex(secretB),
                            capabilities: [],
                        };
                    }
                    return null;
                }),
            } as never,
            { findForOwnedAgent: jest.fn(async () => null) } as never,
            { emit: jest.fn() } as never,
        );
    });

    const authorize = (overrides: Record<string, unknown> = {}) =>
        service.authorizeRunSecretRequest({
            nodeId: NODE_A,
            secret: secretA,
            jobId: 'job-1',
            leaseGeneration: 3,
            ...overrides,
        });

    it('answers with the JOB owner, which is the scope every registry read must use', async () => {
        await expect(authorize()).resolves.toEqual({
            jobId: 'job-1',
            userId: USER,
            nodeId: NODE_A,
        });
    });

    it('serves a node the operator has PAUSED, so a drain finishes its run', async () => {
        nodeStatus = 'paused';
        await expect(authorize()).resolves.toMatchObject({ jobId: 'job-1' });
    });

    it.each([
        ['an unknown node', { nodeId: '33333333-3333-4333-8333-333333333333' }],
        ['a wrong secret', { secret: randomBytes(24).toString('base64url') }],
        ['a malformed node id', { nodeId: 'not-a-uuid' }],
    ])('refuses %s', async (_label, overrides) => {
        await expect(authorize(overrides)).resolves.toBeNull();
    });

    it('refuses a node that is authenticated but is not the recorded holder', async () => {
        await expect(
            service.authorizeRunSecretRequest({
                nodeId: NODE_B,
                secret: secretB,
                jobId: 'job-1',
                leaseGeneration: 3,
            }),
        ).resolves.toBeNull();
    });

    it.each(['done', 'failed', 'queued'])('refuses a job in status %s', async (status) => {
        row.status = status as FleetJob['status'];
        await expect(authorize()).resolves.toBeNull();
    });

    it('refuses an unknown job', async () => {
        await expect(authorize({ jobId: 'job-missing' })).resolves.toBeNull();
    });

    it.each([
        ['an older generation', 2],
        ['a newer generation', 4],
        ['the migration backfill value', 0],
        ['a non-integer', 3.5],
        ['a missing generation', undefined],
    ])('refuses %s with the differentiated stale-lease error', async (_label, generation) => {
        await expect(authorize({ leaseGeneration: generation })).rejects.toBeInstanceOf(
            FleetJobStaleLeaseError,
        );
    });

    it('never reaches the stale-lease answer for a node that is not the holder', async () => {
        // The differentiated 409 must stay unreachable for anyone but the
        // true holder of an active job — otherwise it becomes an oracle for
        // which job ids exist.
        await expect(
            service.authorizeRunSecretRequest({
                nodeId: NODE_B,
                secret: secretB,
                jobId: 'job-1',
                leaseGeneration: 999,
            }),
        ).resolves.toBeNull();
    });
});
