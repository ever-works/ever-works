import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { PluginUsageCapability, PluginUsageEvent } from '@src/entities/plugin-usage-event.entity';
import { UsageMeter, UsageOutcome, UsagePayer } from '@src/entities/_types';
import { PluginUsageRepository } from '@src/database/repositories/plugin-usage.repository';
import { config } from '@src/config';
import { creditsForProviderCostCents } from '../subscriptions/billing/credit-pricebook';
import { CREDIT_PRICE_LIST, type CreditPriceList } from './credit-price-list';
import { classifyUsage, priceKeyFor, type UsageClassification } from './usage-meter-classifier';
import { USAGE_PAYER_RESOLVER, type UsagePayerResolver } from './usage-payer-resolver';

export type RecordPluginUsageInput = {
    workId: string | undefined;
    userId: string | undefined;
    pluginId: string;
    capability: PluginUsageCapability;
    units?: number;
    costCents?: number;
    currency?: string;
    modelId?: string | null;
    requestId?: string | null;
    metadata?: Record<string, unknown> | null;
    /**
     * Agents/Skills/Tasks PR #1017 — Phase 15.6. Attribution columns
     * that ride alongside the existing (workId, userId) pair. When the
     * call originates from an Agent run, `agentId` lets the per-Agent
     * budget rollup work; for `task` and `chat` kind runs, `taskId`
     * feeds the per-Task spend endpoint.
     */
    agentId?: string | null;
    taskId?: string | null;
    /**
     * Pricing Wave 9 M2 — per-run attribution. Set when the call was
     * made inside an `AgentRun`; the run-cost accumulator sums tagged
     * rows at run-terminal time for the credits debit.
     */
    runId?: string | null;
    /**
     * AW-17 — the Mission of the run's Task (`tasks.missionId`), resolved
     * once per run by the run's host and passed straight through. Never read
     * from the Agent, and never looked up here.
     */
    missionId?: string | null;
    /** AW-17 — the facade operation; defaults to `metadata.operation`. */
    operation?: string | null;
    /** AW-17 — `ok` (default), `cached` or `failed`. Cached and failed cost 0 credits. */
    outcome?: UsageOutcome | null;
    /** AW-17 — who paid, when the caller already knows. Otherwise resolved here. */
    payer?: UsagePayer | null;
};

/** AW-17 — in-process counters behind the metering alerts. */
export interface PluginUsageCounters {
    /** Rows written. */
    recorded: number;
    /** Rows written with a payer the platform could not confirm (`usage.payer.unconfirmed_ratio`). */
    unconfirmedPayer: number;
    /** Credits-meter rows whose kind has no price-list entry (`usage.pricebook.miss`). */
    pricebookMisses: number;
    /** Classifications that threw and fell back to `credits` + `unconfirmed`. */
    classifierFailures: number;
    /** Writes that failed (`usage.record.write_failed`). */
    writeFailures: number;
}

/**
 * EW-602 — best-effort per-call usage recording for AI / search /
 * screenshot / content-extractor invocations.
 *
 * **Never throws**: a failed write must not break the underlying call.
 * Skips silently when workId or userId are absent (system-initiated
 * calls with no Work scope cannot be attributed).
 *
 * AW-17 — the single write path also CLASSIFIES the row as it is written:
 * which meter it belongs to, who paid, the outcome, the price-list key and
 * the credits it accounts for. No facade has to know the rule; a facade may
 * pass what it already knows (`outcome`, `payer`, `missionId`) and the rest
 * is resolved here. A classification failure never drops the row — it is
 * written as `credits` + `unconfirmed` and counted.
 */
@Injectable()
export class PluginUsageService {
    private readonly logger = new Logger(PluginUsageService.name);
    private readonly counters: PluginUsageCounters = {
        recorded: 0,
        unconfirmedPayer: 0,
        pricebookMisses: 0,
        classifierFailures: 0,
        writeFailures: 0,
    };
    /** Price keys already warned about in this process — one line per key, not per call. */
    private readonly warnedMisses = new Set<string>();

    constructor(
        private readonly repository: PluginUsageRepository,
        // AW-17 — appended + @Optional() so every positional construction
        // keeps compiling. Unbound price list ⇒ nothing fixed-priced (every
        // row settles from its provider cost, exactly as before). Unbound
        // resolver ⇒ payer `unconfirmed` unless the caller passed one.
        @Optional() @Inject(CREDIT_PRICE_LIST) private readonly priceList?: CreditPriceList,
        @Optional()
        @Inject(USAGE_PAYER_RESOLVER)
        private readonly payerResolver?: UsagePayerResolver,
    ) {}

