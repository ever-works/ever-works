import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
    CompleteFleetJobDto,
    FleetJobEnvFilesDto,
    FleetJobHeartbeatDto,
    LeaseFleetJobsDto,
} from './fleet-job.dto';

/**
 * Suspend-safe leases (self-build finding R7) at the API edge.
 *
 * `leaseGeneration` decides whether a heartbeat or a completion lands, so
 * it is validated like a credential: required, integer, at least 1. A
 * node built before the field existed must be refused HERE with a 400 —
 * the service would refuse it too, but "missing" must never be read as
 * "whatever claim is current".
 */

const NODE_ID = '11111111-1111-4111-8111-111111111111';
const SECRET = 'a'.repeat(43);
const ROW_ID = '22222222-2222-4222-8222-222222222222';

async function failingProperties(dto: object): Promise<string[]> {
    const errors = await validate(dto);
    return errors.map((error) => error.property).sort();
}

describe('fleet job DTOs — leaseGeneration', () => {
    const REJECTED: Array<[string, unknown]> = [
        ['missing', undefined],
        ['null', null],
        ['zero', 0],
        ['negative', -1],
        ['a non-integer', 1.5],
        ['a numeric string', '1'],
        ['NaN', Number.NaN],
    ];

    describe('FleetJobHeartbeatDto', () => {
        it.each(REJECTED)('rejects a generation that is %s', async (_label, leaseGeneration) => {
            const dto = plainToInstance(FleetJobHeartbeatDto, {
                nodeId: NODE_ID,
                secret: SECRET,
                leaseGeneration,
            });
            expect(await failingProperties(dto)).toEqual(['leaseGeneration']);
        });

        it('accepts a positive integer generation', async () => {
            const dto = plainToInstance(FleetJobHeartbeatDto, {
                nodeId: NODE_ID,
                secret: SECRET,
                leaseTtlSec: 300,
                leaseGeneration: 1,
            });
            expect(await failingProperties(dto)).toEqual([]);
        });
    });

    describe('CompleteFleetJobDto', () => {
        it.each(REJECTED)('rejects a generation that is %s', async (_label, leaseGeneration) => {
            const dto = plainToInstance(CompleteFleetJobDto, {
                nodeId: NODE_ID,
                secret: SECRET,
                success: true,
                leaseGeneration,
            });
            expect(await failingProperties(dto)).toEqual(['leaseGeneration']);
        });

        it('accepts a positive integer generation on both verdicts', async () => {
            for (const body of [
                { success: true, result: { ok: true } },
                { success: false, error: 'exit 1' },
            ]) {
                const dto = plainToInstance(CompleteFleetJobDto, {
                    nodeId: NODE_ID,
                    secret: SECRET,
                    leaseGeneration: 7,
                    ...body,
                });
                expect(await failingProperties(dto)).toEqual([]);
            }
        });
    });

    describe('LeaseFleetJobsDto', () => {
        it('does not require a generation — the lease is what MINTS one', async () => {
            const dto = plainToInstance(LeaseFleetJobsDto, { nodeId: NODE_ID, secret: SECRET });
            expect(await failingProperties(dto)).toEqual([]);
        });
    });

    describe('FleetJobEnvFilesDto (run secrets, slice Y)', () => {
        it.each(REJECTED)('rejects a generation that is %s', async (_label, leaseGeneration) => {
            const dto = plainToInstance(FleetJobEnvFilesDto, {
                nodeId: NODE_ID,
                secret: SECRET,
                leaseGeneration,
                refs: [{ repoConnectionId: ROW_ID, paths: ['.env'] }],
            });
            expect(await failingProperties(dto)).toContain('leaseGeneration');
        });
    });
});

/**
 * Run secrets (self-build slice Y, EW-781) at the API edge.
 *
 * The request body is by REFERENCE, so the edge's whole job is to make
 * sure nothing that is not a repository-relative path can reach the
 * resolver — traversal, absolute forms, Windows drive prefixes. The
 * service re-checks with `isValidFleetRunEnvFilePath`; this is the other
 * half of that pair, and it must never be the looser one.
 */
describe('FleetJobEnvFilesDto — path shape', () => {
    const ROW = ROW_ID;
    const build = (paths: unknown) =>
        plainToInstance(FleetJobEnvFilesDto, {
            nodeId: NODE_ID,
            secret: SECRET,
            leaseGeneration: 1,
            refs: [{ repoConnectionId: ROW, paths }],
        });

    it.each([['.env'], ['apps/api/.env'], ['packages/agent/.env.local']])(
        'accepts the repository-relative path %s',
        async (path) => {
            expect(await failingProperties(build([path]))).toEqual([]);
        },
    );

    it.each([
        ['parent traversal', '../.env'],
        ['embedded traversal', 'apps/../../.env'],
        ['a dot segment', 'apps/./.env'],
        ['an absolute posix path', '/etc/passwd'],
        ['a windows drive path', 'C:/Windows/x'],
        ['a backslash path', String.raw`apps\api\.env`],
    ])('rejects %s', async (_label, path) => {
        expect(await failingProperties(build([path]))).toEqual(['refs']);
    });

    it('requires at least one reference and one path — an empty ask is not a valid one', async () => {
        expect(await failingProperties(build([]))).toEqual(['refs']);
        expect(
            await failingProperties(
                plainToInstance(FleetJobEnvFilesDto, {
                    nodeId: NODE_ID,
                    secret: SECRET,
                    leaseGeneration: 1,
                    refs: [],
                }),
            ),
        ).toEqual(['refs']);
    });

    it('rejects a repoConnectionId that is not a row id', async () => {
        const dto = plainToInstance(FleetJobEnvFilesDto, {
            nodeId: NODE_ID,
            secret: SECRET,
            leaseGeneration: 1,
            refs: [{ repoConnectionId: '../../etc', paths: ['.env'] }],
        });
        expect(await failingProperties(dto)).toEqual(['refs']);
    });
});
