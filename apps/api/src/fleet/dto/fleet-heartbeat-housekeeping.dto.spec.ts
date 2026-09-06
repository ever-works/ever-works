import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { FLEET_MAX_DISK_FREE_BYTES, FLEET_MAX_WORKSPACE_COUNT } from '@ever-works/contracts';
import { FleetHeartbeatDto } from './fleet.dto';

/**
 * Node housekeeping (EW-803) — the heartbeat DTO's half of the contract.
 *
 * The global pipe runs `whitelist + forbidNonWhitelisted`, which makes
 * this file load-bearing in a way most DTOs are not: a field the DTO does
 * not accept is not dropped, it fails the whole request — and a failed
 * heartbeat is a node swept offline. Adding five fields to the beat is
 * therefore only safe if all three of these hold, and each is pinned
 * below:
 *
 *   - an OLDER daemon that sends none of them still beats;
 *   - a NEWER daemon that sends all of them is accepted, rather than
 *     400'd by an API that predates the fields;
 *   - a MALFORMED value costs the machine that one figure and nothing
 *     more — which is why `lastReclaimAt` is a bounded string here and is
 *     parsed in `FleetService`, not validated as an ISO date at the edge.
 *
 * The service-side refusal policy (nonsense dropped rather than clamped,
 * null-clears-the-floor, the instant/bytes pairing) lives in
 * `packages/agent/src/fleet/__tests__/fleet-node-telemetry.spec.ts`.
 */

const NODE_ID = '11111111-1111-4111-8111-111111111111';
const SECRET = 'a'.repeat(43);

async function failingProperties(dto: object): Promise<string[]> {
    const errors = await validate(dto);
    return errors.map((error) => error.property).sort();
}

const beat = (extra: Record<string, unknown>) =>
    plainToInstance(FleetHeartbeatDto, { nodeId: NODE_ID, secret: SECRET, ...extra });

describe('FleetHeartbeatDto — housekeeping', () => {
    it('accepts a full housekeeping report', async () => {
        const dto = beat({
            minFreeDiskBytes: 2 * 1024 ** 3,
            workspaceCount: 12,
            workspaceBytes: 40 * 1024 ** 3,
            lastReclaimAt: '2026-09-05T09:30:00.000Z',
            lastReclaimFreedBytes: 3 * 1024 ** 3,
        });
        await expect(failingProperties(dto)).resolves.toEqual([]);
    });

    it('accepts a beat that says nothing about housekeeping at all', async () => {
        // Every daemon in the field before this slice. Absent must stay
        // valid or the whole fleet 400s on its next beat.
        await expect(failingProperties(beat({}))).resolves.toEqual([]);
    });

    it('accepts an explicit null floor — "the operator switched it off"', async () => {
        // `@IsOptional()` skips null as well as undefined, which is what
        // lets this state be expressed at all. The service tells the two
        // apart; the pipe must not reject either.
        await expect(failingProperties(beat({ minFreeDiskBytes: null }))).resolves.toEqual([]);
    });

    it('accepts a zero floor, a zero count and a zero reclaim', async () => {
        // Zero is a real answer for each of these, and `@Min(0)` must not
        // be tightened to `@Min(1)` by someone who assumes otherwise.
        const dto = beat({
            minFreeDiskBytes: 0,
            workspaceCount: 0,
            workspaceBytes: 0,
            lastReclaimFreedBytes: 0,
        });
        await expect(failingProperties(dto)).resolves.toEqual([]);
    });

    it('accepts each numeric field at exactly its contract ceiling', async () => {
        await expect(
            failingProperties(beat({ workspaceCount: FLEET_MAX_WORKSPACE_COUNT })),
        ).resolves.toEqual([]);
        await expect(
            failingProperties(beat({ workspaceBytes: FLEET_MAX_DISK_FREE_BYTES })),
        ).resolves.toEqual([]);
    });

    it.each([
        ['workspaceCount', FLEET_MAX_WORKSPACE_COUNT + 1],
        ['workspaceBytes', FLEET_MAX_DISK_FREE_BYTES * 2],
        ['lastReclaimFreedBytes', FLEET_MAX_DISK_FREE_BYTES * 2],
    ])('rejects %s past its ceiling', async (field, value) => {
        await expect(failingProperties(beat({ [field]: value }))).resolves.toEqual([field]);
    });

    it.each([
        ['minFreeDiskBytes', -1],
        ['workspaceCount', -1],
        ['workspaceBytes', -1],
        ['lastReclaimFreedBytes', -1],
    ])('rejects a negative %s', async (field, value) => {
        await expect(failingProperties(beat({ [field]: value }))).resolves.toEqual([field]);
    });

    it('rejects a fractional workspace count', async () => {
        await expect(failingProperties(beat({ workspaceCount: 3.5 }))).resolves.toEqual([
            'workspaceCount',
        ]);
    });

    it.each([
        ['a string', '12'],
        ['an object', { count: 12 }],
        ['an array', [12]],
    ])('rejects %s as a workspace count', async (_label, workspaceCount) => {
        await expect(failingProperties(beat({ workspaceCount }))).resolves.toEqual([
            'workspaceCount',
        ]);
    });

    it('accepts an UNPARSEABLE reclaim instant rather than failing the beat', async () => {
        // The deliberate design decision this case exists to protect. An
        // `@IsISO8601()` here would take a live machine offline over a
        // cosmetic timestamp; the service refuses the value instead and
        // the node keeps its liveness.
        await expect(failingProperties(beat({ lastReclaimAt: 'last Tuesday' }))).resolves.toEqual(
            [],
        );
    });

    it('accepts a reclaim instant with an offset and with nanosecond precision', async () => {
        // A node is an ordinary PC in an ordinary timezone; the edge cap
        // has to fit the long forms, not just the Z-normalized one.
        await expect(
            failingProperties(beat({ lastReclaimAt: '2026-09-05T14:03:07.123456789+05:30' })),
        ).resolves.toEqual([]);
    });

    it('rejects an absurdly long reclaim instant', async () => {
        // A heartbeat field with no cap is unbounded storage on an
        // unauthenticated-by-token public endpoint.
        await expect(failingProperties(beat({ lastReclaimAt: 'x'.repeat(65) }))).resolves.toEqual([
            'lastReclaimAt',
        ]);
    });

    it('rejects a non-string reclaim instant', async () => {
        await expect(failingProperties(beat({ lastReclaimAt: 1757064600000 }))).resolves.toEqual([
            'lastReclaimAt',
        ]);
    });

    it('still requires the credential — the new fields buy no authority', async () => {
        const dto = plainToInstance(FleetHeartbeatDto, { workspaceCount: 1 });
        await expect(failingProperties(dto)).resolves.toEqual(['nodeId', 'secret']);
    });
});
