import { Injectable, Logger } from '@nestjs/common';
import {
    CreditLedgerQuery,
    CreditLedgerRepository,
    CreditLedgerWrite,
} from '@src/database/repositories/credit-ledger.repository';
import { UserRepository } from '@src/database/repositories/user.repository';
import { UserSubscriptionRepository } from '@src/database/repositories/user-subscription.repository';
import { BillingProfileRepository } from '@src/database/repositories/billing-profile.repository';
import { isPastDueSubscriptionStatus } from '@src/entities/billing-profile.entity';
import { CreditLedgerEntry, CreditLedgerKind } from '@src/entities/credit-ledger-entry.entity';
import type { SubscriptionPlan } from '@src/entities/subscription-plan.entity';
import type { ClassToObject } from '@src/entities/types';
import { config } from '@src/config';
import { ENTITLEMENT_KEYS, EntitlementsService } from './entitlements.service';

/**
 * A debit was rejected because it would take the balance below zero and
 * overdraft is off (`CREDITS_ALLOW_OVERDRAFT`, default false). Stable
 * `name` so the API boundary can map it to a distinct 4xx (billing PRD
 * §6: balance exhaustion must never surface as an unmapped 500).
 */
export class InsufficientCreditsError extends Error {
    constructor(
        public readonly userId: string,
        public readonly requestedCredits: number,
        public readonly balanceCredits: number,
    ) {
        super(
            `Insufficient credits: balance ${balanceCredits}, requested debit ${requestedCredits}`,
        );
        this.name = 'InsufficientCreditsError';
    }
}

export interface RecordCreditEntryOptions {
    userId: string;
    kind: CreditLedgerKind;
    /** Signed integer: positive = credit, negative = debit. */
    amountCredits: number;
    organizationId?: string | null;
    tenantId?: string | null;
    costCentsRef?: number | null;
    refType?: string | null;
    refId?: string | null;
    description?: string | null;
    /** Re-running with the same key returns the existing row (no write). */
    idempotencyKey?: string | null;
    /** Per-call overdraft override; defaults to `CREDITS_ALLOW_OVERDRAFT`. */
    allowNegativeBalance?: boolean;
    /** Ceiling for non-accumulating grants; a full clamp returns null. */
    maxBalanceAfter?: number | null;
}

export interface CreditLedgerListOptions {
    /** Calendar month `YYYY-MM` (matches the existing usage controllers). */
    period?: string;
    kinds?: CreditLedgerKind[];
    page?: number;
    pageSize?: number;
}

export interface ConsumeForRunOptions {
    userId: string;
    runId: string;
    /** Metered spend from the costCents pipeline (`plugin_usage_events`). */
    costCents: number;
    /** Explicit debit override; computed from costCents when omitted. */
    credits?: number;
    organizationId?: string | null;
    tenantId?: string | null;
    description?: string | null;
}

export interface DailyGrantSummary {
    /** Users that received a (possibly clamped) grant this run. */
    granted: number;
    /** Users skipped: balance at/above the level, or a zero entitlement. */
    skipped: number;
    /** Users whose grant already existed (cron re-run — idempotent). */
    alreadyGranted: number;
    /** Users scanned. */
    scanned: number;
    /**
     * Users whose grant threw. A SUBSET of `skipped` (which has always
     * lumped failures in with healthy no-ops) - reported separately so a
     * systematic failure is visible instead of looking like a quiet run.
     */
    failed: number;
    /** Users that received a monthly plan allowance (or a top-up) this run. */
    monthlyGranted: number;
    /** Users whose monthly allowance for this period already existed. */
    monthlyAlreadyGranted: number;
    /**
     * Users whose MONTHLY grant threw. Counted for exactly the same reason as
     * {@link failed}: without it, a sweep in which every paying subscriber
     * failed to be paid is byte-identical to a healthy one.
     */
    monthlyFailed: number;
}

/**
 * `refType` stamped on every monthly plan-allowance row. 12 chars, well
 * inside the varchar(32) column. The monthly grant sums prior rows of this
 * type inside the calendar month to work out how much is still owed, so
 * this string is load-bearing - changing it re-grants the full allowance
 * to every user in the current month.
 */
export const MONTHLY_PLAN_REF_TYPE = 'plan-monthly';

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;
const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * Credits ledger writes + reads (pricing Wave 9 M1).
 *
 * Credits are the platform usage currency layered on the EXISTING
 * costCents metering — this service never meters anything itself; it
 * converts already-metered `costCents` into balance movements
 * (`consumeForRun`) and applies grants/purchases/adjustments through
 * one idempotent, transactionally-balanced write path (`record`).
 *
 * Passthrough (P2) and local BYOS (P3) runs never reach this service —
 * they consume no platform credits by decision; their usage events stay
 * visible in the metering pipeline with no CONSUMPTION row.
 */
