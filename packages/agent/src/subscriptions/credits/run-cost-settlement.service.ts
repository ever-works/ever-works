import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { isFleetModelPluginId } from '@ever-works/contracts';
import { AgentRun } from '@src/entities/agent-run.entity';
import {
    PluginUsageRepository,
    type RunMeterGroup,
    type RunPluginSpend,
} from '@src/database/repositories/plugin-usage.repository';
import { UsageMeter, UsagePayer } from '@src/entities/_types';
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
import { PaygService } from '../billing/payg.service';

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
 *
 * METERS (AW-17): usage rows now carry their meter, payer and — for a fixed
 * `per-unit` price-list entry — the credits and price-list version that
 * priced them, stamped when each row was written. Settlement reads that
 * classification beside the per-plugin totals:
 *
 *  - a fixed-priced credits row debits exactly its stamped credits (0 for a
 *    cached or failed call);
 *  - a row stamped as paid by the Workspace (`model` meter) or covered by an
 *    add-on (`addon` meter) debits nothing, with no provenance lookup;
 *  - EVERYTHING ELSE — rows with no fixed price (managed model access is
 *    priced from the model's own cost), rows recorded before meters existed,
 *    rows whose payer is unconfirmed — settles exactly as before: its
 *    provider cost goes through the provenance exemption above and converts
 *    at the configured rate. No price known ⇒ no change in what is debited.
 *
 * If the classified read fails, the whole run settles the pre-meter way.
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
        // Billing spec §3.5 — the pay-as-you-go overflow after the prepaid
        // debit. @Optional() for the same reason as auto-recharge: a missing
        // binding means no overflow metering, never a failed settlement.
        @Optional() private readonly paygService?: PaygService,
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

            const metered = splitMeteredSpend(spend, await this.readMeterGroups(runId));

            const exempt = await this.resolveExemptPlugins(
                metered.legacySpend,
                run.userId,
                run.workId ?? undefined,
            );
            // Fixed-priced rows whose payer was not confirmed at capture get
            // the same settlement-time provenance check the legacy rows get:
            // a Workspace-owned key is never charged on doubt resolved.
            const unconfirmedFixedPlugins = metered.fixedRows
                .filter((row) => row.unconfirmed && !exempt.includes(row.pluginId))
                .map((row) => ({ pluginId: row.pluginId, costCents: 1 }));
            const exemptFixed =
                unconfirmedFixedPlugins.length > 0
                    ? await this.resolveExemptPlugins(
                          dedupeByPlugin(unconfirmedFixedPlugins),
                          run.userId,
                          run.workId ?? undefined,
                      )
                    : [];
            result.exemptPluginIds = unique([
                ...exempt,
                ...metered.workspacePluginIds,
                ...exemptFixed,
            ]);

            const legacyBillableCents = metered.legacySpend
                .filter((row) => !exempt.includes(row.pluginId))
                .reduce((sum, row) => sum + row.costCents, 0);
            const billedFixed = metered.fixedRows.filter(
                (row) =>
                    !(
                        row.unconfirmed &&
                        (exempt.includes(row.pluginId) || exemptFixed.includes(row.pluginId))
                    ),
            );
            const fixedCredits = billedFixed.reduce((sum, row) => sum + row.creditsCharged, 0);
            result.billableCostCents =
                legacyBillableCents + billedFixed.reduce((sum, row) => sum + row.costCents, 0);

            if (result.billableCostCents <= 0 && fixedCredits <= 0) {
                result.status = 'settled';
                return result;
            }

            try {
                const consume: Parameters<CreditLedgerService['consumeForRun']>[0] = {
                    userId: run.userId,
                    runId,
                    costCents: result.billableCostCents,
                    organizationId: run.organizationId ?? null,
                    tenantId: run.tenantId ?? null,
                    description: `Run ${runId} (${run.triggerKind})`,
                };
                if (metered.fixedRows.length > 0) {
                    // Published fixed prices + the legacy conversion of the
                    // rest. Without a fixed-priced row the ledger converts
                    // the cost itself, byte-for-byte as before.
                    consume.credits =
                        fixedCredits +
                        this.creditLedgerService.creditsForCostCents(legacyBillableCents);
                }
                const entry = await this.creditLedgerService.consumeForRun(consume);
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

        // Billing spec FR-18 — the uncovered remainder goes to pay-as-you-go
        // when the owner opted in (metered to the provider, invoiced in
        // arrears, capped by the owner's monthly headroom). Best-effort and
        // idempotent on `run:{runId}`; a PAYG hiccup never reddens the run.
        const remainder = Math.max(0, Math.trunc(err.requestedCredits) - result.debitedCredits);
        let metered = false;
        if (remainder > 0 && this.paygService) {
            try {
                const overflow = await this.paygService.recordOverflow({
                    userId: run.userId,
                    runId: run.id,
                    remainderCredits: remainder,
                    costCentsRef: result.billableCostCents,
                    organizationId: run.organizationId ?? null,
                    tenantId: run.tenantId ?? null,
                });
                result.meteredCredits = overflow.billedCredits;
                result.writtenOffCredits = overflow.writtenOffCredits;
                metered = overflow.status === 'metered' && overflow.billedCredits > 0;
            } catch (paygErr) {
                this.logger.warn(
                    `Run ${run.id}: pay-as-you-go overflow failed (ignored): ${paygErr}`,
                );
            }
        }

        // "Balance exhausted" is only news when nothing picked the remainder up.
        if (!metered) {
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
        }

        result.status = metered ? 'metered' : result.debitedCredits > 0 ? 'partial' : 'exhausted';
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
     *
     * Fleet cost accounting (EW-777): a `fleet-node:*` row is a FLEET
     * run's model spend, billed to the CLI seat the owner's own machine is
     * logged in as — bring-your-own by construction, exempt under the same
     * founder rule as BYOK (P2/P3). It needs no settings service: the
     * plugin id itself is the provenance. The spend is still stamped on
     * `agent_runs.costCents` above (visibility, Goal caps, ceilings); it
     * is simply never debited from platform credits.
     */
    private async resolveExemptPlugins(
        spend: RunPluginSpend[],
        userId: string,
        workId?: string,
    ): Promise<string[]> {
        const exempt: string[] = [];
        for (const row of spend) {
            if (row.costCents <= 0) continue;
            if (isFleetModelPluginId(row.pluginId)) {
                exempt.push(row.pluginId);
                continue;
            }
            if (!this.pluginSettingsService) continue;
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
     * AW-17 — the run's rows grouped by meter / payer / fixed price. A failed
     * read is not an error: the run settles the pre-meter way.
     */
    private async readMeterGroups(runId: string): Promise<RunMeterGroup[]> {
        try {
            const groups = await this.pluginUsageRepository.getRunMeterGroups(runId);
            return Array.isArray(groups) ? groups : [];
        } catch (err) {
            this.logger.debug(
                `Run ${runId}: classified usage read failed, settling from provider cost: ${err}`,
            );
            return [];
        }
    }

    /**
     * Dispatch-gate precheck (Wave 9 M2; billing spec FR-3 / FR-19 / FR-30).
     * Parks a run only when EVERY lever agrees: enforcement is on (unset ⇒
     * on iff the billing provider is configured), the user's plan carries
     * the `credit-limited` entitlement (seeded for the cloud tiers), the
     * available balance is ≤ 0 AND there is no pay-as-you-go headroom.
     *
     * Before reading the balance it grants today's daily allowance lazily
     * (same idempotency key as the sweep), so a deployment whose cron has
     * not fired yet never parks a user who is owed free credits. Any
     * resolution failure returns false — a broken precheck must never stop
     * work.
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

            try {
                await this.creditLedgerService.grantDailyForUser(userId, planCode);
            } catch (grantErr) {
                this.logger.warn(
                    `Credits precheck: lazy daily grant failed for user ${userId} (ignored): ${grantErr}`,
                );
            }

            const balance = await this.creditLedgerService.getBalance(userId);
            if (balance > 0) return false;
            if (this.paygService) {
                const headroom = await this.paygService.headroom(userId);
                if (headroom > 0) return false;
            }
            return true;
        } catch (err) {
            this.logger.warn(`Credits precheck failed for user ${userId} (fail-open): ${err}`);
            return false;
        }
    }
}

/** A fixed-priced credits group, ready to debit. */
interface FixedPricedRow {
    pluginId: string;
    costCents: number;
    creditsCharged: number;
    unconfirmed: boolean;
}

/**
 * AW-17 — split a run's spend into (a) fixed-priced credits rows, (b) rows
 * stamped as not debitable (Workspace-paid or add-on), and (c) the legacy
 * remainder that settles from provider cost exactly as before. Pure.
 *
 * The legacy remainder is the per-plugin total MINUS the classified groups
 * that are settled another way, so a plugin whose rows straddle both keeps
 * its unclassified cost on the legacy path and nothing is counted twice.
 */
export function splitMeteredSpend(
    spend: RunPluginSpend[],
    groups: RunMeterGroup[],
): {
    fixedRows: FixedPricedRow[];
    workspacePluginIds: string[];
    legacySpend: RunPluginSpend[];
} {
    const settledElsewhere = new Map<string, number>();
    const fixedRows: FixedPricedRow[] = [];
    const workspacePluginIds: string[] = [];

    for (const group of groups) {
        const isFixed =
            group.meter === UsageMeter.CREDITS &&
            group.priceVersion !== null &&
            group.payer !== UsagePayer.WORKSPACE;
        const notDebited =
            group.meter === UsageMeter.MODEL ||
            group.meter === UsageMeter.ADDON ||
            (group.meter === UsageMeter.CREDITS && group.payer === UsagePayer.WORKSPACE);
        if (!isFixed && !notDebited) {
            continue;
        }
        settledElsewhere.set(
            group.pluginId,
            (settledElsewhere.get(group.pluginId) ?? 0) + group.costCents,
        );
        if (isFixed) {
            fixedRows.push({
                pluginId: group.pluginId,
                costCents: group.costCents,
                creditsCharged: Math.max(0, Math.trunc(group.creditsCharged)),
                unconfirmed: group.payer !== UsagePayer.PLATFORM,
            });
        } else if (group.meter !== UsageMeter.ADDON && group.costCents > 0) {
            workspacePluginIds.push(group.pluginId);
        }
    }

    const legacySpend = spend.map((row) => ({
        pluginId: row.pluginId,
        costCents: Math.max(0, row.costCents - (settledElsewhere.get(row.pluginId) ?? 0)),
    }));

    return { fixedRows, workspacePluginIds: unique(workspacePluginIds), legacySpend };
}

function unique(values: string[]): string[] {
    return Array.from(new Set(values));
}

function dedupeByPlugin(rows: RunPluginSpend[]): RunPluginSpend[] {
    const seen = new Set<string>();
    return rows.filter((row) => {
        if (seen.has(row.pluginId)) return false;
        seen.add(row.pluginId);
        return true;
    });
}
