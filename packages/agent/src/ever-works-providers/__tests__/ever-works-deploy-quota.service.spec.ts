import { EverWorksDeployQuotaService } from '../ever-works-deploy-quota.service';
import { EverWorksDeployQuotaExceededError, type EverWorksDeployQuotaCounter } from '../types';

function mkCounter(count: number): EverWorksDeployQuotaCounter {
    return {
        countActiveDeploys: jest.fn().mockResolvedValue(count),
    };
}

describe('EverWorksDeployQuotaService', () => {
    const ORIGINAL_ENV = { ...process.env };

    afterEach(() => {
        process.env = { ...ORIGINAL_ENV };
    });

    describe('getLimit', () => {
        it('defaults to 3 when the env var is missing or invalid', () => {
            delete process.env.EVER_WORKS_DEPLOY_MAX_WORKS_PER_USER;
            const svc = new EverWorksDeployQuotaService(mkCounter(0));
            expect(svc.getLimit()).toBe(3);

            process.env.EVER_WORKS_DEPLOY_MAX_WORKS_PER_USER = '-5';
            expect(svc.getLimit()).toBe(3);

            process.env.EVER_WORKS_DEPLOY_MAX_WORKS_PER_USER = 'not-a-number';
            expect(svc.getLimit()).toBe(3);
        });

        it('reads the env override when valid', () => {
            process.env.EVER_WORKS_DEPLOY_MAX_WORKS_PER_USER = '10';
            const svc = new EverWorksDeployQuotaService(mkCounter(0));
            expect(svc.getLimit()).toBe(10);
        });
    });

    describe('assertWithinQuota', () => {
        it('resolves silently when count < limit', async () => {
            process.env.EVER_WORKS_DEPLOY_MAX_WORKS_PER_USER = '3';
            const counter = mkCounter(2);
            const svc = new EverWorksDeployQuotaService(counter);
            await svc.assertWithinQuota('user-1');
            expect(counter.countActiveDeploys).toHaveBeenCalledWith('user-1');
        });

        it('throws EverWorksDeployQuotaExceededError when count === limit', async () => {
            process.env.EVER_WORKS_DEPLOY_MAX_WORKS_PER_USER = '3';
            const svc = new EverWorksDeployQuotaService(mkCounter(3));
            let caught: unknown;
            try {
                await svc.assertWithinQuota('user-1');
            } catch (e) {
                caught = e;
            }
            expect(caught).toBeInstanceOf(EverWorksDeployQuotaExceededError);
            const err = caught as EverWorksDeployQuotaExceededError;
            expect(err.code).toBe('quota_exceeded');
            expect(err.currentCount).toBe(3);
            expect(err.limit).toBe(3);
        });

        it('throws EverWorksDeployQuotaExceededError when count > limit', async () => {
            process.env.EVER_WORKS_DEPLOY_MAX_WORKS_PER_USER = '3';
            const svc = new EverWorksDeployQuotaService(mkCounter(5));
            await expect(svc.assertWithinQuota('user-1')).rejects.toBeInstanceOf(
                EverWorksDeployQuotaExceededError,
            );
        });

        it('resolves silently when no counter is wired up', async () => {
            const svc = new EverWorksDeployQuotaService(null);
            await expect(svc.assertWithinQuota('user-1')).resolves.toBeUndefined();
        });
    });
});