@Injectable()
export class CreditLedgerService {
    private readonly logger = new Logger(CreditLedgerService.name);

    constructor(
        private readonly creditLedgerRepository: CreditLedgerRepository,
        private readonly entitlementsService: EntitlementsService,
        private readonly userRepository: UserRepository,
        private readonly userSubscriptionRepository: UserSubscriptionRepository,
        private readonly billingProfileRepository: BillingProfileRepository,
    ) {}

    /**
     * Append one balance movement. Idempotent by `idempotencyKey`;
     * `balanceAfter` is computed atomically inside the repository
     * transaction. Debits that would cross zero throw
     * {@link InsufficientCreditsError} unless overdraft is allowed.
     *
     * Returns `null` only when a `maxBalanceAfter` ceiling clamped the
     * grant to nothing (balance already at/above the level).
     */
    async record(options: RecordCreditEntryOptions): Promise<CreditLedgerEntry | null> {
        if (!Number.isInteger(options.amountCredits)) {
            throw new Error(`amountCredits must be an integer, got ${options.amountCredits}`);
        }
        if (options.amountCredits === 0) {
            throw new Error('amountCredits must be non-zero');
        }

        const allowNegative =
            options.allowNegativeBalance ?? config.billing.credits.allowOverdraft();
        const write: CreditLedgerWrite = {
            userId: options.userId,
            organizationId: options.organizationId ?? null,
            tenantId: options.tenantId ?? null,
            kind: options.kind,
            amountCredits: options.amountCredits,
            costCentsRef: options.costCentsRef ?? null,
            refType: options.refType ?? null,
            refId: options.refId ?? null,
            description: options.description ?? null,
            idempotencyKey: options.idempotencyKey ?? null,
        };

        const result = await this.creditLedgerRepository.recordAtomic(write, {
            minBalanceAfter: options.amountCredits < 0 && !allowNegative ? 0 : null,
            maxBalanceAfter: options.maxBalanceAfter ?? null,
        });

        switch (result.status) {
            case 'created':
            case 'idempotent':
                return result.entry;
            case 'skipped':
                return null;
            case 'insufficient':
                throw new InsufficientCreditsError(
                    options.userId,
                    Math.abs(options.amountCredits),
                    result.balance,
                );
        }
    }

    /** Authoritative balance: SUM of all signed movements for the user. */
    async getBalance(userId: string): Promise<number> {
        return this.creditLedgerRepository.getBalance(userId);
    }

    /** Owner-scoped paginated ledger with period + kind filters. */
    async getLedger(
        userId: string,
        options: CreditLedgerListOptions = {},
    ): Promise<{
        entries: CreditLedgerEntry[];
        total: number;
        page: number;
        pageSize: number;
    }> {
        const page = Math.max(1, Math.trunc(options.page ?? 1));
        const pageSize = Math.min(
            MAX_PAGE_SIZE,
            Math.max(1, Math.trunc(options.pageSize ?? DEFAULT_PAGE_SIZE)),
        );

        const query: CreditLedgerQuery = {
            kinds: options.kinds,
            skip: (page - 1) * pageSize,
            take: pageSize,
        };

        if (options.period) {
            if (!PERIOD_RE.test(options.period)) {
                throw new Error(`Invalid period (expected YYYY-MM): ${options.period}`);
            }
            const [year, month] = options.period.split('-').map(Number);
            // UTC month window, driver-agnostic (no DB date functions).
            query.from = new Date(Date.UTC(year, month - 1, 1));
            query.to = new Date(Date.UTC(year, month, 1));
        }

        const { entries, total } = await this.creditLedgerRepository.findForUser(userId, query);
        return { entries, total, page, pageSize };
    }

