import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AgentRun } from '@src/entities/agent-run.entity';
import {
    PluginUsageRepository,
    type RunPluginSpend,
} from '@src/database/repositories/plugin-usage.repository';
import type { RunCostSettler, RunSettlementResult } from '@src/database/run-cost-settler';
import { NotificationService } from '@src/notifications/notification.service';
import { PluginSettingsService } from '@src/plugins/services/plugin-settings.service';
import { config } from '@src/config';
import { CreditLedgerService, InsufficientCreditsError } from './credit-ledger.service';
import { ENTITLEMENT_KEYS, EntitlementsService } from './entitlements.service';
import { CreditLedgerKind } from '@src/entities/credit-ledger-entry.entity';
import { UserRepository } from '@src/database/repositories/user.repository';
// The gate-precheck contract lives in the agents leaf file (consumed by
// RunDispatchGateService, implemented here, bound to the
// RUN_CREDITS_PRECHECK token by the api-side @Global() SubscriptionsModule).
import type { RunCreditsPrecheck } from '../../agents/run-credits-precheck';
import { AutoRechargeService } from '../billing/auto-recharge.service';

/**
 * Pricing Wave 9 M2 — wires real usage metering into the credits ledger.
 *
 * ACCUMULATION: when a run reaches a terminal status
 * (`AgentRunRepository` fires the `RUN_COST_SETTLER` hook), this service
 * sums the run's attributable spend — `plugin_usage_events` rows tagged
 * with the run id (`FacadeOptions.runId`, threaded by the run's
 * AI-dispatch + tool pass-through adapters) — and stamps the total onto
 * `agent_runs.costCents`.
 *
 * DEBIT: the billable share converts to ONE credits CONSUMPTION row via
 * `CreditLedgerService.consumeForRun` (idempotency key `run:{runId}` —
 * re-running a terminal write can never double-debit). Best-effort per
 * the billing PRD §6: a credits outage never fails a run; an
 * insufficient balance records a zero-or-partial debit (down to exactly
 * 0) and emits an AI_CREDITS notification instead of erroring.
 *
 * BYOK/BYOS EXEMPTION (founder decisions P2/P3 — user-supplied provider
 * subscriptions and local BYOS runs consume no platform credits): a
 * plugin whose `apiKey` resolved from the USER or WORK settings level
 * (i.e. the user supplied their own key, not the platform's env/admin
 * key) is excluded from the billable sum — its spend stays visible in
 * `agent_runs.costCents` and the usage surfaces, labeled, but produces
 * no CONSUMPTION debit. Resolution provenance comes from
 * `PluginSettingsService.getResolvedSettings` (`ResolvedSetting.source`).
 * When that service is not wired (`@Optional()` — e.g. a deployment
 * without the plugins module), the exemption is skipped and the full
 * metered cost is billed; see `BYOK_EXEMPTION_UNRESOLVED_BILLS_FULL`.
 */
@Injectable()
export class RunCostSettlementService implements RunCostSettler, RunCreditsPrecheck {
    private readonly logger = new Logger(RunCostSettlementService.name);

    /**
     * Documented posture (TODO, Wave 9 follow-up): when key provenance is
     * NOT derivable (no PluginSettingsService bound, or resolution throws
     * for a plugin), the affected spend is billed at the platform rate
     * rather than silently given away. Revisit once passthrough runs
     * (P2) carry an explicit per-event billing flag on the usage row —
     * that flag should replace settlement-time provenance resolution.
     */
    static readonly BYOK_EXEMPTION_UNRESOLVED_BILLS_FULL = true;

    constructor(
        @InjectRepository(AgentRun)
        private readonly agentRuns: Repository<AgentRun>,
        private readonly pluginUsageRepository: PluginUsageRepository,
        private readonly creditLedgerService: CreditLedgerService,
        private readonly entitlementsService: EntitlementsService,
        private readonly userRepository: UserRepository,
        @Optional() private readonly notificationService?: NotificationService,
        @Optional() private readonly pluginSettingsService?: PluginSettingsService,
        // Billing PRD §3.4 — the debit-time threshold check. @Optional()
        // because the worker-side RPC proxy module binds the settler
        // without the money path; a missing binding simply means no
        // auto-recharge, never a failed settlement.
        @Optional() private readonly autoRechargeService?: AutoRechargeService,
    ) {}

