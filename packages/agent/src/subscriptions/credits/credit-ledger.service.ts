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
                const level = await this.entitlementsService.getNumber(
                    planCode,
                    ENTITLEMENT_KEYS.DAILY_FREE_CREDITS,
                    planCode === 'free' ? fallbackDailyFree : 0,
                );
                if (level <= 0) {
                    summary.skipped += 1;
                    continue;
                }

                try {
                    const idempotencyKey = `daily:${user.id}:${date}`;
                    const existing =
                        await this.creditLedgerRepository.findByIdempotencyKey(idempotencyKey);
                    if (existing) {
                        summary.alreadyGranted += 1;
                        continue;
                    }
                    const entry = await this.record({
                        userId: user.id,
                        kind: CreditLedgerKind.DAILY_FREE,
                        amountCredits: level,
                        maxBalanceAfter: level,
                        description: `Daily free credits (${date})`,
                        idempotencyKey,
                    });
                    if (entry) {
                        summary.granted += 1;
                    } else {
                        summary.skipped += 1;
                    }
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
}
