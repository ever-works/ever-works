import { createHash } from 'crypto';
import { FleetNode } from '../../entities/fleet-node.entity';
import { FleetService } from '../fleet.service';

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

const NODE_ID = '11111111-1111-4111-8111-111111111111';
const SECRET = 'a'.repeat(43);

const node = (overrides: Partial<FleetNode> = {}): FleetNode =>
    ({
        id: NODE_ID,
        userId: 'user-1',
        organizationId: null,
        name: 'my laptop',
        kind: 'desktop-node',
        status: 'online',
        enrollmentTokenHash: sha256(SECRET),
        lastHeartbeatAt: new Date(),
        capabilities: [],
        capabilitiesPinned: false,
        platform: 'linux/x64',
        version: '1.0.0',
        cliVersion: null,
        diskFreeBytes: null,
        createdAt: new Date(),
        ...overrides,
    }) as FleetNode;

/**
 * Node telemetry — `cliVersion` + `diskFreeBytes` on the heartbeat.
 *
 * The load-bearing property is BACKWARD COMPATIBILITY. These fields ship
 * to a fleet whose machines are already running older daemons that will
 * never send them, and those daemons must keep working AND must not wipe
 * a reading a newer build left behind. So the contract is asymmetric on
 * purpose:
 *
 *   - enroll  writes the fields (the row is new; there is nothing to keep)
 *   - beat    writes them only when PRESENT (absent means "leave alone")
 *
 * Everything else here is the refusal policy: a nonsense byte count is
 * dropped rather than clamped, because a clamped figure is a plausible
 * number an operator would act on.
 */
