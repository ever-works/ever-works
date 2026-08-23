import { Injectable, Logger } from '@nestjs/common';
import {
    CreditLedgerService,
    type DailyGrantSummary,
    type ExpirySweepSummary,
} from './credit-ledger.service';
import { PlanCreditGrantService, type PlanGrantSummary } from './plan-credit-grant.service';

export interface DailySweepSummary {
    expiry: ExpirySweepSummary;
    daily: DailyGrantSummary;
    plan: PlanGrantSummary;
}

/**
 * The one RPC target of the `credits-daily-grant` cron (billing spec
 * §3.2 / FR-23): three idempotent passes in the order that makes each
 * later pass see the right balance —
 *
 *   1. **expiries** — close every lapsed bucket (`expiry` rows), so
 *   2. **daily free grants** top up against the AVAILABLE balance, and
 *   3. **plan allowance grants** open the new allowance month's bucket.
 *
 * Each pass is individually idempotent (`expiry:{entryId}`,
 * `daily:{userId}:{date}`, `grant:plan:{userId}:{monthStart}`), so a
 * retried or duplicated cron tick writes nothing twice. A failing pass
 * is logged and the next one still runs — the sweep is best-effort per
 * pass, never all-or-nothing.
 */
@Injectable()
export class CreditsSweepService {
    private readonly logger = new Logger(CreditsSweepService.name);

    constructor(
        private readonly creditLedgerService: CreditLedgerService,
        private readonly planCreditGrantService: PlanCreditGrantService,
    ) {}

    async runDailySweep(now: Date = new Date()): Promise<DailySweepSummary> {
        const summary: DailySweepSummary = {
            expiry: { users: 0, buckets: 0, credits: 0 },
            daily: { granted: 0, skipped: 0, alreadyGranted: 0, scanned: 0 },
            plan: { scanned: 0, granted: 0, alreadyGranted: 0, notEligible: 0, failed: 0 },
        };
        try {
            summary.expiry = await this.creditLedgerService.expireDueCredits(undefined, now);
        } catch (error) {
            this.logger.warn(`Credits sweep: expiry pass failed: ${(error as Error).message}`);
        }
        try {
            summary.daily = await this.creditLedgerService.dispatchDailyGrants(now);
        } catch (error) {
            this.logger.warn(`Credits sweep: daily-grant pass failed: ${(error as Error).message}`);
        }
        try {
            summary.plan = await this.planCreditGrantService.dispatchPlanGrants(now);
        } catch (error) {
            this.logger.warn(`Credits sweep: plan-grant pass failed: ${(error as Error).message}`);
        }
        return summary;
    }
}