    /** Never rejects — see the RunCostSettler contract. */
    async settleRun(runId: string): Promise<RunSettlementResult> {
        const result: RunSettlementResult = {
            runId,
            status: 'skipped',
            totalCostCents: 0,
            billableCostCents: 0,
            debitedCredits: 0,
            exemptPluginIds: [],
        };

        try {
            const run = await this.agentRuns.findOne({ where: { id: runId } });
            if (!run || !run.userId) {
                return result;
            }

            const spend = await this.pluginUsageRepository.getRunCostByPlugin(runId);
            if (spend.length === 0) {
                // Nothing metered for this run (or predates runId tagging)
                // — no stamp, no debit; NULL costCents stays honest.
                return result;
            }

            result.totalCostCents = spend.reduce((sum, row) => sum + row.costCents, 0);

            // Stamp the full metered rollup — BYOK spend included: the
            // column is a cost ESTIMATE surface, not the billable amount.
            try {
                await this.agentRuns.update(runId, { costCents: result.totalCostCents });
            } catch (err) {
                this.logger.warn(`Run ${runId}: costCents stamp failed (ignored): ${err}`);
            }

            result.exemptPluginIds = await this.resolveExemptPlugins(
                spend,
                run.userId,
                run.workId ?? undefined,
            );
            result.billableCostCents = spend
                .filter((row) => !result.exemptPluginIds.includes(row.pluginId))
                .reduce((sum, row) => sum + row.costCents, 0);

            if (result.billableCostCents <= 0) {
                result.status = 'settled';
                return result;
            }

            try {
                const entry = await this.creditLedgerService.consumeForRun({
                    userId: run.userId,
                    runId,
                    costCents: result.billableCostCents,
                    organizationId: run.organizationId ?? null,
                    tenantId: run.tenantId ?? null,
                    description: `Run ${runId} (${run.triggerKind})`,
                });
                result.debitedCredits = entry ? Math.abs(entry.amountCredits) : 0;
                result.status = 'settled';
                // Debit-time auto-recharge check (PRD §3.4). Best-effort:
                // the balance moved, so this is the moment a threshold can
                // be crossed — but a billing hiccup must never redden a
                // settled run.
                await this.maybeAutoRecharge(run.userId);
                return result;
            } catch (err) {
                if (err instanceof InsufficientCreditsError) {
                    return await this.settleInsufficient(result, run, err);
                }
                throw err;
            }
        } catch (err) {
            // Never fails the terminal write that hosted it (PRD §6).
            this.logger.warn(
                `Run ${runId}: cost settlement failed (ignored): ${
                    err instanceof Error ? err.message : String(err)
                }`,
            );
            result.status = 'error';
            return result;
        }
    }

    /**
     * PRD §6 exhaustion policy: record a zero-or-partial debit (down to
     * exactly 0 — same `run:{runId}` idempotency key, so a later retry
     * can never top it up into a double debit) and notify the user. The
     * run's terminal status is never affected.
     */
    private async settleInsufficient(
        result: RunSettlementResult,
        run: AgentRun,
        err: InsufficientCreditsError,
    ): Promise<RunSettlementResult> {
        const balance = err.balanceCredits;
        const partial = Math.max(0, Math.trunc(balance));

        if (partial > 0) {
            try {
                const entry = await this.creditLedgerService.record({
                    userId: run.userId,
                    organizationId: run.organizationId ?? null,
                    tenantId: run.tenantId ?? null,
                    kind: CreditLedgerKind.CONSUMPTION,
                    amountCredits: -partial,
                    costCentsRef: result.billableCostCents,
                    refType: 'agent-run',
                    refId: run.id,
                    description: `Run ${run.id} (${run.triggerKind}) — partial, balance exhausted`,
                    idempotencyKey: `run:${run.id}`,
                });
                result.debitedCredits = entry ? Math.abs(entry.amountCredits) : 0;
            } catch (partialErr) {
                this.logger.warn(`Run ${run.id}: partial debit failed (ignored): ${partialErr}`);
            }
        }

        try {
            await this.notificationService?.notifyCreditsBalanceExhausted({
                userId: run.userId,
                runId: run.id,
                requiredCredits: err.requestedCredits,
                balanceCredits: balance,
            });
        } catch (notifyErr) {
            this.logger.warn(
                `Run ${run.id}: exhaustion notification failed (ignored): ${notifyErr}`,
            );
        }

        result.status = result.debitedCredits > 0 ? 'partial' : 'exhausted';
        // An exhausted balance is the strongest possible threshold
        // crossing — try to top up here too.
        await this.maybeAutoRecharge(run.userId);
        return result;
    }