    /**
     * The bridge from metered run cost to credits: one CONSUMPTION row
     * per run (idempotencyKey `run:{runId}`), amount derived from
     * `costCents × (creditsPerDollar / 100) × (1 + margin%)` and rounded
     * UP so fractional cost never debits zero. Zero-cost runs (the known
     * streaming/embed/transcribe metering gaps record `costCents: 0`)
     * debit nothing and write no row — the ledger never pretends.
     */
    async consumeForRun(options: ConsumeForRunOptions): Promise<CreditLedgerEntry | null> {
        const credits = options.credits ?? this.creditsForCostCents(options.costCents);
        if (!Number.isInteger(credits) || credits < 0) {
            throw new Error(`credits must be a non-negative integer, got ${credits}`);
        }
        if (credits === 0) {
            return null;
        }

        return this.record({
            userId: options.userId,
            organizationId: options.organizationId,
            tenantId: options.tenantId,
            kind: CreditLedgerKind.CONSUMPTION,
            amountCredits: -credits,
            costCentsRef: options.costCents,
            refType: 'agent-run',
            refId: options.runId,
            description: options.description ?? `Run ${options.runId}`,
            idempotencyKey: `run:${options.runId}`,
        });
    }

    /** costCents → whole credits at the configured conversion + margin. */
    creditsForCostCents(costCents: number): number {
        if (!Number.isFinite(costCents) || costCents <= 0) {
            return 0;
        }
        const creditsPerCent = config.billing.credits.getCreditsPerDollar() / 100;
        const margin = 1 + config.billing.credits.getMarginPercent() / 100;
        return Math.ceil(costCents * creditsPerCent * margin);
    }

    /**
     * Daily free-credit sweep (RPC target of the `credits-daily-grant`
     * cron, 00:05 UTC). For every active user whose plan carries the
     * `daily-free-credits` entitlement (> 0), tops the balance back UP TO
     * that level — non-accumulating per the PRD: a balance already at or
     * above the level receives nothing. Idempotency key
     * `daily:{userId}:{date}` makes cron re-runs a no-op.
     */
    async dispatchDailyGrants(now: Date = new Date()): Promise<DailyGrantSummary> {
        const summary: DailyGrantSummary = {
            granted: 0,
            skipped: 0,
            alreadyGranted: 0,
            scanned: 0,
            failed: 0,
            monthlyGranted: 0,
            monthlyAlreadyGranted: 0,
            monthlyFailed: 0,
        };
        const date = now.toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
        const batchSize = config.billing.credits.getDailyGrantBatchSize();
        const defaultPlanCode = config.subscriptions.getDefaultPlanCode();
        const fallbackDailyFree = config.billing.credits.getDailyFreeCredits();

        for (let skip = 0; ; skip += batchSize) {
            const users = await this.userRepository.findActiveBatch(skip, batchSize);
            if (users.length === 0) {
                break;
            }

            for (const user of users) {
                summary.scanned += 1;
                const planCode = (user.defaultPlan?.code as string) || defaultPlanCode;

                const daily = await this.grantDailyCredits(
                    user.id,
                    planCode,
                    date,
                    fallbackDailyFree,
                );
                if (daily === 'granted') {
                    summary.granted += 1;
                } else if (daily === 'already') {
                    summary.alreadyGranted += 1;
                } else if (daily === 'failed') {
                    // Counted separately from `skipped`: a systematic grant
                    // failure used to be byte-identical to a healthy sweep, so
                    // it could re-fail once a day forever with nobody paged.
                    summary.failed += 1;
                    summary.skipped += 1;
                } else {
                    summary.skipped += 1;
                }

                // Deliberately NOT chained to the daily outcome. The daily
                // grant returns early on a zero entitlement and on a cron
                // re-run, and a plan monthly allowance must not inherit
                // either of those exits - they are separate promises.
                const monthly = await this.grantMonthlyPlanCredits(user.id, now);
                if (monthly === 'granted') {
                    summary.monthlyGranted += 1;
                } else if (monthly === 'already') {
                    summary.monthlyAlreadyGranted += 1;
                } else if (monthly === 'failed') {
                    summary.monthlyFailed += 1;
                }
            }
            if (users.length < batchSize) {
                break;
            }
        }

        return summary;
    }
    /**
     * One user daily free credits. Extracted from the sweep so that its
     * early exits cannot swallow the monthly plan allowance.
     *
     * `'skipped'` covers three genuinely different outcomes that the summary
     * has always counted together: a zero entitlement, a ceiling that clamped
     * the grant to nothing, and a per-user failure.
     */
    private async grantDailyCredits(
        userId: string,
        planCode: string,
        date: string,
        fallbackDailyFree: number,
    ): Promise<'granted' | 'already' | 'failed' | 'skipped'> {
        // The advertised daily allowance is universal (the pricing page says
        // "50 free credits/day" on every tier), so the FALLBACK is the same for
        // every plan. A plan that should get none carries an explicit
        // `daily-free-credits` row of 0, which still wins over this fallback
        // because EntitlementsService resolves the stored row with `??`.
        const level = await this.entitlementsService.getNumber(
            planCode,
            ENTITLEMENT_KEYS.DAILY_FREE_CREDITS,
            fallbackDailyFree,
        );
        if (level <= 0) {
            return 'skipped';
        }

        try {
            const idempotencyKey = `daily:${userId}:${date}`;
            const existing = await this.creditLedgerRepository.findByIdempotencyKey(idempotencyKey);
            if (existing) {
                return 'already';
            }

            // 🛑 No `maxBalanceAfter`. It used to top the balance UP TO the
            // daily level, which silently cancels the grant for anyone holding
            // a balance above it - and `sumBalance` sums EVERY kind, purchases
            // included. So the top-up ceiling denied the advertised daily
            // credits to exactly two groups: paid tiers carrying a monthly
            // allowance, and free users who had BOUGHT a credit pack (a $200
            // 25,000-pack buyer would get nothing for ~500 days). Both looked
            // identical in the logs to a healthy topped-up user.
            //
            // Any balance ceiling is unfixable for someone who bought credits,
            // so there is none. The UNIQUE `daily:{userId}:{date}` key already
            // guarantees at most one grant per user per day, which is the only
            // invariant that ever mattered. Accepted consequence: an idle free
            // user accrues without bound. Capping accrual needs lot tracking
            // and expiry, not a ceiling - and this repo has no code that can
            // remove a granted credit, deliberately.
            const entry = await this.record({
                userId,
                kind: CreditLedgerKind.DAILY_FREE,
                amountCredits: level,
                description: `Daily free credits (${date})`,
                idempotencyKey,
            });
            return entry ? 'granted' : 'skipped';
        } catch (error) {
            // Best-effort per user - one failure must not starve the rest of
            // the sweep; the idempotency key retries tomorrow.
            this.logger.warn(`Daily grant failed for user ${userId}: ${(error as Error).message}`);
            return 'failed';
        }
    }

