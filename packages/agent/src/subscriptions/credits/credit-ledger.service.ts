import { Injectable, Logger } from '@nestjs/common';
import {
    CreditLedgerQuery,
    CreditLedgerRepository,
    CreditLedgerWrite,
} from '@src/database/repositories/credit-ledger.repository';
import { UserRepository } from '@src/database/repositories/user.repository';
import { CreditLedgerEntry, CreditLedgerKind } from '@src/entities/credit-ledger-entry.entity';
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
    /**
     * Bucket expiry for a positive write (plan allowance grants carry
     * their allowance-month end). Ignored on debits; absent = never.
     */
    expiresAt?: Date | null;
    /** Clock override for tests. */
    now?: Date;
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
}

export interface ExpirySweepSummary {
    /** Users that had at least one due bucket. */
    users: number;
    /** Buckets closed. */
    buckets: number;
    /** Credits written off as `expiry` rows. */
    credits: number;
}

/** Outcome of the lazy per-user daily grant (dispatch-gate path). */
export type DailyGrantOutcome = 'granted' | 'already-granted' | 'skipped';

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

        if (options.expiresAt && options.amountCredits > 0) {
            write.expiresAt = options.expiresAt;
        }

        const result = await this.creditLedgerRepository.recordAtomic(write, {
            minBalanceAfter: options.amountCredits < 0 && !allowNegative ? 0 : null,
            maxBalanceAfter: options.maxBalanceAfter ?? null,
            now: options.now,
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

    /** True when a movement with this idempotency key was already written. */
    async hasEntry(idempotencyKey: string): Promise<boolean> {
        return (await this.creditLedgerRepository.findByIdempotencyKey(idempotencyKey)) !== null;
    }

    /**
     * Available balance: SUM of all signed movements for the user, minus
     * the unconsumed part of buckets that lapsed but are not swept yet.
     */
    async getBalance(userId: string): Promise<number> {
        return this.creditLedgerRepository.getBalance(userId);
    }

    /**
     * Close lapsed buckets (billing spec §3.2 FR-7). With a `userId`,
     * just that user (the settlement/gate path); without, every user
     * with a due bucket, in bounded batches (the daily sweep). Each
     * expiry is an `expiry` row keyed `expiry:{entryId}`, so re-running
     * is a no-op.
     */
    async expireDueCredits(userId?: string, now: Date = new Date()): Promise<ExpirySweepSummary> {
        const summary: ExpirySweepSummary = { users: 0, buckets: 0, credits: 0 };
        const expireOne = async (id: string) => {
            const expired = await this.creditLedgerRepository.expireDueBuckets(id, now);
            if (expired.length > 0) {
                summary.users += 1;
                summary.buckets += expired.length;
                summary.credits += expired.reduce((sum, item) => sum + item.expiredCredits, 0);
            }
        };

        if (userId) {
            await expireOne(userId);
            return summary;
        }

        const batchSize = config.billing.credits.getDailyGrantBatchSize();
        // Each pass closes the buckets it found, so the next read returns
        // a strictly smaller set; the guard stops a pathological loop.
        for (let pass = 0; pass < 1000; pass += 1) {
            const users = await this.creditLedgerRepository.findUsersWithDueBuckets(now, batchSize);
            if (users.length === 0) break;
            for (const id of users) {
                try {
                    await expireOne(id);
                } catch (error) {
                    this.logger.warn(
                        `Credit expiry failed for user ${id}: ${(error as Error).message}`,
                    );
                }
            }
            if (users.length < batchSize) break;
        }
        return summary;
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
     * cron, 00:05 UTC). For every active user, on EVERY plan, tops the
     * balance back UP TO the plan's `daily-free-credits` level (platform
     * default 50) — non-accumulating per the PRD: a balance already at or
     * above the level receives nothing. Idempotency key
     * `daily:{userId}:{date}` makes cron re-runs a no-op.
     */
    async dispatchDailyGrants(now: Date = new Date()): Promise<DailyGrantSummary> {
        const summary: DailyGrantSummary = {
            granted: 0,
            skipped: 0,
            alreadyGranted: 0,
            scanned: 0,
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
                try {
                    const outcome = await this.grantDailyForPlan(
                        user.id,
                        planCode,
                        date,
                        fallbackDailyFree,
                    );
                    if (outcome === 'granted') summary.granted += 1;
                    else if (outcome === 'already-granted') summary.alreadyGranted += 1;
                    else summary.skipped += 1;
                } catch (error) {
                    // Best-effort per user — one failure must not starve the
                    // rest of the sweep; the idempotency key retries tomorrow.
                    summary.skipped += 1;
                    this.logger.warn(
                        `Daily grant failed for user ${user.id}: ${(error as Error).message}`,
                    );
                }
            }

            if (users.length < batchSize) {
                break;
            }
        }

        return summary;
    }

    /**
     * Lazy daily grant for ONE user (billing spec FR-3) — the dispatch
     * gate calls this before evaluating the balance so a deployment whose
     * cron has not run today never parks a user who is owed free
     * credits. Same idempotency key as the sweep, so the two can never
     * double-grant.
     */
    async grantDailyForUser(
        userId: string,
        planCode: string,
        now: Date = new Date(),
    ): Promise<DailyGrantOutcome> {
        const date = now.toISOString().slice(0, 10);
        return this.grantDailyForPlan(
            userId,
            planCode,
            date,
            config.billing.credits.getDailyFreeCredits(),
        );
    }

    /**
     * The universal daily allowance (billing spec FR-1): every plan code
     * resolves its `daily-free-credits` entitlement, and a plan without a
     * row falls back to the platform default (`CREDITS_DAILY_FREE`, 50).
     * Earlier code granted the fallback to the free plan only, which is
     * why paid subscribers received no daily credits while the catalog
     * and the marketing site said 50/day on every tier.
     */
    private async grantDailyForPlan(
        userId: string,
        planCode: string,
        date: string,
        fallbackDailyFree: number,
    ): Promise<DailyGrantOutcome> {
        const level = await this.entitlementsService.getNumber(
            planCode,
            ENTITLEMENT_KEYS.DAILY_FREE_CREDITS,
            fallbackDailyFree,
        );
        if (level <= 0) {
            return 'skipped';
        }
        const idempotencyKey = `daily:${userId}:${date}`;
        const existing = await this.creditLedgerRepository.findByIdempotencyKey(idempotencyKey);
        if (existing) {
            return 'already-granted';
        }
        const entry = await this.record({
            userId,
            kind: CreditLedgerKind.DAILY_FREE,
            amountCredits: level,
            maxBalanceAfter: level,
            description: `Daily free credits (${date})`,
            idempotencyKey,
        });
        return entry ? 'granted' : 'skipped';
    }
}
