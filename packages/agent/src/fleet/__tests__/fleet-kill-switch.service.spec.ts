import { FleetKillSwitchService } from '../fleet-kill-switch.service';
import type { FleetKillSwitch } from '../../entities/fleet-kill-switch.entity';

/**
 * Panic controls (EW-778) — the GLOBAL STOP FLAG service.
 *
 * The contract under test is stated once in the service docblock and
 * pinned here from every side:
 *
 *   - reads FAIL CLOSED: a missing row and a throwing read are both
 *     `stopped: true, unverified: true`, and `isStopped()` /
 *     `shouldHaltDispatch()` say true;
 *   - set / clear write the row AND an audit row carrying the actor;
 *   - an audit failure is reported (`auditFailed`), never thrown, and
 *     never undoes the flip;
 *   - the public projection never leaks who threw the switch.
 */
describe('FleetKillSwitchService', () => {
    const ACTOR = '11111111-1111-4111-8111-111111111111';

    let row: FleetKillSwitch | null;
    let repository: { read: jest.Mock; write: jest.Mock };
    let audit: { record: jest.Mock };
    let service: FleetKillSwitchService;

    const silence = (svc: FleetKillSwitchService) => {
        for (const level of ['error', 'warn', 'log'] as const) {
            jest.spyOn(
                (svc as never as { logger: Record<string, () => void> }).logger,
                level,
            ).mockImplementation(() => undefined);
        }
        return svc;
    };

    beforeEach(() => {
        row = {
            id: 'global',
            stopped: false,
            reason: null,
            setByUserId: null,
            setAt: null,
            updatedAt: new Date('2026-09-05T00:00:00Z'),
        } as FleetKillSwitch;
        repository = {
            read: jest.fn(async () => row),
            write: jest.fn(async (patch: Partial<FleetKillSwitch>) => {
                row = { ...(row ?? ({ id: 'global' } as FleetKillSwitch)), ...patch };
            }),
        };
        audit = { record: jest.fn(async () => ({ id: 'audit-1' })) };
        service = silence(new FleetKillSwitchService(repository as never, audit as never));
    });

    describe('state() — fail closed', () => {
        it('reports a seeded, clear row as not stopped and verified', async () => {
            await expect(service.state()).resolves.toEqual({
                stopped: false,
                reason: null,
                since: null,
                unverified: false,
                setByUserId: null,
            });
            await expect(service.isStopped()).resolves.toBe(false);
            await expect(service.shouldHaltDispatch()).resolves.toBe(false);
        });

        it('treats a MISSING row (migration not applied) as stopped + unverified', async () => {
            row = null;
            const state = await service.state();
            expect(state.stopped).toBe(true);
            expect(state.unverified).toBe(true);
            await expect(service.isStopped()).resolves.toBe(true);
            await expect(service.shouldHaltDispatch()).resolves.toBe(true);
        });

        /**
         * THE load-bearing test: the flag exists to survive exactly the
         * failure that makes it unreadable. Revert-check — make `state()`
         * return `stopped: false` on a caught error and this goes RED.
         */
        it('treats a THROWING read as stopped + unverified and never throws itself', async () => {
            repository.read.mockRejectedValue(new Error('db down'));
            await expect(service.state()).resolves.toMatchObject({
                stopped: true,
                unverified: true,
            });
            await expect(service.isStopped()).resolves.toBe(true);
            await expect(service.shouldHaltDispatch()).resolves.toBe(true);
        });

        it('reads a thrown switch back with its reason and timestamp', async () => {
            row = {
                ...(row as FleetKillSwitch),
                stopped: true,
                reason: 'incident',
                setByUserId: ACTOR,
                setAt: new Date('2026-09-05T02:00:00Z'),
            };
            await expect(service.state()).resolves.toEqual({
                stopped: true,
                reason: 'incident',
                since: '2026-09-05T02:00:00.000Z',
                unverified: false,
                setByUserId: ACTOR,
            });
        });

        it('publicState() never carries the actor', async () => {
            row = { ...(row as FleetKillSwitch), stopped: true, setByUserId: ACTOR };
            const state = await service.publicState();
            expect(state).not.toHaveProperty('setByUserId');
            expect(state.stopped).toBe(true);
        });
    });

    describe('stop()', () => {
        it('flips the row and writes an audit row carrying the actor and the reason', async () => {
            const result = await service.stop(ACTOR, '  incident on prod  ');

            expect(repository.write).toHaveBeenCalledWith(
                expect.objectContaining({
                    stopped: true,
                    reason: 'incident on prod',
                    setByUserId: ACTOR,
                }),
            );
            expect(audit.record).toHaveBeenCalledTimes(1);
            expect(audit.record).toHaveBeenCalledWith(
                expect.objectContaining({
                    action: 'kill-switch.stop',
                    actorUserId: ACTOR,
                    ownerUserId: null,
                    details: expect.objectContaining({ reason: 'incident on prod', changed: true }),
                }),
            );
            expect(result.changed).toBe(true);
            expect(result.auditFailed).toBe(false);
            expect(result.state).toMatchObject({
                stopped: true,
                reason: 'incident on prod',
                setByUserId: ACTOR,
                unverified: false,
            });
            // The next read sees the switch thrown.
            await expect(service.isStopped()).resolves.toBe(true);
        });

        it('is idempotent: a second stop refreshes the row and audits changed:false', async () => {
            await service.stop(ACTOR, 'first');
            const again = await service.stop(ACTOR, 'second operator');
            expect(again.changed).toBe(false);
            expect(again.state.reason).toBe('second operator');
            expect(audit.record).toHaveBeenLastCalledWith(
                expect.objectContaining({
                    action: 'kill-switch.stop',
                    details: expect.objectContaining({ changed: false }),
                }),
            );
        });

        it('caps an over-long reason instead of refusing the stop', async () => {
            const result = await service.stop(ACTOR, 'x'.repeat(600));
            expect(result.state.reason).toHaveLength(500);
            expect(repository.write).toHaveBeenCalledTimes(1);
        });

        it('still flips the switch when the audit write fails, and says so', async () => {
            audit.record.mockRejectedValue(new Error('audit table gone'));
            const result = await service.stop(ACTOR, 'incident');
            expect(repository.write).toHaveBeenCalledTimes(1);
            expect(result.auditFailed).toBe(true);
            expect(result.state.stopped).toBe(true);
            await expect(service.isStopped()).resolves.toBe(true);
        });

        it('lands even when the row could not be read first (unverified before)', async () => {
            repository.read.mockRejectedValueOnce(new Error('db blip'));
            const result = await service.stop(ACTOR, 'incident');
            expect(repository.write).toHaveBeenCalledTimes(1);
            expect(result.changed).toBe(true);
        });
    });

    describe('clear()', () => {
        beforeEach(async () => {
            await service.stop(ACTOR, 'incident');
            audit.record.mockClear();
            repository.write.mockClear();
        });

        it('flips the row back and writes an audit row carrying the actor', async () => {
            const clearer = '22222222-2222-4222-8222-222222222222';
            const result = await service.clear(clearer);

            expect(repository.write).toHaveBeenCalledWith(
                expect.objectContaining({ stopped: false, reason: null, setByUserId: clearer }),
            );
            expect(audit.record).toHaveBeenCalledTimes(1);
            expect(audit.record).toHaveBeenCalledWith(
                expect.objectContaining({
                    action: 'kill-switch.clear',
                    actorUserId: clearer,
                    ownerUserId: null,
                    details: expect.objectContaining({
                        changed: true,
                        before: expect.objectContaining({ stopped: true, reason: 'incident' }),
                        after: expect.objectContaining({ stopped: false }),
                    }),
                }),
            );
            expect(result.changed).toBe(true);
            expect(result.auditFailed).toBe(false);
            await expect(service.isStopped()).resolves.toBe(false);
        });

        it('is idempotent: clearing a clear switch audits changed:false', async () => {
            await service.clear(ACTOR);
            const again = await service.clear(ACTOR);
            expect(again.changed).toBe(false);
        });

        it('still clears when the audit write fails, and says so', async () => {
            audit.record.mockRejectedValue(new Error('audit table gone'));
            const result = await service.clear(ACTOR);
            expect(result.auditFailed).toBe(true);
            expect(result.state.stopped).toBe(false);
            await expect(service.isStopped()).resolves.toBe(false);
        });
    });

    describe('onApplicationBootstrap — the boot-time seed', () => {
        it('seeds the row when it is missing and reports it', async () => {
            const seeding = {
                ensureSeeded: jest.fn(async () => true),
                read: jest.fn(),
                write: jest.fn(),
            };
            const booted = silence(new FleetKillSwitchService(seeding as never, audit as never));
            await booted.onApplicationBootstrap();
            expect(seeding.ensureSeeded).toHaveBeenCalledTimes(1);
        });

        it('never throws when the table is missing — reads simply stay fail-closed', async () => {
            const seeding = {
                ensureSeeded: jest.fn(async () => Promise.reject(new Error('no such table'))),
                read: jest.fn(async () => Promise.reject(new Error('no such table'))),
                write: jest.fn(),
            };
            const booted = silence(new FleetKillSwitchService(seeding as never, audit as never));
            await expect(booted.onApplicationBootstrap()).resolves.toBeUndefined();
            await expect(booted.isStopped()).resolves.toBe(true);
        });
    });

    /**
     * Stopping new work and killing running work are two different
     * decisions. The stop flag has NO handle on jobs or runs — not as a
     * dependency, not as a side effect — so it cannot cancel anything
     * even by accident. `cancel-in-flight` is its own explicit route.
     */
    describe('the stop flag never cancels', () => {
        it('depends on nothing but its own row and the audit trail', () => {
            const paramTypes = (Reflect.getMetadata('design:paramtypes', FleetKillSwitchService) ??
                []) as Array<{ name?: string }>;
            expect(paramTypes.map((type) => type?.name)).toEqual([
                'FleetKillSwitchRepository',
                'FleetAuditService',
            ]);
        });

        it('stop() touches only the switch row and the audit row', async () => {
            await service.stop(ACTOR, 'incident');
            expect(repository.write).toHaveBeenCalledTimes(1);
            expect(audit.record).toHaveBeenCalledTimes(1);
            // Nothing else was reached for: the doubles expose no cancel,
            // and the service asked for none.
            expect(Object.keys(repository).sort()).toEqual(['read', 'write']);
            expect(Object.keys(audit)).toEqual(['record']);
        });
    });
});
