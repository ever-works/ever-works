import { APP_WORK_RUN_ADMISSION, AppChangeTelemetry } from '@ever-works/agent/app-works';
import { FLEET_APP_WORK_LEASE_ADMISSION, type FleetAppWorkLeaseAdmission } from '@ever-works/agent/fleet';
import { ISOLATED_RUN_ADMISSION_PROVIDERS } from './isolated-run-admission.providers';

/**
 * APW-08 T43 — the lease binding emits `app.change.run_admitted` through the App Works telemetry
 * (its sanitizer and sink), resolved lazily from the module graph like the admission itself.
 */
describe('ISOLATED_RUN_ADMISSION_PROVIDERS — the lease binding reports run_admitted (APW-08 T43)', () => {
    const leaseFactory = (
        ISOLATED_RUN_ADMISSION_PROVIDERS.find(
            (provider) =>
                typeof provider === 'object' &&
                'provide' in provider &&
                provider.provide === FLEET_APP_WORK_LEASE_ADMISSION,
        ) as { useFactory: (moduleRef: unknown) => FleetAppWorkLeaseAdmission }
    ).useFactory;

    const input = {
        userId: 'user-1',
        nodeId: 'node-1',
        workId: 'work-app',
        jobId: 'job-1',
        taskId: 'task-1',
    };
    const payload = {
        workId: 'work-app',
        taskId: 'task-1',
        placement: 'fleet' as const,
        containmentPath: 'hardened',
        isolatedHome: true,
        downgraded: false,
    };

    function moduleRefWith(services: { admission?: unknown; telemetry?: unknown }) {
        return {
            get: jest.fn((token: unknown) => {
                if (token === APP_WORK_RUN_ADMISSION && services.admission) return services.admission;
                if (token === AppChangeTelemetry && services.telemetry) return services.telemetry;
                throw new Error('not in this graph');
            }),
        };
    }

    it('emits the admission service payload once, as the owner', async () => {
        const admission = { runAdmittedPayload: jest.fn(async () => payload) };
        const telemetry = { track: jest.fn() };
        await leaseFactory(moduleRefWith({ admission, telemetry })).onLeased!(input);
        expect(admission.runAdmittedPayload).toHaveBeenCalledWith(input);
        expect(telemetry.track).toHaveBeenCalledWith('app.change.run_admitted', payload, 'user-1');
    });

    it('emits nothing without a payload, and nothing (without throwing) when the graph has no telemetry', async () => {
        const telemetry = { track: jest.fn() };
        await leaseFactory(
            moduleRefWith({ admission: { runAdmittedPayload: jest.fn(async () => null) }, telemetry }),
        ).onLeased!(input);
        expect(telemetry.track).not.toHaveBeenCalled();

        const admission = { runAdmittedPayload: jest.fn(async () => payload) };
        await expect(leaseFactory(moduleRefWith({ admission })).onLeased!(input)).resolves.toBeUndefined();
        // Without a sink the payload is not even built.
        expect(admission.runAdmittedPayload).not.toHaveBeenCalled();
    });
});
