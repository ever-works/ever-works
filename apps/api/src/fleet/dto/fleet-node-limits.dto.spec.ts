import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { FleetHeartbeatDto, SetFleetNodeLimitCeilingDto } from './fleet.dto';

/**
 * Remote node limits (self-build slice AS) — both DTO halves.
 *
 * The HEARTBEAT half is bounded by type and the int column only, never by
 * the node's own clamp: under `whitelist + forbidNonWhitelisted` a refused
 * field fails the whole beat, and a failed beat is a node swept offline. A
 * newer node that allows 32 concurrent jobs must still beat.
 *
 * The OWNER half (`PUT /api/fleet/nodes/:id/limits`) is the opposite: every
 * field required, nullable, and REFUSED outside the node's bounds — a
 * ceiling the node would silently rewrite is a setting that does not do
 * what the owner typed.
 */

const NODE_ID = '11111111-1111-4111-8111-111111111111';
const SECRET = 'a'.repeat(43);

async function failingProperties(dto: object): Promise<string[]> {
    const errors = await validate(dto);
    return errors.map((error) => error.property).sort();
}

const beat = (extra: Record<string, unknown>) =>
    plainToInstance(FleetHeartbeatDto, { nodeId: NODE_ID, secret: SECRET, ...extra });

const ceiling = (body: Record<string, unknown>) =>
    plainToInstance(SetFleetNodeLimitCeilingDto, body);

describe('FleetHeartbeatDto — reported limits', () => {
    it('accepts the set, with null on the CPU / memory pair', async () => {
        await expect(
            failingProperties(
                beat({ maxConcurrentJobs: 2, maxCpuPercent: null, maxMemoryMb: 4096 }),
            ),
        ).resolves.toEqual([]);
    });

    it('accepts a beat that says nothing about limits (every older daemon)', async () => {
        await expect(failingProperties(beat({}))).resolves.toEqual([]);
    });

    it('accepts values WIDER than the node-side clamp — a newer node must keep beating', async () => {
        await expect(
            failingProperties(
                beat({ maxConcurrentJobs: 64, maxCpuPercent: 250, maxMemoryMb: 4_000_000 }),
            ),
        ).resolves.toEqual([]);
    });

    it('refuses only what cannot be a limit at all', async () => {
        await expect(
            failingProperties(
                beat({ maxConcurrentJobs: -1, maxCpuPercent: 1.5, maxMemoryMb: 'lots' }),
            ),
        ).resolves.toEqual(['maxConcurrentJobs', 'maxCpuPercent', 'maxMemoryMb']);
    });
});

describe('SetFleetNodeLimitCeilingDto — the owner ceiling', () => {
    it('accepts a full ceiling, and an all-null one (clear)', async () => {
        await expect(
            failingProperties(
                ceiling({ maxConcurrentJobs: 2, maxCpuPercent: 80, maxMemoryMb: 8192 }),
            ),
        ).resolves.toEqual([]);
        await expect(
            failingProperties(
                ceiling({ maxConcurrentJobs: null, maxCpuPercent: null, maxMemoryMb: null }),
            ),
        ).resolves.toEqual([]);
    });

    it('refuses values outside the node’s own bounds rather than clamping them', async () => {
        await expect(
            failingProperties(
                ceiling({ maxConcurrentJobs: 17, maxCpuPercent: 4, maxMemoryMb: 255 }),
            ),
        ).resolves.toEqual(['maxConcurrentJobs', 'maxCpuPercent', 'maxMemoryMb']);
        await expect(
            failingProperties(
                ceiling({ maxConcurrentJobs: 0, maxCpuPercent: 101, maxMemoryMb: 1.5 }),
            ),
        ).resolves.toEqual(['maxConcurrentJobs', 'maxCpuPercent', 'maxMemoryMb']);
    });

    it('requires every field — a PUT always states the whole ceiling', async () => {
        await expect(failingProperties(ceiling({ maxConcurrentJobs: 2 }))).resolves.toEqual([
            'maxCpuPercent',
            'maxMemoryMb',
        ]);
    });
});
