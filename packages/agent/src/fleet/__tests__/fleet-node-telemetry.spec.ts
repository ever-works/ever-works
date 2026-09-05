import { createHash } from 'crypto';
import { BadRequestException, NotFoundException } from '@nestjs/common';
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
        modelIdentity: null,
        dailyCostCeilingCents: null,
        dailyCostTrippedOn: null,
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

    describe('model identity (fleet cost accounting, EW-777)', () => {
        const IDENTITY = 'claude-code: ops@example.com (Acme, max)';

        it('stores the seat a NEW daemon reports and exposes it on the view', async () => {
            const service = build();

            const result = await service.heartbeat(NODE_ID, SECRET, { modelIdentity: IDENTITY });

            expect(repository.update.mock.calls[0][1].modelIdentity).toBe(IDENTITY);
            expect(result?.node.modelIdentity).toBe(IDENTITY);
        });

        it('leaves the stored seat alone when a beat omits it (older daemon, transient probe miss)', async () => {
            repository.findById.mockResolvedValue(node({ modelIdentity: IDENTITY }));
            const service = build();

            const result = await service.heartbeat(NODE_ID, SECRET, { cliVersion: 'claude 1.4.2' });

            expect(repository.update.mock.calls[0][1]).not.toHaveProperty('modelIdentity');
            expect(result?.node.modelIdentity).toBe(IDENTITY);
        });

        it('ignores a blank seat and truncates an over-long one to the contract cap', async () => {
            const service = build();

            await service.heartbeat(NODE_ID, SECRET, { modelIdentity: '   ' });
            expect(repository.update.mock.calls[0][1]).not.toHaveProperty('modelIdentity');

            await service.heartbeat(NODE_ID, SECRET, { modelIdentity: 'x'.repeat(500) });
            expect(repository.update.mock.calls[1][1].modelIdentity).toHaveLength(200);
        });

        it('never stores a credential-shaped seat verbatim — the wire is untrusted', async () => {
            // The daemon whitelists what it sends; a tampered one need not.
            // The label is listed, frozen into usage metadata and quoted in
            // notices, so a token in it would be a token in four places.
            const service = build();
            const token = `sk-ant-api03-${'a'.repeat(40)}`;

            await service.heartbeat(NODE_ID, SECRET, { modelIdentity: `claude-code: ${token}` });
            const stored = repository.update.mock.calls[0][1].modelIdentity as string;
            expect(stored).not.toContain(token);
            expect(stored).toContain('[redacted secret]');
            expect(stored.length).toBeLessThanOrEqual(200);

            await service.heartbeat(NODE_ID, SECRET, {
                modelIdentity: `codex: Bearer ${'b'.repeat(32)}`,
            });
            expect(repository.update.mock.calls[1][1].modelIdentity).not.toContain('b'.repeat(32));
        });

        it('writes the seat (or null) onto the fresh row at enroll', async () => {
            const token = 'd'.repeat(43);
            repository.findByCredentialHash.mockResolvedValue(
                node({
                    status: 'enrolling',
                    enrollmentTokenHash: sha256(token),
                    credentialIssuedAt: new Date(),
                }),
            );
            const service = build();

            await service.enroll(token, { modelIdentity: 'codex: chatgpt' });
            expect(repository.consumeEnrollment.mock.calls[0][2].modelIdentity).toBe(
                'codex: chatgpt',
            );

            repository.findByCredentialHash.mockResolvedValue(
                node({
                    status: 'enrolling',
                    enrollmentTokenHash: sha256(token),
                    credentialIssuedAt: new Date(),
                }),
            );
            await service.enroll(token, {});
            expect(repository.consumeEnrollment.mock.calls[1][2].modelIdentity).toBeNull();
        });

        it('never exposes a seat for a node that reported none', async () => {
            repository.findByUser.mockResolvedValue([node()]);
            const [view] = await build().listEnrolledForUser('user-1');
            expect(view.modelIdentity).toBeNull();
        });
    });

    describe('per-node daily cost ceiling (fleet cost accounting, EW-777)', () => {
        it('sets a whole-cent ceiling, owner-scoped, and re-arms the one-notice marker', async () => {
            repository.findById.mockResolvedValue(node({ dailyCostTrippedOn: '2026-09-04' }));
            const service = build();

            const view = await service.setDailyCostCeilingForUser('user-1', NODE_ID, 2_500);

            // A raised ceiling crossed again on the same day is NEWS — left
            // set, the day's marker would make that second crossing drain
            // the node in silence.
            expect(repository.update).toHaveBeenCalledWith(NODE_ID, {
                dailyCostCeilingCents: 2_500,
                dailyCostTrippedOn: null,
            });
            expect(view.dailyCostCeilingCents).toBe(2_500);
            expect(view.dailyCostTrippedOn).toBeNull();
        });

        it('clears the ceiling with null (back to the deployment default)', async () => {
            repository.findById.mockResolvedValue(node({ dailyCostCeilingCents: 2_500 }));
            const service = build();

            const view = await service.setDailyCostCeilingForUser('user-1', NODE_ID, null);

            expect(repository.update).toHaveBeenCalledWith(NODE_ID, {
                dailyCostCeilingCents: null,
                dailyCostTrippedOn: null,
            });
            expect(view.dailyCostCeilingCents).toBeNull();
        });

        it.each([
            ['zero', 0],
            ['negative', -100],
            ['fractional cents', 12.5],
            ['above the contract cap', 10_000_001],
            ['a string', '2500'],
        ])('refuses %s rather than clamping it', async (_label, value) => {
            const service = build();

            await expect(
                service.setDailyCostCeilingForUser('user-1', NODE_ID, value as number),
            ).rejects.toBeInstanceOf(BadRequestException);
            expect(repository.update).not.toHaveBeenCalled();
        });

        it("treats another owner's node as missing", async () => {
            repository.findById.mockResolvedValue(node({ userId: 'someone-else' }));
            const service = build();

            await expect(
                service.setDailyCostCeilingForUser('user-1', NODE_ID, 100),
            ).rejects.toBeInstanceOf(NotFoundException);
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

    /**
     * Fleet health signals (EW-776) — the worker state on the wire.
     *
     * Same additive contract as the telemetry above, plus one rule of its
     * own: the value is NORMALIZED before it is stored. A node is an
     * untrusted machine, and this string ends up in a status badge an
     * operator makes decisions from.
     */
    describe('worker state', () => {
        it('persists a reported state with its reason and stamps the change time', async () => {
            repository.findById.mockResolvedValue(node({ workerState: 'idle' }));
            const service = build();

            const result = await service.heartbeat(NODE_ID, SECRET, {
                workerState: 'throttled',
                workerStateReason: 'CPU over the configured ceiling',
            });

            const patch = repository.update.mock.calls[0][1];
            expect(patch.workerState).toBe('throttled');
            expect(patch.workerStateReason).toBe('CPU over the configured ceiling');
            expect(patch.workerStateChangedAt).toBeInstanceOf(Date);
            expect(result!.node.workerState).toBe('throttled');
            expect(result!.node.workerStateChangedAt).toEqual(expect.any(String));
        });

        it('does NOT re-stamp the change time while the state is unchanged', async () => {
            // "Quarantined since 03:14" has to survive the several hundred
            // beats that follow it. Re-stamping every 30s would erase the
            // only durable record of when the machine stopped working.
            repository.findById.mockResolvedValue(node({ workerState: 'quarantined' }));
            const service = build();

            await service.heartbeat(NODE_ID, SECRET, { workerState: 'quarantined' });

            const patch = repository.update.mock.calls[0][1];
            expect(patch).not.toHaveProperty('workerState');
            expect(patch).not.toHaveProperty('workerStateChangedAt');
        });

        it('updates the reason alone when only the reason moved', async () => {
            // A throttle that changes from 'CPU' to 'disk floor' is still a
            // throttle, but the operator needs the new sentence.
            repository.findById.mockResolvedValue(
                node({ workerState: 'throttled', workerStateReason: 'CPU ceiling' }),
            );
            const service = build();

            await service.heartbeat(NODE_ID, SECRET, {
                workerState: 'throttled',
                workerStateReason: 'free disk below the floor',
            });

            const patch = repository.update.mock.calls[0][1];
            expect(patch.workerStateReason).toBe('free disk below the floor');
            expect(patch).not.toHaveProperty('workerStateChangedAt');
        });

        it('leaves the stored state alone when the beat says nothing about it', async () => {
            repository.findById.mockResolvedValue(node({ workerState: 'working' }));
            const service = build();

            await service.heartbeat(NODE_ID, SECRET, { version: '1.1.0' });

            const patch = repository.update.mock.calls[0][1];
            expect(patch).not.toHaveProperty('workerState');
            expect(patch).not.toHaveProperty('workerStateReason');
            expect(patch).not.toHaveProperty('workerStateChangedAt');
        });

        it('stores an unrecognised value as unknown and discards its reason', async () => {
            // A value this build has never heard of is never rewritten into
            // a plausible-looking member, and a reason we cannot vouch for
            // is not shown under an "unknown" badge.
            repository.findById.mockResolvedValue(node({ workerState: 'idle' }));
            const service = build();

            await service.heartbeat(NODE_ID, SECRET, {
                workerState: 'hibernating',
                workerStateReason: 'lid closed',
            });

            const patch = repository.update.mock.calls[0][1];
            expect(patch.workerState).toBeNull();
            // Nothing to clear here (the row carried no reason), and
            // nothing is written either — see the next case for the clear.
            expect(patch).not.toHaveProperty('workerStateReason');
        });

        it('clears a stored reason when the new state is unrecognised', async () => {
            repository.findById.mockResolvedValue(
                node({ workerState: 'throttled', workerStateReason: 'CPU ceiling' }),
            );
            const service = build();

            await service.heartbeat(NODE_ID, SECRET, {
                workerState: 'hibernating',
                workerStateReason: 'lid closed',
            });

            const patch = repository.update.mock.calls[0][1];
            expect(patch.workerState).toBeNull();
            // The OLD reason described a state that is no longer true, and
            // the new one describes a state we cannot vouch for. Neither
            // belongs under an "unknown" badge.
            expect(patch.workerStateReason).toBeNull();
        });

        it('accepts a non-string worker state without failing the beat', async () => {
            // A malformed field must never cost a node its liveness: a
            // rejected beat is an offline node.
            repository.findById.mockResolvedValue(node({ workerState: 'idle' }));
            const service = build();

            const result = await service.heartbeat(NODE_ID, SECRET, {
                workerState: 42 as never,
            });

            expect(result).not.toBeNull();
            expect(repository.update.mock.calls[0][1].workerState).toBeNull();
        });

        it('caps the reason at the contract bound', async () => {
            repository.findById.mockResolvedValue(node({ workerState: 'idle' }));
            const service = build();

            await service.heartbeat(NODE_ID, SECRET, {
                workerState: 'quarantined',
                workerStateReason: 'x'.repeat(900),
            });

            expect(repository.update.mock.calls[0][1].workerStateReason).toHaveLength(500);
        });

        it('does not let a quarantine reason leak a credential it quoted', async () => {
            // The reason is composed on the machine out of error text and
            // command output, then stored, listed AND quoted into notices.
            const leaked = 'ghp_' + 'b'.repeat(36);
            repository.findById.mockResolvedValue(node({ workerState: 'idle' }));
            const service = build();

            await service.heartbeat(NODE_ID, SECRET, {
                workerState: 'quarantined',
                workerStateReason: 'kill failed for: node --token=' + leaked,
            });

            const stored = repository.update.mock.calls[0][1].workerStateReason as string;
            expect(stored).not.toContain(leaked);
        });

        it('stamps the state on ENROLL, where there is nothing to preserve', async () => {
            const token = 'tok_'.padEnd(43, 'c');
            repository.findByCredentialHash.mockResolvedValue(
                node({
                    status: 'enrolling',
                    enrollmentTokenHash: sha256(token),
                    credentialIssuedAt: new Date(),
                }),
            );
            const service = build();

            await service.enroll(token, { workerState: 'idle' });

            const patch = repository.consumeEnrollment.mock.calls[0][2];
            expect(patch.workerState).toBe('idle');
            expect(patch.workerStateChangedAt).toBeInstanceOf(Date);
        });

        it('drops an ENROLL reason whose state it could not recognise', async () => {
            // Same rule as the heartbeat path: a reason we cannot vouch for
            // must not end up captioning an "unknown" badge. Enroll is the
            // easier place to get this wrong because the whole patch is
            // written unconditionally.
            const token = 'tok_'.padEnd(43, 'd');
            repository.findByCredentialHash.mockResolvedValue(
                node({
                    status: 'enrolling',
                    enrollmentTokenHash: sha256(token),
                    credentialIssuedAt: new Date(),
                }),
            );
            const service = build();

            await service.enroll(token, {
                workerState: 'hibernating',
                workerStateReason: 'lid closed',
            });

            const patch = repository.consumeEnrollment.mock.calls[0][2];
            expect(patch.workerState).toBeNull();
            expect(patch.workerStateReason).toBeNull();
        });
    });
});
