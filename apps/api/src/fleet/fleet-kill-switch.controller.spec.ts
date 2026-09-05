/**
 * Panic controls (EW-778) — the platform-admin half: set / clear the
 * global stop flag and read the audit trail.
 *
 * The heavy agent barrels are stubbed at module scope (the same posture
 * `agents.module.spec.ts` takes) so the decorator metadata and the
 * forwarding can be asserted without loading the DI graph.
 */
jest.mock('@ever-works/agent/agents', () => ({
    QUEUED_REASON_KILL_SWITCH: 'kill-switch',
    RunDispatchGateService: class RunDispatchGateService {},
}));
jest.mock('@ever-works/agent/fleet', () => ({
    FleetAuditService: class FleetAuditService {},
    FleetKillSwitchService: class FleetKillSwitchService {},
}));
jest.mock('../auth/guards/platform-admin.guard', () => ({
    IsPlatformAdminGuard: class IsPlatformAdminGuard {},
}));

import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { IS_PUBLIC_KEY } from '../auth/decorators/public.decorator';
import { IsPlatformAdminGuard } from '../auth/guards/platform-admin.guard';
import { FleetAuditQueryDto, StopFleetKillSwitchDto } from './dto/fleet-kill-switch.dto';
import { FleetKillSwitchController } from './fleet-kill-switch.controller';
import { FleetEnabledGuard } from './guards/fleet-enabled.guard';

const admin = { userId: 'admin-1' } as AuthenticatedUser;

describe('FleetKillSwitchController', () => {
    let killSwitch: { stop: jest.Mock; clear: jest.Mock };
    let audit: { recent: jest.Mock };
    let dispatchGate: { promoteParked: jest.Mock };
    let controller: FleetKillSwitchController;

    const changeResult = (stopped: boolean) => ({
        state: {
            stopped,
            reason: stopped ? 'incident' : null,
            since: '2026-09-05T02:00:00.000Z',
            unverified: false,
            setByUserId: 'admin-1',
        },
        changed: true,
        auditFailed: false,
    });

    beforeEach(() => {
        killSwitch = {
            stop: jest.fn(async () => changeResult(true)),
            clear: jest.fn(async () => changeResult(false)),
        };
        audit = { recent: jest.fn(async () => []) };
        dispatchGate = {
            promoteParked: jest.fn(async () => ({ promoted: 0, works: 0, budgetExhausted: false })),
        };
        controller = new FleetKillSwitchController(
            killSwitch as never,
            audit as never,
            dispatchGate as never,
        );
    });

    it('is gated on FLEET_ENABLED first and then on platform admin, and is not public', () => {
        const guards = Reflect.getMetadata('__guards__', FleetKillSwitchController) ?? [];
        expect(guards).toEqual([FleetEnabledGuard, IsPlatformAdminGuard]);
        expect(Reflect.getMetadata(IS_PUBLIC_KEY, FleetKillSwitchController)).toBeFalsy();
        for (const route of ['stop', 'clear', 'recentAudit'] as const) {
            expect(Reflect.getMetadata(IS_PUBLIC_KEY, controller[route])).toBeFalsy();
        }
    });

    it('stop forwards the SESSION actor and the reason', async () => {
        const result = await controller.stop(admin, { reason: 'incident' });
        expect(killSwitch.stop).toHaveBeenCalledWith('admin-1', 'incident');
        expect(result.state.stopped).toBe(true);
    });

    it('stop with no reason forwards null', async () => {
        await controller.stop(admin, {});
        expect(killSwitch.stop).toHaveBeenCalledWith('admin-1', null);
    });

    it('stop only flips the flag — it never promotes or cancels anything', async () => {
        await controller.stop(admin, { reason: 'incident' });
        expect(dispatchGate.promoteParked).not.toHaveBeenCalled();
        // No cancel surface is even reachable from this controller.
        const paramTypes = (Reflect.getMetadata('design:paramtypes', FleetKillSwitchController) ??
            []) as Array<{ name?: string }>;
        expect(paramTypes.map((type) => type?.name)).toEqual([
            'FleetKillSwitchService',
            'FleetAuditService',
            'RunDispatchGateService',
        ]);
    });

    it('clear forwards the SESSION actor, answers immediately, then resumes the parked runs', async () => {
        let resolvePromotion: () => void = () => undefined;
        dispatchGate.promoteParked.mockImplementation(
            () =>
                new Promise<void>((resolve) => {
                    resolvePromotion = resolve;
                }),
        );

        const result = await controller.clear(admin);

        expect(killSwitch.clear).toHaveBeenCalledWith('admin-1');
        expect(result.state.stopped).toBe(false);
        // The response did not wait on the promotion (it is still pending).
        expect(dispatchGate.promoteParked).toHaveBeenCalledWith('kill-switch');
        resolvePromotion();
    });

    it('clear survives a promotion that rejects', async () => {
        dispatchGate.promoteParked.mockRejectedValue(new Error('boom'));
        await expect(controller.clear(admin)).resolves.toMatchObject({ changed: true });
        // Let the rejected promise settle inside the catch.
        await new Promise((resolve) => setImmediate(resolve));
    });

    it('audit forwards the limit and defaults it', async () => {
        await controller.recentAudit({ limit: 7 });
        expect(audit.recent).toHaveBeenCalledWith(7);
        await controller.recentAudit({});
        expect(audit.recent).toHaveBeenLastCalledWith(50);
    });
});

describe('kill-switch DTO validation', () => {
    it('StopFleetKillSwitchDto accepts an empty body and bounds the reason', async () => {
        await expect(validate(plainToInstance(StopFleetKillSwitchDto, {}))).resolves.toHaveLength(
            0,
        );
        await expect(
            validate(plainToInstance(StopFleetKillSwitchDto, { reason: 'incident' })),
        ).resolves.toHaveLength(0);
        const tooLong = await validate(
            plainToInstance(StopFleetKillSwitchDto, { reason: 'x'.repeat(501) }),
        );
        expect(tooLong.map((error) => error.property)).toContain('reason');
    });

    it('FleetAuditQueryDto coerces and bounds the limit', async () => {
        const ok = plainToInstance(FleetAuditQueryDto, { limit: '25' });
        expect(ok.limit).toBe(25);
        await expect(validate(ok)).resolves.toHaveLength(0);
        const tooMany = await validate(plainToInstance(FleetAuditQueryDto, { limit: 999 }));
        expect(tooMany.map((error) => error.property)).toContain('limit');
        const zero = await validate(plainToInstance(FleetAuditQueryDto, { limit: 0 }));
        expect(zero.map((error) => error.property)).toContain('limit');
    });
});
