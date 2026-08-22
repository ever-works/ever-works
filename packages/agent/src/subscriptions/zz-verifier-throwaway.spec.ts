import { ForbiddenException } from '@nestjs/common';
import { SubscriptionService } from './subscription.service';
import { SubscriptionPlanCode } from '@src/entities/types';

/** Throwaway adversarial-verification spec. Not committed. */
describe('VERIFY: selfhosted_community self-service escalation', () => {
    const originalEnv = process.env;
    beforeEach(() => {
        process.env = { ...originalEnv, SUBSCRIPTIONS_ENABLED: 'true', NODE_ENV: 'production' };
        delete process.env.SUBSCRIPTIONS_ALLOW_SELF_SERVE_PAID;
    });
    afterAll(() => {
        process.env = originalEnv;
    });

    async function seededRows() {
        const planRepository = { upsert: jest.fn().mockResolvedValue(undefined), findByCode: jest.fn() };
        const svc = new SubscriptionService(planRepository as any, {} as any, {} as any);
        await svc.seedPlans();
        return planRepository.upsert.mock.calls.map((c) => c[0]);
    }

    it('prints the real seeded catalog (price vs maxWorks)', async () => {
        const rows = await seededRows();
        // eslint-disable-next-line no-console
        console.log(
            rows.map((r: any) => `${r.code}\thosting=${r.hosting}\tmonthly=$${r.monthlyPrice}\tmaxWorks=${r.maxWorks}\tcadences=${r.allowedCadences.length}`).join('\n'),
        );
        expect(rows).toHaveLength(6);
    });

    it('a plain authenticated user can self-grant selfhosted_community (free + unlimited) in NODE_ENV=production', async () => {
        const rows = await seededRows();
        const community: any = rows.find((r: any) => r.code === SubscriptionPlanCode.SELFHOSTED_COMMUNITY);
        const premium: any = rows.find((r: any) => r.code === SubscriptionPlanCode.PREMIUM);
        const row = { id: 'plan-community', ...community };

        const userRepository = { update: jest.fn().mockResolvedValue(undefined) };
        const planRepository = { upsert: jest.fn(), findByCode: jest.fn().mockResolvedValue(row) };
        const service = new SubscriptionService(planRepository as any, {} as any, userRepository as any);

        const user: any = { id: 'attacker-1' };
        const granted = await service.changePlanSelfService(user, SubscriptionPlanCode.SELFHOSTED_COMMUNITY);

        expect(userRepository.update).toHaveBeenCalledWith('attacker-1', { defaultPlanId: 'plan-community' });
        expect(granted.maxWorks).toBe(2_147_483_647);
        expect(Number(granted.monthlyPrice)).toBe(0);
        // eslint-disable-next-line no-console
        console.log(
            `GRANTED ${granted.code} maxWorks=${granted.maxWorks} for $${granted.monthlyPrice}/mo; ` +
                `premium(${premium.code}) is maxWorks=${premium.maxWorks} at $${premium.monthlyPrice}/mo`,
        );
    });

    it('control: the same call for PREMIUM is still rejected 403', async () => {
        const rows = await seededRows();
        const premium: any = rows.find((r: any) => r.code === SubscriptionPlanCode.PREMIUM);
        const userRepository = { update: jest.fn() };
        const planRepository = { upsert: jest.fn(), findByCode: jest.fn().mockResolvedValue({ id: 'p', ...premium }) };
        const service = new SubscriptionService(planRepository as any, {} as any, userRepository as any);
        await expect(
            service.changePlanSelfService({ id: 'u' } as any, SubscriptionPlanCode.PREMIUM),
        ).rejects.toThrow(ForbiddenException);
        expect(userRepository.update).not.toHaveBeenCalled();
    });

    it('work-schedule gate arithmetic: 2,147,483,646 active works still passes the limit check', async () => {
        const rows = await seededRows();
        const community: any = rows.find((r: any) => r.code === SubscriptionPlanCode.SELFHOSTED_COMMUNITY);
        const activeScheduleCount = 2_147_483_646;
        expect(activeScheduleCount >= community.maxWorks).toBe(false); // i.e. NOT blocked
        expect(1 >= 1).toBe(true); // control: FREE plan (maxWorks 1) blocks the 2nd work
    });
});