    /**
     * The plan's monthly credit allowance (`subscription_plans.monthlyCredits`).
     *
     * ## What it is keyed to, and why that is the whole design
     *
     * Resolved from the user's CURRENT subscription row, never from
     * `user.defaultPlan`. Two independent reasons, both live today:
     *
     *  - **Dunning.** A failed invoice leaves `defaultPlanId` on the paid tier
     *    for the whole of Stripe's retry window, because the webhook handler
     *    deliberately neither grants nor revokes. A `defaultPlan` reader would
     *    keep paying out 3,000 / 25,000 credits a month for invoices that never
     *    cleared.
     *
     *    🛑 Reading the subscription row is NOT by itself enough to stop that.
     *    `SubscriptionStatus.PAST_DUE` exists in the enum and is never assigned
     *    anywhere — the dunning state is persisted on a different table,
     *    `billing_profiles.subscriptionStatus`. So the grant consults the billing
     *    profile too, and skips while the provider cannot collect.
     *  - **Divergence.** The subscription row is written unconditionally,
     *    while `assignPlanToUser` (the only writer of `defaultPlanId`) is
     *    gated on `SUBSCRIPTIONS_ENABLED`. On a deployment where that flag
     *    is off, a paying customer has an ACTIVE `standard` row and
     *    `defaultPlanId = free` — a `defaultPlan` reader pays them nothing,
     *    forever, and nothing self-heals it.
     *
     * Consequence to state plainly: a plan assigned by an admin with no
     * `user_subscriptions` row receives no monthly credits. That is
     * deliberate — this grant follows money, not tier labels.
     *
     * ## The idempotency key
     *
     * `plan-monthly:{userId}:{subscriptionId}:{monthIndex}:{planCode}`, where
     * `monthIndex` counts whole months elapsed since the subscription's
     * `createdAt` — its billing anniversary, not the calendar. Written as a
     * TOP-UP to the best allowance held inside that anniversary window, so:
     *
     *   - a monthly renewal grants again (the index moves on the anniversary);
     *   - an ANNUAL subscriber still gets twelve grants a year, not one;
     *   - a mid-cycle upgrade grants only the difference (Pro to Enterprise
     *     adds 22,000, not a second 25,000);
     *   - a mid-cycle downgrade writes nothing and removes nothing;
     *   - a cancelled subscription simply stops.
     *
     * 🛑 A CALENDAR-month key looks equivalent and is not: someone who
     * subscribes on the 31st would be granted again hours later on the 1st.
     * Anchoring on the subscription keeps grants and charges in step, and
     * makes it safe to also call this straight from the activation path.
     *
     * Max key length: 13 + 36 + 1 + 36 + 1 + 4 + 1 + 21 = 113 <= varchar(128).
     *
     * Credits ROLL OVER. Nothing in this codebase expires or claws back a
     * granted credit, and this method deliberately does not become the first
     * thing that does.
     */
    private async grantMonthlyPlanCredits(
        userId: string,
        now: Date,
    ): Promise<'granted' | 'already' | 'failed' | 'skipped'> {
        try {
            const subscription = await this.userSubscriptionRepository.findCurrentByUser(userId);
            if (!subscription) {
                return 'skipped';
            }

            const plan = subscription.plan ?? null;
            const allowance = Number(plan?.monthlyCredits ?? 0);
            if (!Number.isInteger(allowance) || allowance <= 0) {
                return 'skipped';
            }

            // The real dunning signal. `user_subscriptions.status` never becomes
            // `past_due` — nothing writes it — so without this a customer whose
            // invoice has been failing for weeks keeps drawing the full monthly
            // allowance. A missing profile is treated as "collecting fine", which
            // is the pre-existing posture everywhere else that reads this state.
            const profile = await this.billingProfileRepository.findByUserId(userId);
            if (isPastDueSubscriptionStatus(profile?.subscriptionStatus)) {
                return 'skipped';
            }

            const anchor = subscription.createdAt;
            if (!(anchor instanceof Date) || Number.isNaN(anchor.getTime())) {
                return 'skipped';
            }
            const monthIndex = elapsedWholeMonths(anchor, now);
            const planCode = String(subscription.planCode ?? plan?.code ?? 'unknown');
            const idempotencyKey = `plan-monthly:${userId}:${subscription.id}:${monthIndex}:${planCode}`;

            const existing = await this.creditLedgerRepository.findByIdempotencyKey(idempotencyKey);
            if (existing) {
                return 'already';
            }

            const from = addWholeMonths(anchor, monthIndex);
            const to = addWholeMonths(anchor, monthIndex + 1);
            const alreadyGrantedThisPeriod = await this.creditLedgerRepository.sumByRefTypeInWindow(
                userId,
                MONTHLY_PLAN_REF_TYPE,
                from,
                to,
            );
            const delta = allowance - alreadyGrantedThisPeriod;
            if (delta <= 0) {
                // A downgrade, or a re-grant under a different plan code in the
                // same period. Never write a zero or negative row.
                return 'skipped';
            }

            const entry = await this.record({
                userId,
                kind: CreditLedgerKind.GRANT,
                amountCredits: delta,
                refType: MONTHLY_PLAN_REF_TYPE,
                refId: subscription.id,
                description: `Monthly plan credits - ${plan?.displayName ?? planCode}`,
                idempotencyKey,
                // No maxBalanceAfter: the monthly allowance accumulates. A
                // balance ceiling here would deny a customer the allowance they
                // are actively paying for the moment they buy a credit pack.
            });
            return entry ? 'granted' : 'skipped';
        } catch (error) {
            this.logger.warn(
                `Monthly plan grant failed for user ${userId}: ${(error as Error).message}`,
            );
            return 'failed';
        }
    }
}

