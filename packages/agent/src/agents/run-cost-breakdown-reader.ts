import type { RunCostBreakdown } from '@ever-works/contracts';

/**
 * Run receipt (AW-09) — the port the receipt reads one run's cost through.
 *
 * Token + contract only (leaf file — the same circular-dependency dodge as
 * `run-credits-precheck.ts`). `RunReceiptService` consumes it; the
 * implementation is `CostsSummaryService` (subscriptions/credits), bound to
 * the token by the api-side `@Global()` SubscriptionsModule. One producer
 * of cost figures means a receipt and the Costs dashboard cannot disagree,
 * and the receipt module never has to import the billing module graph.
 */
export interface RunCostBreakdownReader {
    getRunCostBreakdown(
        run: {
            id: string;
            userId: string;
            status: string;
            costCents?: number | null;
            totalTokens?: number | null;
            createdAt: Date;
        },
        now?: Date,
    ): Promise<RunCostBreakdown>;
}

export const RUN_COST_BREAKDOWN_READER = 'RUN_COST_BREAKDOWN_READER' as const;
