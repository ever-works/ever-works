import {
    buildUserResearchLimitsConfig,
    DEFAULT_USER_RESEARCH_LIMITS,
    UserResearchLimitsService,
    UserResearchRateLimitedError,
} from '../limits';
import { Test } from '@nestjs/testing';

describe('UserResearchLimitsService', () => {
    const originalEnv = process.env;
    let svc: UserResearchLimitsService;

    beforeEach(() => {
        process.env = { ...originalEnv };
        svc = new UserResearchLimitsService(undefined, { ...DEFAULT_USER_RESEARCH_LIMITS });
    });

    afterEach(() => {
        process.env = originalEnv;
    });

    it('builds limits config from environment variables', () => {
        process.env.USER_RESEARCH_MAX_RUNS_PER_DAY = '8';
        process.env.USER_RESEARCH_MAX_SEARCHES_PER_DAY = '80';
        process.env.USER_RESEARCH_MAX_FETCHES_PER_DAY = '24';
        process.env.USER_RESEARCH_MAX_TOKENS_PER_DAY = '500000';

        expect(buildUserResearchLimitsConfig()).toEqual({
            maxRunsPerDay: 8,
            maxSearchesPerDay: 80,
            maxFetchesPerDay: 24,
            maxTokensPerDay: 500_000,
        });
    });

    it('falls back to defaults for invalid environment values', () => {
        process.env.USER_RESEARCH_MAX_RUNS_PER_DAY = '0';
        process.env.USER_RESEARCH_MAX_SEARCHES_PER_DAY = '-1';
        process.env.USER_RESEARCH_MAX_FETCHES_PER_DAY = 'abc';
        process.env.USER_RESEARCH_MAX_TOKENS_PER_DAY = '1.5';

        expect(buildUserResearchLimitsConfig()).toEqual(DEFAULT_USER_RESEARCH_LIMITS);
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