/**
 * Whole UTC months elapsed from `anchor` to `now`, never negative.
 *
 * Month arithmetic, not 30-day arithmetic: a subscription created on the
 * 31st has anniversaries on the 30th/28th in shorter months, and
 * {@link addWholeMonths} clamps to the last valid day rather than rolling
 * into the following month. Rolling over is how a Jan-31 anchor silently
 * grants twice in March.
 */
export function elapsedWholeMonths(anchor: Date, now: Date): number {
    let months =
        (now.getUTCFullYear() - anchor.getUTCFullYear()) * 12 +
        (now.getUTCMonth() - anchor.getUTCMonth());
    if (now.getTime() < addWholeMonths(anchor, months).getTime()) {
        months -= 1;
    }
    return Math.max(0, months);
}

/** `anchor` + `months`, with the day clamped to the target month length. */
export function addWholeMonths(anchor: Date, months: number): Date {
    const year = anchor.getUTCFullYear();
    const month = anchor.getUTCMonth() + months;
    const lastDayOfTarget = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    return new Date(
        Date.UTC(
            year,
            month,
            Math.min(anchor.getUTCDate(), lastDayOfTarget),
            anchor.getUTCHours(),
            anchor.getUTCMinutes(),
            anchor.getUTCSeconds(),
            anchor.getUTCMilliseconds(),
        ),
    );
}