    /**
     * Fire the auto-recharge threshold check after a balance movement.
     * Swallows everything: the service itself already guards against
     * double-firing (compare-and-set on the profile's in-flight slot), and
     * settlement must stay non-fatal per PRD §6.
     */
    private async maybeAutoRecharge(userId: string): Promise<void> {
        if (!this.autoRechargeService) {
            return;
        }
        try {
            await this.autoRechargeService.maybeRecharge(userId);
        } catch (err) {
            this.logger.warn(
                `Auto-recharge check failed for user ${userId} (ignored): ${
                    err instanceof Error ? err.message : String(err)
                }`,
            );
        }
    }

    /**
     * BYOK exemption: plugins whose `apiKey` resolved from the `user` or
     * `work` settings level ran on user-supplied credentials — free per
     * founder decision. `admin`/`env`/`default` sources are
     * platform-supplied and bill normally. Per-plugin failures bill that
     * plugin (never exempt on doubt); no settings service ⇒ no exemption.
     */
    private async resolveExemptPlugins(
        spend: RunPluginSpend[],
        userId: string,
        workId?: string,
    ): Promise<string[]> {
        if (!this.pluginSettingsService) return [];
        const exempt: string[] = [];
        for (const row of spend) {
            if (row.costCents <= 0) continue;
            try {
                const resolved = await this.pluginSettingsService.getResolvedSettings(
                    row.pluginId,
                    { userId, workId, includeSecrets: true },
                );
                const source = resolved['apiKey']?.source;
                if (source === 'user' || source === 'work') {
                    exempt.push(row.pluginId);
                }
            } catch (err) {
                this.logger.debug(
                    `Run settlement: apiKey provenance unresolved for plugin ${row.pluginId} ` +
                        `(billing at platform rate): ${err}`,
                );
            }
        }
        return exempt;
    }

    /**
     * Dispatch-gate soft precheck (Wave 9 M2, ship-dark). Blocks only
     * when EVERY lever agrees: `CREDITS_ENFORCEMENT=on` (the gate also
     * early-outs on this), the user's plan carries the `credit-limited`
     * entitlement (> 0 — no rows are seeded, so default is never
     * limited), AND the balance is ≤ 0. Any resolution failure returns
     * false — a broken precheck must never stop work.
     */
    async shouldQueueForCredits(userId: string): Promise<boolean> {
        try {
            if (!config.billing.credits.isEnforcementEnabled()) {
                return false;
            }
            const user = await this.userRepository.findByIdForScheduledRun(userId);
            if (!user) return false;
            const planCode =
                (user.defaultPlan?.code as string) || config.subscriptions.getDefaultPlanCode();
            const creditLimited = await this.entitlementsService.getNumber(
                planCode,
                ENTITLEMENT_KEYS.CREDIT_LIMITED,
                0,
            );
            if (creditLimited <= 0) return false;
            const balance = await this.creditLedgerService.getBalance(userId);
            return balance <= 0;
        } catch (err) {
            this.logger.warn(`Credits precheck failed for user ${userId} (fail-open): ${err}`);
            return false;
        }
    }
}
