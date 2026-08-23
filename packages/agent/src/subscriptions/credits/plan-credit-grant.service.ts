import { Injectable, Logger } from '@nestjs/common';
import { UserSubscriptionRepository } from '@src/database/repositories/user-subscription.repository';
import { CreditLedgerKind } from '@src/entities/credit-ledger-entry.entity';
import { SubscriptionStatus, type UserSubscription } from '@src/entities/user-subscription.entity';
import { config } from '@src/config';
import { CreditLedgerService } from './credit-ledger.service';

/** The allowance month a moment falls in, relative to the subscription anchor. */
export interface AllowancePeriod {
    /** Inclusive start (UTC). */
    start: Date;
    /** Exclusive end (UTC) — also the grant's `expiresAt`. */
    end: Date;
    /** 0 for the first allowance month, 1 for the second, … */
    index: number;
}

export type PlanGrantOutcome =
    /** A `grant` row was written for the current allowance month. */
    | 'granted'
    /** The current allowance month was already granted (idempotent). */
    | 'already-granted'
    /** No active cloud subscription with a monthly allowance. */
    | 'not-eligible';

export interface PlanGrantSummary {
    scanned: number;
    granted: number;
    alreadyGranted: number;
    notEligible: number;
    failed: number;
}

/** `refType` stamped on plan-allowance grant rows. */
export const PLAN_GRANT_REF_TYPE = 'plan-allowance';

/**
 * Monthly plan-allowance grants (billing spec §3.2, FR-4/FR-5).
 *
 * Every active CLOUD subscription whose plan carries `monthlyCredits > 0`
 * receives that many credits once per **allowance month** — a month
 * anchored on the subscription's start, not the calendar — as a `grant`
 * bucket that expires at the end of the allowance month. The two
 * writers (checkout activation and the daily sweep) share one
 * idempotency key per (user, allowance month), so whichever runs first
 * wins and the other is a no-op.
 *
 * Annual subscriptions therefore receive twelve monthly grants, not a
 * year's worth at once — matching how the allowance is described on the
 * plan ("3,000 credits / month") and limiting the amount that can be
 * front-loaded.
 *
 * Self-hosted plan rows never grant here: a licence applies to the
 * buyer's own deployment, and `PlanSubscriptionService.activate` never
 * writes a `user_subscriptions` row for them anyway.
 */
@Injectable()
export class PlanCreditGrantService {
    private readonly logger = new Logger(PlanCreditGrantService.name);

    constructor(
        private readonly creditLedgerService: CreditLedgerService,
        private readonly userSubscriptionRepository: UserSubscriptionRepository,
    ) {}

    /**
     * The allowance month `now` falls in for a subscription anchored at
     * `anchor`. Pure month arithmetic in UTC: the start keeps the
     * anchor's day-of-month, clamped to the target month's length (an
     * anchor on the 31st yields Feb 28/29, then Mar 31 again — each
     * boundary is computed from the anchor, never cumulatively, so the
     * day never drifts backwards for good).
     */
    static allowancePeriodFor(anchor: Date, now: Date): AllowancePeriod {
        const monthsBetween =
            (now.getUTCFullYear() - anchor.getUTCFullYear()) * 12 +
            (now.getUTCMonth() - anchor.getUTCMonth());
        let index = Math.max(0, monthsBetween);
        let start = addMonthsClamped(anchor, index);
        if (start.getTime() > now.getTime()) {
            index = Math.max(0, index - 1);
            start = addMonthsClamped(anchor, index);
        }
        const end = addMonthsClamped(anchor, index + 1);
        return { start, end, index };
    }

    /**
     * Grant the CURRENT allowance month for one user, if they are on an
     * eligible subscription and it has not been granted yet. Called on
     * activation (so the credits show up right after checkout) and by
     * the sweep (renewals, annual plans, missed webhooks).
     */
    async grantCurrentAllowance(userId: string, now: Date = new Date()): Promise<PlanGrantOutcome> {
        const subscription = await this.userSubscriptionRepository.findActiveByUser(userId);
        if (!subscription) return 'not-eligible';
        return this.grantForSubscription(subscription, now);
    }

    /**
     * Daily sweep over every active subscription (RPC target, via
     * `CreditsSweepService`). Bounded batches; per-user failures are
     * logged and never stop the pass.
     */
    async dispatchPlanGrants(now: Date = new Date()): Promise<PlanGrantSummary> {
        const summary: PlanGrantSummary = {
            scanned: 0,
            granted: 0,
            alreadyGranted: 0,
            notEligible: 0,
            failed: 0,
        };
        const batchSize = config.billing.credits.getDailyGrantBatchSize();
        for (let skip = 0; ; skip += batchSize) {
            const rows = await this.userSubscriptionRepository.findActiveBatch(skip, batchSize);
            if (rows.length === 0) break;
            for (const row of rows) {
                summary.scanned += 1;
                try {
                    const outcome = await this.grantForSubscription(row, now);
                    if (outcome === 'granted') summary.granted += 1;
                    else if (outcome === 'already-granted') summary.alreadyGranted += 1;
                    else summary.notEligible += 1;
                } catch (error) {
                    summary.failed += 1;
                    this.logger.warn(
                        `Plan allowance grant failed for user ${row.userId}: ${
                            (error as Error).message
                        }`,
                    );
                }
            }
            if (rows.length < batchSize) break;
        }
        return summary;
    }

    private async grantForSubscription(
        subscription: UserSubscription,
        now: Date,
    ): Promise<PlanGrantOutcome> {
        if (subscription.status !== SubscriptionStatus.ACTIVE) return 'not-eligible';
        const plan = subscription.plan;
        const monthlyCredits = Number(plan?.monthlyCredits ?? 0);
        if (!plan || !Number.isFinite(monthlyCredits) || monthlyCredits <= 0) {
            return 'not-eligible';
        }
        if (plan.hosting && plan.hosting !== 'cloud') return 'not-eligible';

        const anchor = subscription.createdAt ?? now;
        const period = PlanCreditGrantService.allowancePeriodFor(anchor, now);
        const periodKey = period.start.toISOString().slice(0, 10);
        const idempotencyKey = `grant:plan:${subscription.userId}:${periodKey}`;

        if (await this.creditLedgerService.hasEntry(idempotencyKey)) {
            return 'already-granted';
        }

        const entry = await this.creditLedgerService.record({
            userId: subscription.userId,
            organizationId: subscription.organizationId ?? null,
            tenantId: subscription.tenantId ?? null,
            kind: CreditLedgerKind.GRANT,
            amountCredits: Math.trunc(monthlyCredits),
            refType: PLAN_GRANT_REF_TYPE,
            refId: subscription.id,
            description: `${plan.displayName} plan — monthly credits (${periodKey} → ${period.end
                .toISOString()
                .slice(0, 10)})`,
            idempotencyKey,
            expiresAt: period.end,
            now,
        });
        return entry ? 'granted' : 'not-eligible';
    }
}

/** Add `months` to `anchor` in UTC, clamping the day to the target month. */
export function addMonthsClamped(anchor: Date, months: number): Date {
    const year = anchor.getUTCFullYear();
    const month = anchor.getUTCMonth() + months;
    const targetYear = year + Math.floor(month / 12);
    const targetMonth = ((month % 12) + 12) % 12;
    const daysInTarget = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
    const day = Math.min(anchor.getUTCDate(), daysInTarget);
    return new Date(
        Date.UTC(
            targetYear,
            targetMonth,
            day,
            anchor.getUTCHours(),
            anchor.getUTCMinutes(),
            anchor.getUTCSeconds(),
            anchor.getUTCMilliseconds(),
        ),
    );
}
