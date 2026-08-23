import { CreditsSweepService } from './credits-sweep.service';

/**
 * The daily sweep orchestrator (billing spec FR-23): three passes in a
 * fixed order, each best-effort, one summary back to the cron.
 */
function makeHarness() {
    const calls: string[] = [];
    const creditLedgerService = {
        expireDueCredits: jest.fn(async () => {
            calls.push('expire');
            return { users: 2, buckets: 3, credits: 450 };
        }),
        dispatchDailyGrants: jest.fn(async () => {
            calls.push('daily');
            return { granted: 10, skipped: 4, alreadyGranted: 1, scanned: 15 };
        }),
    };
    const planCreditGrantService = {
        dispatchPlanGrants: jest.fn(async () => {
            calls.push('plan');
            return { scanned: 5, granted: 2, alreadyGranted: 3, notEligible: 0, failed: 0 };
        }),
    };
    const service = new CreditsSweepService(
        creditLedgerService as any,
        planCreditGrantService as any,
    );
    return { service, calls, creditLedgerService, planCreditGrantService };
}

describe('CreditsSweepService.runDailySweep', () => {
    it('runs expiries, then daily grants, then plan grants, and returns all three summaries', async () => {
        const { service, calls, creditLedgerService, planCreditGrantService } = makeHarness();
        const now = new Date('2026-09-01T00:05:00Z');

        const summary = await service.runDailySweep(now);

        expect(calls).toEqual(['expire', 'daily', 'plan']);
        expect(creditLedgerService.expireDueCredits).toHaveBeenCalledWith(undefined, now);
        expect(creditLedgerService.dispatchDailyGrants).toHaveBeenCalledWith(now);
        expect(planCreditGrantService.dispatchPlanGrants).toHaveBeenCalledWith(now);
        expect(summary).toEqual({
            expiry: { users: 2, buckets: 3, credits: 450 },
            daily: { granted: 10, skipped: 4, alreadyGranted: 1, scanned: 15 },
            plan: { scanned: 5, granted: 2, alreadyGranted: 3, notEligible: 0, failed: 0 },
        });
    });

    it('a failing pass is logged and the later passes still run', async () => {
        const { service, calls, creditLedgerService } = makeHarness();
        creditLedgerService.expireDueCredits.mockRejectedValueOnce(new Error('boom'));

        const summary = await service.runDailySweep();

        expect(calls).toEqual(['daily', 'plan']);
        expect(summary.expiry).toEqual({ users: 0, buckets: 0, credits: 0 });
        expect(summary.daily.granted).toBe(10);
        expect(summary.plan.granted).toBe(2);
    });
});
