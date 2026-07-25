import { EntitlementsService, ENTITLEMENT_KEYS } from './entitlements.service';

/**
 * EntitlementsService resolves per-plan levers from `plan_entitlements`
 * rows (planId = plan CODE) through a small in-memory TTL cache. A
 * missing row is never an error — it resolves to the caller-supplied
 * fallback, which is what makes entitlements safely additive.
 */

function makeRepository(overrides: Record<string, jest.Mock> = {}) {
    return {
        findByPlanAndKey: jest.fn().mockResolvedValue(null),
        findByPlan: jest.fn().mockResolvedValue([]),
        upsert: jest.fn(),
        ...overrides,
    };
}

describe('EntitlementsService', () => {
    const originalEnv = process.env;
    let nowSpy: jest.SpyInstance<number, []>;

    beforeEach(() => {
        process.env = { ...originalEnv };
        delete process.env.CREDITS_ENTITLEMENTS_CACHE_TTL_MS;
        nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    });

    afterEach(() => {
        nowSpy.mockRestore();
    });

    afterAll(() => {
        process.env = originalEnv;
    });

    it('returns valueInt when the row defines one', async () => {
        const repository = makeRepository({
            findByPlanAndKey: jest
                .fn()
                .mockResolvedValue({ planId: 'free', key: 'daily-free-credits', valueInt: 75 }),
        });
        const service = new EntitlementsService(repository as any);

        expect(await service.get('free', ENTITLEMENT_KEYS.DAILY_FREE_CREDITS, 50)).toBe(75);
    });

    it('falls back to valueText when valueInt is null', async () => {
        const repository = makeRepository({
            findByPlanAndKey: jest.fn().mockResolvedValue({
                planId: 'premium',
                key: 'transcript-retention',
                valueInt: null,
                valueText: 'forever',
            }),
        });
        const service = new EntitlementsService(repository as any);

        expect(await service.get('premium', 'transcript-retention', 'bounded')).toBe('forever');
    });

    it('resolves to the fallback when no row exists (entitlements are additive)', async () => {
        const repository = makeRepository();
        const service = new EntitlementsService(repository as any);

        expect(await service.get('free', 'unknown-lever', 7)).toBe(7);
        expect(await service.get('free', 'unknown-lever', null)).toBeNull();
    });

    it('caches within the TTL and refetches after expiry', async () => {
        const repository = makeRepository({
            findByPlanAndKey: jest
                .fn()
                .mockResolvedValue({ planId: 'free', key: 'works-limit', valueInt: 1 }),
        });
        const service = new EntitlementsService(repository as any);

        await service.get('free', ENTITLEMENT_KEYS.WORKS_LIMIT, 0);
        await service.get('free', ENTITLEMENT_KEYS.WORKS_LIMIT, 0);
        expect(repository.findByPlanAndKey).toHaveBeenCalledTimes(1);

        // Past the default 60s TTL → the slot is stale, repo hit again.
        nowSpy.mockReturnValue(1_000_000 + 60_001);
        await service.get('free', ENTITLEMENT_KEYS.WORKS_LIMIT, 0);
        expect(repository.findByPlanAndKey).toHaveBeenCalledTimes(2);
    });

    it('honours CREDITS_ENTITLEMENTS_CACHE_TTL_MS and clearCache()', async () => {
        process.env.CREDITS_ENTITLEMENTS_CACHE_TTL_MS = '5';
        const repository = makeRepository({
            findByPlanAndKey: jest
                .fn()
                .mockResolvedValue({ planId: 'free', key: 'max-concurrent-runs', valueInt: 3 }),
        });
        const service = new EntitlementsService(repository as any);

        await service.get('free', ENTITLEMENT_KEYS.MAX_CONCURRENT_RUNS, 0);
        nowSpy.mockReturnValue(1_000_006);
        await service.get('free', ENTITLEMENT_KEYS.MAX_CONCURRENT_RUNS, 0);
        expect(repository.findByPlanAndKey).toHaveBeenCalledTimes(2);

        service.clearCache();
        await service.get('free', ENTITLEMENT_KEYS.MAX_CONCURRENT_RUNS, 0);
        expect(repository.findByPlanAndKey).toHaveBeenCalledTimes(3);
    });

    it('getNumber coerces text values and falls back on non-numeric ones', async () => {
        const repository = makeRepository({
            findByPlanAndKey: jest
                .fn()
                .mockResolvedValueOnce({ planId: 'p', key: 'k', valueInt: null, valueText: '12' })
                .mockResolvedValueOnce({
                    planId: 'p',
                    key: 'k2',
                    valueInt: null,
                    valueText: 'nope',
                }),
        });
        const service = new EntitlementsService(repository as any);

        expect(await service.getNumber('p', 'k', 1)).toBe(12);
        expect(await service.getNumber('p', 'k2', 1)).toBe(1);
    });
});
