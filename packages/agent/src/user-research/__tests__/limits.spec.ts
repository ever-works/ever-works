import {
    DEFAULT_USER_RESEARCH_LIMITS,
    UserResearchLimitsService,
    UserResearchRateLimitedError,
} from '../limits';
import { Test } from '@nestjs/testing';

describe('UserResearchLimitsService', () => {
    let svc: UserResearchLimitsService;

    beforeEach(() => {
        svc = new UserResearchLimitsService(undefined, { ...DEFAULT_USER_RESEARCH_LIMITS });
    });

    it('starts at 0 for an unseen user', async () => {
        await expect(svc.assertCanRun('u1')).resolves.toBeUndefined();
        await expect(svc.assertSearchAllowed('u1')).resolves.toBeUndefined();
        await expect(svc.assertFetchAllowed('u1')).resolves.toBeUndefined();
    });

    it('can be instantiated by Nest without an explicit limits config provider', async () => {
        const moduleRef = await Test.createTestingModule({
            providers: [UserResearchLimitsService],
        }).compile();

        expect(moduleRef.get(UserResearchLimitsService)).toBeInstanceOf(UserResearchLimitsService);
    });

    it('counts run increments and trips the per-day cap', async () => {
        for (let i = 0; i < DEFAULT_USER_RESEARCH_LIMITS.maxRunsPerDay; i++) {
            await svc.assertCanRun('u1');
            await svc.incrementRuns('u1');
        }
        await expect(svc.assertCanRun('u1')).rejects.toBeInstanceOf(UserResearchRateLimitedError);
    });

    it('canRun mirrors assertCanRun without throwing', async () => {
        await expect(svc.canRun('u1')).resolves.toBe(true);
        for (let i = 0; i < DEFAULT_USER_RESEARCH_LIMITS.maxRunsPerDay; i++) {
            await svc.incrementRuns('u1');
        }
        await expect(svc.canRun('u1')).resolves.toBe(false);
    });

    it('isolates counters between users', async () => {
        for (let i = 0; i < DEFAULT_USER_RESEARCH_LIMITS.maxRunsPerDay; i++) {
            await svc.incrementRuns('u1');
        }
        await expect(svc.assertCanRun('u2')).resolves.toBeUndefined();
    });

    it('counts search increments', async () => {
        const cap = DEFAULT_USER_RESEARCH_LIMITS.maxSearchesPerDay;
        for (let i = 0; i < cap; i++) {
            await svc.incrementSearches('u1');
        }
        await expect(svc.assertSearchAllowed('u1')).rejects.toThrow(UserResearchRateLimitedError);
    });

    it('counts fetch increments', async () => {
        const cap = DEFAULT_USER_RESEARCH_LIMITS.maxFetchesPerDay;
        for (let i = 0; i < cap; i++) {
            await svc.incrementFetches('u1');
        }
        await expect(svc.assertFetchAllowed('u1')).rejects.toThrow(UserResearchRateLimitedError);
    });

    it('accumulates tokens with custom deltas', async () => {
        expect(await svc.addTokens('u1', 1_000)).toBe(1_000);
        expect(await svc.addTokens('u1', 500)).toBe(1_500);
    });
});
