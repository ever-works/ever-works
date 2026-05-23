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

    it('builds max runs config from environment variables', () => {
        process.env.USER_RESEARCH_MAX_RUNS_PER_DAY = '8';

        expect(buildUserResearchLimitsConfig()).toEqual({
            ...DEFAULT_USER_RESEARCH_LIMITS,
            maxRunsPerDay: 8,
        });
    });

    it('falls back to defaults for invalid max runs values', () => {
        process.env.USER_RESEARCH_MAX_RUNS_PER_DAY = '0';

        expect(buildUserResearchLimitsConfig()).toEqual(DEFAULT_USER_RESEARCH_LIMITS);
    });

    it('starts at 0 for an unseen user', async () => {
        await expect(svc.assertCanRun('u1')).resolves.toBeUndefined();
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
});
