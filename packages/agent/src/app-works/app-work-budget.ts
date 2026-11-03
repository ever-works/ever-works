import { Injectable, Logger, Optional, type OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { isAppWorkKind, totalCostCents } from '@ever-works/contracts';

import { BudgetExceededException } from '../budgets/budget-exceeded.exception';
import { BudgetGuardService } from '../budgets/budget-guard.service';
import { BudgetService } from '../budgets/budget.service';
import { PluginUsageCapability } from '../entities/plugin-usage-event.entity';
import { Work } from '../entities/work.entity';
import { WorkBudgetScope } from '../entities/work-budget.entity';
import {
    DEFAULT_RUN_ADMISSION_CHAIN,
    QUEUED_REASON_WORK_BUDGET,
    withWorkBudgetAdmission,
} from '../agents/run-admission-chain';
import { RunDispatchGateService } from '../agents/run-dispatch-gate.service';
import type { RunWorkBudget } from '../agents/run-work-budget';
import {
    UPSTREAM_CONTRIBUTION_CAPABILITY,
    UPSTREAM_CONTRIBUTION_PLUGIN_ID,
    isBudgetExceededLike,
    nextPeriodStartUtc,
} from '../upstream-pull-requests/upstream-contribution-budget.service';

/**
 * APW-08 T56 (XC-19, FR-73, ACC-08-37) — **one budget per App Work.**
 *
 * > Every Run and every managed Build or hosting charge an App Work causes is booked against
 * > that App Work's own budget through the platform's budget guard, with an alert at the Work's
 * > alert threshold … A refused run is waiting (FR-66). No separate App Works spend account is
 * > introduced.
 *
 * ## What "booked" means here, and what it does not add
 *
 * The spend itself is already on the one ledger every cost surface reads
 * (`plugin_usage_events`, keyed by `workId`): a Fleet run of an App Work Task settles its usage
 * scan to `agent_runs.workId` (the Task's Work — `FleetUsageReconcilerService.settleRun`), and a
 * Build writes its receipt to `work_builds.workId` (`AppBuildsService.recordReceipt`). What was
 * missing is the BUDGET: nothing asked the App Work's own `WorkBudget` before an App Work charge,
 * so a spent cap stopped nothing and its alert never fired. {@link AppWorkBudgetService.book} is
 * that question — `BudgetGuardService.checkBudget(workId, …)` with the App Work's id, never the
 * Agent's Work and never the member's account — and it is the only door. No table, no column and
 * no second spend account: the cap is the Work's existing global `WorkBudget`, the alert is the
 * guard's own `BudgetThresholdCrossedEvent` (idempotent per budget, threshold and period through
 * `WorkBudgetAlertStateRepository`, so it fires once), and the spend is the ledger's.
 *
 * ## The charges, and which of them exist today (2026-10-30)
 *
 * | charge        | booked through                                    | today                         |
 * | ------------- | ------------------------------------------------- | ----------------------------- |
 * | `run`         | the run admission chain ({@link AppWorkBudgetAdmissionInstaller}) — every dispatch of a Task on an App Work: T25's `evolve`, T21's follow-up, the board, chat, a Goal | **wired** |
 * | `preparation` | APW-09's `UpstreamContributionBudgetService` (same capability and plugin id as here) | its preparation step has not shipped |
 * | `build`       | {@link AppWorkBudgetService.book} for a MANAGED (platform-paid) Build | no managed builder exists; a repository-CI Build is the owner's own CI (`payer: workspace`, `costCents: 0`) and is not gated |
 *
 * There is no hosting charge anywhere in the platform yet; when one lands it adds a row here.
 * T35's Mission dispatch does not exist yet either; when it lands it dispatches Task runs, which
 * cross the same admission chain with no change here.
 *
 * ## A refusal is a wait (FR-66)
 *
 * A run the budget refuses is PARKED by the admission chain (`queuedReason: 'work-budget'`): it
 * is a `queued` run row that never reached a runtime, so it uses no gate attempt, can never be a
 * delivery failure, and nothing opens a follow-up for it. The stuck-run sweeper never reaps it,
 * and its tick releases it once the budget allows. This service has no write path at all (no
 * Task, run, follow-up or provider dependency), so a refusal here cannot change anything even if
 * a caller ignored the answer — the same posture APW-09's door documents.
 *
 * ## App Works only
 *
 * Every other Work kind answers `{ allowed: true, gate: 'not-app-work' }` without consulting a
 * budget, so their dispatch is exactly what it was. (Their AI calls stay gated per call by the
 * capability facades, as before.)
 */

/** The charges an App Work books against its own budget. See the table above. */
export const APP_WORK_CHARGE_KINDS = ['run', 'preparation', 'build'] as const;

export type AppWorkChargeKind = (typeof APP_WORK_CHARGE_KINDS)[number];

/**
 * The plugin id an App Work run is booked under. `checkBudget` resolves the Work's GLOBAL budget
 * plus the budget scoped to this id; no `work_budgets` row carries it today, so the App Work's
 * own global cap is what binds — and a run-scoped cap added under this id later applies too.
 */
export const APP_WORK_RUN_PLUGIN_ID = 'app-works-run';

/** The plugin id a managed Build is booked under (same reasoning as the run's). */
export const APP_WORK_BUILD_PLUGIN_ID = 'app-works-build';

/**
 * What each charge books as — the capability the guard's alert names and the plugin id of the
 * scoped half. `preparation` is APW-09's own pair, so both doors book a contribution run
 * identically.
 */
export const APP_WORK_CHARGE_BOOKING: Readonly<
    Record<
        AppWorkChargeKind,
        { readonly capability: PluginUsageCapability; readonly pluginId: string }
    >
> = Object.freeze({
    run: Object.freeze({ capability: PluginUsageCapability.AI, pluginId: APP_WORK_RUN_PLUGIN_ID }),
    preparation: Object.freeze({
        capability: UPSTREAM_CONTRIBUTION_CAPABILITY,
        pluginId: UPSTREAM_CONTRIBUTION_PLUGIN_ID,
    }),
    build: Object.freeze({
        capability: PluginUsageCapability.BUILD,
        pluginId: APP_WORK_BUILD_PLUGIN_ID,
    }),
});

/** `waiting` on the wire — APW-09's word for the same wait. */
export const APP_WORK_BUDGET_WAIT = 'budget' as const;

/** One App Work charge to book. */
export interface AppWorkChargeRequest {
    /** The App Work whose budget is booked — never the Agent's Work, never the member's account. */
    readonly workId: string;
    /** The member the charge is attributed to (the alert's recipient). */
    readonly userId: string;
    readonly charge: AppWorkChargeKind;
    /** Worst-case cost in cents when the caller can estimate it (the guard's pre-flight). */
    readonly estimatedCostCents?: number;
    /** Injectable clock, for a deterministic `resetAt` in a spec. */
    readonly now?: Date;
}

/** The wait a budget refusal produces — what the member is shown and when it can resume. */
export interface AppWorkBudgetWait {
    readonly waiting: typeof APP_WORK_BUDGET_WAIT;
    /** The park reason the admission chain stamps on the run. */
    readonly queuedReason: typeof QUEUED_REASON_WORK_BUDGET;
    readonly charge: AppWorkChargeKind;
    /** ISO instant the budget period that blocked ends. */
    readonly resetAt: string;
    readonly resetAtMs: number;
    readonly scope: WorkBudgetScope | null;
    readonly pluginId: string | null;
    readonly currentSpendCents: number;
    readonly capCents: number;
    readonly currency: string;
}

/** The answer: allowed (and why), or waiting. */
export type AppWorkBudgetDecision =
    | { readonly allowed: true; readonly gate: 'passed' | 'ungated' | 'not-app-work' }
    | { readonly allowed: false; readonly wait: AppWorkBudgetWait };

/**
 * ACC-08-37 — the total of a set of App Work charges: the sum when every amount is known, and
 * **unknown** (`null`) as soon as one is not. A partial sum would read as the whole cost, and the
 * overview would then show a remaining amount the Work does not have. An empty set is a known
 * zero. `NaN` and `Infinity` are not amounts: they are unknown, never `0`.
 *
 * The contracts' `totalCostCents` under the name this epic's spec uses: ONE rule, read by this
 * package, the API's `GET /api/works/:id/cost` rollup and the web summary alike.
 */
export const totalAppWorkCharges: (
    amounts: ReadonlyArray<number | null | undefined>,
) => number | null = totalCostCents;

@Injectable()
export class AppWorkBudgetService implements RunWorkBudget {
    private readonly logger = new Logger(AppWorkBudgetService.name);

    constructor(
        // All `@Optional()`, the house idiom for a service whose collaborators must not make a
        // bare shell uncompilable. No guard ⇒ no budget layer in this installation ⇒ `ungated`,
        // which is reported as such rather than as a check that passed.
        @Optional() private readonly guard?: BudgetGuardService,
        @Optional() private readonly budgets?: BudgetService,
        @Optional() @InjectRepository(Work) private readonly works?: Repository<Work>,
    ) {}

    /**
     * Book one App Work charge against that Work's own budget — **without doing anything else**.
     *
     * Not an App Work (or a Work that no longer exists) ⇒ `not-app-work`, and no budget is read.
     * A spent budget ⇒ the wait. Any other failure of the guard (a database outage) is NOT a
     * spent budget and is rethrown: reporting "your budget is spent" for a platform fault would
     * be a lie (the run-admission port turns a throw into fail-open).
     */
    async book(request: AppWorkChargeRequest): Promise<AppWorkBudgetDecision> {
        if (!(await this.isAppWork(request.workId))) {
            return { allowed: true, gate: 'not-app-work' };
        }
        if (!this.guard) return { allowed: true, gate: 'ungated' };

        const booking = APP_WORK_CHARGE_BOOKING[request.charge];
        const now = request.now ?? new Date();
        try {
            await this.guard.checkBudget(
                request.workId,
                request.userId,
                booking.capability,
                booking.pluginId,
                {
                    estimatedCostCents: Math.max(0, Math.round(request.estimatedCostCents ?? 0)),
                    now,
                },
            );
            return { allowed: true, gate: 'passed' };
        } catch (error) {
            if (isBudgetExceededLike(error)) {
                return {
                    allowed: false,
                    wait: this.buildWait(request.charge, error, now),
                };
            }
            this.logger.warn(
                `App Work ${request.workId}: the ${request.charge} charge could not be booked ` +
                    `against its budget: ${error instanceof Error ? error.message : String(error)}`,
            );
            throw error;
        }
    }

    /**
     * The run-admission port: park this dispatch? Only a Task run of an App Work whose budget is
     * spent answers `true`. A run with no Work never reads anything.
     */
    async shouldParkForWorkBudget(input: {
        userId: string;
        workId?: string | null;
        agentId?: string | null;
    }): Promise<boolean> {
        if (!input.workId) return false;
        const decision = await this.book({
            workId: input.workId,
            userId: input.userId,
            charge: 'run',
        });
        return decision.allowed === false;
    }

    /** The Work's kind, read by primary key. Unbound or missing ⇒ not an App Work. */
    private async isAppWork(workId: string): Promise<boolean> {
        if (!workId || !this.works) return false;
        const work = await this.works.findOne({
            where: { id: workId },
            select: { id: true, kind: true },
        });
        return isAppWorkKind(work?.kind);
    }

    private buildWait(
        charge: AppWorkChargeKind,
        error: BudgetExceededException,
        now: Date,
    ): AppWorkBudgetWait {
        // The boundary the spend was measured against: `BudgetService` when bound, its own rule
        // otherwise (APW-09's helper, which its spec pins to the service's rule).
        const resetAt = this.budgets?.getNextPeriodStart(now) ?? nextPeriodStartUtc(now);
        const details = error.details;
        return {
            waiting: APP_WORK_BUDGET_WAIT,
            queuedReason: QUEUED_REASON_WORK_BUDGET,
            charge,
            resetAt: resetAt.toISOString(),
            resetAtMs: resetAt.getTime(),
            scope: (details?.scope as WorkBudgetScope | undefined) ?? null,
            // The budget that BLOCKED: `null` for the Work's global cap (the one that binds
            // today), the plugin id only when a plugin-scoped cap did.
            pluginId: details?.pluginId ?? null,
            currentSpendCents: details?.currentSpendCents ?? 0,
            capCents: details?.capCents ?? 0,
            currency: details?.currency ?? 'usd',
        };
    }
}

/**
 * APW-08 T56 — puts the App Work budget into the run admission chain, once, at module init.
 *
 * The dispatch gate composes `DEFAULT_RUN_ADMISSION_CHAIN` at construction and exposes
 * `withAdmissionChain` for an install that adds a middleware (its own docstring). The gate's
 * constructor is another lane's (T12), so the budget middleware is a closure over
 * {@link AppWorkBudgetService} rather than a new context field, and this installer hands the
 * gate `DEFAULT_RUN_ADMISSION_CHAIN` with that one middleware inserted after the Agent brake
 * (`withWorkBudgetAdmission`). Every other middleware keeps its place and its behaviour, and
 * the default list itself is unchanged — a gate built without this installer (every unit spec,
 * a shell without the budget layer) admits exactly as before.
 *
 * Provided next to the gate (the agent `AgentsModule`), so it installs into the one instance the
 * API dispatches through; the Trigger worker reaches that instance through its RPC proxy.
 */
@Injectable()
export class AppWorkBudgetAdmissionInstaller implements OnModuleInit {
    private readonly logger = new Logger(AppWorkBudgetAdmissionInstaller.name);

    constructor(
        @Optional() private readonly gate?: RunDispatchGateService,
        @Optional() private readonly budget?: AppWorkBudgetService,
    ) {}

    onModuleInit(): void {
        if (!this.gate || !this.budget || typeof this.gate.withAdmissionChain !== 'function') {
            return;
        }
        this.gate.withAdmissionChain(
            withWorkBudgetAdmission(DEFAULT_RUN_ADMISSION_CHAIN, this.budget),
        );
        this.logger.log('Run admission: App Work budgets are enforced (park reason work-budget).');
    }
}
