import { describe, expect, it, vi, beforeEach } from 'vitest';
import { WorkScheduleBillingMode } from '@/lib/api/enums';

const updateWorkSchedule = vi.fn(async () => ({ success: true, message: 'ok' }));

vi.mock('@/app/actions/dashboard/work-schedule', () => ({
    updateWorkSchedule: (...args: unknown[]) => updateWorkSchedule(...(args as [])),
    runWorkSchedule: vi.fn(),
    cancelWorkSchedule: vi.fn(),
}));

/**
 * The assistant must not pick a billing mode the user never chose.
 *
 * `setSchedule` hardcoded `billingMode: USAGE`, so every schedule created by
 * asking the assistant was silently pay-per-use. That is not a cosmetic
 * mislabel — `billingMode === USAGE` currently skips BOTH entitlement gates:
 *
 *   - `SubscriptionService.requiresUsageBilling` returns false for it, so a
 *     cadence the user's plan does not allow is permitted;
 *   - `WorkScheduleService.validateRunEntitlement` returns true immediately,
 *     so the plan's active-schedule cap is never applied.
 *
 * Both are justified in-code by "assuming they can pay", but
 * `BillingProvider.recordUsageCharge` is a no-op on every provider — nobody
 * ever pays. So the assistant was handing out unmetered capacity.
 *
 * `billingMode` is REQUIRED by the action's Zod schema
 * (`work-schedule.ts:25`), so this cannot be fixed by omitting the field; the
 * value has to be right. This pins it to the entity default
 * (`work-schedule.entity.ts:48`).
 */
describe('setSchedule — billing mode is not silently upgraded', () => {
    beforeEach(() => {
        updateWorkSchedule.mockClear();
    });

    it('sends SUBSCRIPTION, never USAGE', async () => {
        const { setSchedule } = await import('./schedule.tools');
        await (setSchedule as unknown as {
            execute: (a: Record<string, unknown>) => Promise<unknown>;
        }).execute({ workId: 'w1', enable: true, cadence: 'daily' });

        expect(updateWorkSchedule).toHaveBeenCalledTimes(1);
        const payload = updateWorkSchedule.mock.calls[0]![1] as {
            billingMode: WorkScheduleBillingMode;
        };
        expect(payload.billingMode).toBe(WorkScheduleBillingMode.SUBSCRIPTION);
        expect(payload.billingMode).not.toBe(WorkScheduleBillingMode.USAGE);
    });

    it('holds for every cadence, including the default when none is given', async () => {
        const { setSchedule } = await import('./schedule.tools');
        const exec = (setSchedule as unknown as {
            execute: (a: Record<string, unknown>) => Promise<unknown>;
        }).execute;

        for (const cadence of ['hourly', 'daily', 'weekly', 'monthly', undefined]) {
            updateWorkSchedule.mockClear();
            await exec({ workId: 'w1', enable: true, cadence });
            const payload = updateWorkSchedule.mock.calls[0]![1] as {
                billingMode: WorkScheduleBillingMode;
            };
            expect(payload.billingMode).toBe(WorkScheduleBillingMode.SUBSCRIPTION);
        }
    });
});
