import { PlanRunLimitsService } from './plan-run-limits.service';

/**
 * `PlanRunLimitsService` is the only production implementation of the
 * `RUN_PLAN_LIMITS` seam — it is what turns a plan entitlement into the number
 * the dispatch gate enforces. It shipped with no tests at all, and the seam it
 * feeds is a three-valued contract that a single wrong fallback collapses:
 *
 *   null     the plan has no opinion; the env valves apply unchanged
 *   negative unlimited
 *   positive a real ceiling, applied raise-only
 *
 * The first version passed `0` as the "no row" fallback, and the consumer reads
 * `0`-and-below as "valve off" — so a plan with no entitlement row escaped the
 * org valve entirely instead of falling back to it. These pin the contract at
 * the producer end so the two cannot drift apart again.
 */

function build(
    overrides: { entitlements?: Record<string, jest.Mock>; users?: Record<string, jest.Mock> } = {},
) {
    const entitlementsService = {
        get: jest.fn().mockResolvedValue(null),
        getNumber: jest.fn(),
        clearCache: jest.fn(),
        ...(overrides.entitlements ?? {}),
    };
    const userRepository = {
        findByIdForScheduledRun: jest
            .fn()
            .mockResolvedValue({ id: 'u1', defaultPlan: { code: 'standard' } }),
        ...(overrides.users ?? {}),
    };
    const service = new PlanRunLimitsService(userRepository as never, entitlementsService as never);
    return { service, entitlementsService, userRepository };
}

describe('PlanRunLimitsService', () => {
    describe('the three-valued contract', () => {
        it('returns null when the plan has NO entitlement row', async () => {
            // The whole point: "absent" must not arrive at the gate as a number.
            const { service, entitlementsService } = build({
                entitlements: { get: jest.fn().mockResolvedValue(null) },
            });

            await expect(service.resolveConcurrencyLimit('u1')).resolves.toBeNull();
            // It must ask with a null fallback, or it cannot tell absent from zero.
            expect(entitlementsService.get).toHaveBeenCalledWith(
                'standard',
                'max-concurrent-runs',
                null,
            );
        });

        it('preserves a stored 0 as 0, distinct from absent', async () => {
            // An operator writing 0 means "no plan ceiling"; the gate keeps the env
            // valve. If this ever came back as null the meaning would be the same
            // today, but the two must stay separable — one is a decision.
            const { service } = build({ entitlements: { get: jest.fn().mockResolvedValue(0) } });

            await expect(service.resolveConcurrencyLimit('u1')).resolves.toBe(0);
        });

        it('passes the unlimited sentinel through unchanged', async () => {
            const { service } = build({ entitlements: { get: jest.fn().mockResolvedValue(-1) } });

            await expect(service.resolveConcurrencyLimit('u1')).resolves.toBe(-1);
        });

        it('returns a real ceiling as a number', async () => {
            const { service } = build({ entitlements: { get: jest.fn().mockResolvedValue(10) } });

            await expect(service.resolveConcurrencyLimit('u1')).resolves.toBe(10);
        });

        it('coerces a numeric string, and rejects a non-numeric one as null', async () => {
            // `valueText` can hold anything; the column is a varchar.
            const asText = build({ entitlements: { get: jest.fn().mockResolvedValue('10') } });
            await expect(asText.service.resolveConcurrencyLimit('u1')).resolves.toBe(10);

            const garbage = build({ entitlements: { get: jest.fn().mockResolvedValue('lots') } });
            await expect(garbage.service.resolveConcurrencyLimit('u1')).resolves.toBeNull();
        });
    });

    describe('failure posture', () => {
        it('never throws — a broken lookup resolves to "no plan opinion"', async () => {
            // The middleware fails open too, so this is belt-and-braces. A DB blip
            // must not become a fleet-wide dispatch decision.
            const { service } = build({
                users: {
                    findByIdForScheduledRun: jest.fn().mockRejectedValue(new Error('db down')),
                },
            });

            await expect(service.resolveConcurrencyLimit('u1')).resolves.toBeNull();
        });
    });

    describe('the userId -> planCode cache', () => {
        it('reads the user once and serves the second call from cache', async () => {
            const { service, userRepository } = build({
                entitlements: { get: jest.fn().mockResolvedValue(10) },
            });

            await service.resolveConcurrencyLimit('u1');
            await service.resolveConcurrencyLimit('u1');

            expect(userRepository.findByIdForScheduledRun).toHaveBeenCalledTimes(1);
        });

        it('re-reads after clearCache()', async () => {
            const { service, userRepository } = build({
                entitlements: { get: jest.fn().mockResolvedValue(10) },
            });

            await service.resolveConcurrencyLimit('u1');
            service.clearCache();
            await service.resolveConcurrencyLimit('u1');

            expect(userRepository.findByIdForScheduledRun).toHaveBeenCalledTimes(2);
        });

        it('falls back to the configured default plan when the user has none', async () => {
            const { service, entitlementsService } = build({
                users: { findByIdForScheduledRun: jest.fn().mockResolvedValue({ id: 'u1' }) },
                entitlements: { get: jest.fn().mockResolvedValue(null) },
            });

            await service.resolveConcurrencyLimit('u1');

            expect(entitlementsService.get).toHaveBeenCalledWith(
                'free',
                'max-concurrent-runs',
                null,
            );
        });
    });
});