describe('FleetService node telemetry', () => {
    let repository: {
        create: jest.Mock;
        findById: jest.Mock;
        findByCredentialHash: jest.Mock;
        findByUser: jest.Mock;
        consumeEnrollment: jest.Mock;
        update: jest.Mock;
        delete: jest.Mock;
        sweepOffline: jest.Mock;
    };

    beforeEach(() => {
        repository = {
            create: jest.fn(async (data) => node({ ...data })),
            findById: jest.fn(async () => node()),
            findByCredentialHash: jest.fn(async () => null),
            findByUser: jest.fn(async () => []),
            consumeEnrollment: jest.fn(async () => true),
            update: jest.fn(async () => undefined),
            delete: jest.fn(async () => undefined),
            sweepOffline: jest.fn(async () => 0),
        };
    });

    const build = () => new FleetService(repository as never);

    describe('heartbeat backward compatibility', () => {
        it('accepts a heartbeat from an OLD daemon that sends no telemetry at all', async () => {
            const service = build();

            const result = await service.heartbeat(NODE_ID, SECRET, {
                platform: 'linux/x64',
                version: '0.9.0',
                capabilities: ['terminal'],
            });

            expect(result).not.toBeNull();
            const patch = repository.update.mock.calls[0][1];
            // The beat is accepted and stamps last-seen...
            expect(patch.lastHeartbeatAt).toBeInstanceOf(Date);
            // ...and does not touch the columns it knows nothing about.
            expect(patch).not.toHaveProperty('cliVersion');
            expect(patch).not.toHaveProperty('diskFreeBytes');
        });

        it('does NOT clear a stored reading when a later beat omits the field', async () => {
            repository.findById.mockResolvedValue(
                node({ cliVersion: 'claude 1.4.2', diskFreeBytes: '900000000' }),
            );
            const service = build();

            const result = await service.heartbeat(NODE_ID, SECRET, { platform: 'linux/x64' });

            const patch = repository.update.mock.calls[0][1];
            expect(patch).not.toHaveProperty('cliVersion');
            expect(patch).not.toHaveProperty('diskFreeBytes');
            // The returned view still carries what was stored — an
            // operator downgrading one machine must not blank the column
            // for everyone reading the runner popover.
            expect(result?.node.cliVersion).toBe('claude 1.4.2');
            expect(result?.node.diskFreeBytes).toBe(900_000_000);
        });

        it('stores telemetry a NEW daemon does send', async () => {
            const service = build();

            const result = await service.heartbeat(NODE_ID, SECRET, {
                cliVersion: 'claude 1.4.2',
                diskFreeBytes: 123_456_789,
            });

            const patch = repository.update.mock.calls[0][1];
            expect(patch.cliVersion).toBe('claude 1.4.2');
            expect(patch.diskFreeBytes).toBe(123_456_789);
            expect(result?.node.cliVersion).toBe('claude 1.4.2');
            expect(result?.node.diskFreeBytes).toBe(123_456_789);
        });
    });

    describe('sanitization', () => {
        it.each([
            ['negative', -1],
            ['non-finite', Number.POSITIVE_INFINITY],
            ['absurd (above the ceiling)', 2 ** 62],
        ])('refuses a %s byte count rather than storing it', async (_label, value) => {
            const service = build();

            await service.heartbeat(NODE_ID, SECRET, { diskFreeBytes: value as number });

            const patch = repository.update.mock.calls[0][1];
            // Refused, not clamped: a clamped figure would render as a
            // believable number the operator would then act on.
            expect(patch).not.toHaveProperty('diskFreeBytes');
        });

        it('floors a fractional byte count', async () => {
            const service = build();

            await service.heartbeat(NODE_ID, SECRET, { diskFreeBytes: 1024.9 });

            expect(repository.update.mock.calls[0][1].diskFreeBytes).toBe(1024);
        });

        it('truncates an over-long CLI version to the contract cap', async () => {
            const service = build();

            await service.heartbeat(NODE_ID, SECRET, { cliVersion: 'x'.repeat(200) });

            expect(repository.update.mock.calls[0][1].cliVersion).toHaveLength(64);
        });

        it('ignores a blank CLI version instead of storing an empty string', async () => {
            const service = build();

            await service.heartbeat(NODE_ID, SECRET, { cliVersion: '   ' });

            expect(repository.update.mock.calls[0][1]).not.toHaveProperty('cliVersion');
        });
    });

    describe('enroll', () => {
        it('writes telemetry onto the fresh row', async () => {
            const token = 'b'.repeat(43);
            repository.findByCredentialHash.mockResolvedValue(
                node({
                    status: 'enrolling',
                    enrollmentTokenHash: sha256(token),
                    credentialIssuedAt: new Date(),
                }),
            );
            const service = build();

            const result = await service.enroll(token, {
                cliVersion: 'codex 2.0.0',
                diskFreeBytes: 42,
            });

            expect(result).not.toBeNull();
            const patch = repository.consumeEnrollment.mock.calls[0][2];
            expect(patch.cliVersion).toBe('codex 2.0.0');
            expect(patch.diskFreeBytes).toBe(42);
        });

        it('nulls telemetry an enrolling node does not report (the row is new)', async () => {
            const token = 'c'.repeat(43);
            repository.findByCredentialHash.mockResolvedValue(
                node({
                    status: 'enrolling',
                    enrollmentTokenHash: sha256(token),
                    credentialIssuedAt: new Date(),
                }),
            );
            const service = build();

            await service.enroll(token, {});

            const patch = repository.consumeEnrollment.mock.calls[0][2];
            expect(patch.cliVersion).toBeNull();
            expect(patch.diskFreeBytes).toBeNull();
        });
    });

    describe('view normalization', () => {
        it('normalizes the Postgres bigint STRING into a number', async () => {
            // TypeORM hands `bigint` back as a string on Postgres and a
            // number on sqlite. If the view did not normalize, one driver
            // would put `"900000000"` into a JSON response and the UI's
            // byte formatter would receive a string.
            repository.findByUser.mockResolvedValue([node({ diskFreeBytes: '900000000' })]);
            const service = build();

            const [view] = await service.listEnrolledForUser('user-1');

            expect(view.diskFreeBytes).toBe(900_000_000);
            expect(typeof view.diskFreeBytes).toBe('number');
        });

        it('reports an unparseable byte count as null rather than NaN', async () => {
            repository.findByUser.mockResolvedValue([node({ diskFreeBytes: 'not-a-number' })]);
            const service = build();

            const [view] = await service.listEnrolledForUser('user-1');

            expect(view.diskFreeBytes).toBeNull();
        });
    });

    describe('listEnrolledForUser', () => {
        it('sweeps stale nodes offline but never merges cluster nodes', async () => {
            repository.findByUser.mockResolvedValue([node()]);
            const registry = { get: jest.fn(() => ({ plugin: {} })) };
            const settings = { getResolvedSettings: jest.fn() };
            const service = new FleetService(
                repository as never,
                registry as never,
                settings as never,
            );

            const views = await service.listEnrolledForUser('user-1');

            expect(repository.sweepOffline).toHaveBeenCalledTimes(1);
            expect(views).toHaveLength(1);
            // The cluster merge costs a round-trip to the user's k8s API,
            // and the runner pill polls this every 30s. It must not fire.
            expect(settings.getResolvedSettings).not.toHaveBeenCalled();
        });
    });
});