    async record(input: RecordPluginUsageInput): Promise<PluginUsageEvent | null> {
        // Agent-initiated calls (e.g. heartbeat with no Work scope) can
        // legitimately have no workId. They still want the row so the
        // per-Agent + per-Task spend rollups work — fall back to a
        // sentinel only when even agentId is missing.
        if (!input.userId) {
            return null;
        }
        if (!input.workId && !input.agentId && !input.taskId) {
            // No scope anchor at all — system-initiated call, skip.
            return null;
        }

        const units = input.units ?? 1;
        const rawCostCents = input.costCents ?? 0;
        const classification = await this.classify(input, units, rawCostCents);

        try {
            const row = await this.repository.record({
                workId: input.workId,
                userId: input.userId,
                pluginId: input.pluginId,
                capability: input.capability,
                units,
                costCents: Math.max(0, Math.round(rawCostCents)),
                currency: input.currency ?? 'usd',
                modelId: input.modelId ?? null,
                requestId: input.requestId ?? null,
                metadata: input.metadata ?? null,
                // Phase 15.6 — propagate Agent/Task attribution when set.
                agentId: input.agentId ?? null,
                taskId: input.taskId ?? null,
                // Wave 9 M2 — propagate per-run attribution when set.
                runId: input.runId ?? null,
                // AW-17 — the meter classification, stamped once.
                meter: classification.meter,
                payer: classification.payer,
                outcome: classification.outcome,
                creditsCharged: classification.creditsCharged,
                priceKey: classification.priceKey,
                priceVersion: classification.priceVersion,
                missionId: input.missionId ?? null,
            });
            this.count(classification);
            return row;
        } catch (error) {
            this.counters.writeFailures += 1;
            this.logger.warn(
                `Failed to record plugin usage (plugin=${input.pluginId}, capability=${input.capability}): ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            return null;
        }
    }

    /** A copy of the metering counters (alerting and tests read this). */
    getCounters(): PluginUsageCounters {
        return { ...this.counters };
    }

    private async classify(
        input: RecordPluginUsageInput,
        units: number,
        costCents: number,
    ): Promise<UsageClassification> {
        try {
            const payer =
                input.payer ??
                (this.payerResolver
                    ? await this.payerResolver.resolve({
                          pluginId: input.pluginId,
                          userId: input.userId as string,
                          workId: input.workId ?? null,
                      })
                    : null);
            return classifyUsage(
                {
                    capability: input.capability,
                    operation: input.operation ?? operationFromMetadata(input.metadata),
                    pluginId: input.pluginId,
                    units,
                    costCents,
                    outcome: input.outcome ?? null,
                    payer,
                },
                {
                    priceList: this.priceList ?? null,
                    creditsForCostCents: creditsForProviderCost,
                },
            );
        } catch (error) {
            this.counters.classifierFailures += 1;
            this.logger.warn(
                `Usage classification failed (plugin=${input.pluginId}); recorded as credits/unconfirmed: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            return {
                meter: UsageMeter.CREDITS,
                payer: UsagePayer.UNCONFIRMED,
                outcome: input.outcome ?? UsageOutcome.OK,
                priceKey: safePriceKey(input),
                priceVersion: null,
                creditsCharged: 0,
                priceMissing: false,
                unconfirmed: true,
            };
        }
    }

    private count(classification: UsageClassification): void {
        this.counters.recorded += 1;
        if (classification.unconfirmed) {
            this.counters.unconfirmedPayer += 1;
        }
        if (classification.priceMissing) {
            this.counters.pricebookMisses += 1;
            if (!this.warnedMisses.has(classification.priceKey)) {
                this.warnedMisses.add(classification.priceKey);
                this.logger.warn(
                    `usage.pricebook.miss — no price-list entry for "${classification.priceKey}"; ` +
                        'the row settles from its provider cost until one is published.',
                );
            }
        }
    }
}

function operationFromMetadata(
    metadata: Record<string, unknown> | null | undefined,
): string | null {
    const operation = metadata?.['operation'];
    return typeof operation === 'string' ? operation : null;
}

function safePriceKey(input: RecordPluginUsageInput): string {
    try {
        return priceKeyFor(String(input.capability), operationFromMetadata(input.metadata));
    } catch {
        return 'unknown.call';
    }
}

/**
 * Provider cost → whole credits at the configured conversion and margin —
 * the same function `CreditLedgerService.creditsForCostCents` applies to a
 * run's summed cost at settlement.
 */
function creditsForProviderCost(costCents: number): number {
    return creditsForProviderCostCents(
        costCents,
        config.billing.credits.getCreditsPerDollar(),
        config.billing.credits.getMarginPercent(),
    );
}
