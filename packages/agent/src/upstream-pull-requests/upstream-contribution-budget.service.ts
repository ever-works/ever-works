import { Injectable, Logger, Optional } from '@nestjs/common';
import { BudgetExceededException } from '../budgets/budget-exceeded.exception';
import { BudgetGuardService } from '../budgets/budget-guard.service';
import { BudgetService } from '../budgets/budget.service';
import { PluginUsageCapability } from '../entities/plugin-usage-event.entity';
import { WorkBudgetScope } from '../entities/work-budget.entity';

/**
 * APW-09 T44 (FR-44, ACC-09-33; XC-19) — **one budget per App Work, contribution
 * runs included.**
 *
 * > Preparation runs, review follow-up runs and every other agent run an App Work
 * > causes are booked against **that App Work's own budget** through the
 * > platform's budget guard … A refusal by budget is a **wait** with the reset
 * > time, not a failure of the proposal, and it opens nothing upstream; the row
 * > keeps its state and says why it is waiting.
 *
 * ## Why the gate is a service rather than three lines in each caller
 *
 * The epic dispatches contribution runs from more than one place (preparation
 * today, review follow-up, and whatever a later task adds), and FR-44's rule is
 * about **all** of them. A guard copied into each caller is a guard that the
 * fourth caller forgets; {@link UpstreamContributionBudgetService.dispatch} is
 * the single door, so "every run this epic dispatches goes through the platform's
 * `BudgetGuardService`" is a property of one function rather than a convention.
 *
 * ## It has no write path at all
 *
 * Nothing in this file writes a row, opens a branch, pushes a commit or calls a
 * provider. That is the mechanism behind "a budget refusal opens nothing
 * upstream": a refusal returns a {@link UpstreamBudgetWait} and the caller stops.
 * The repository, the git facade and the provider clients are simply not
 * dependencies of this service, so there is no path through it that could open
 * anything even if a caller ignored the answer.
 *
 * ## The wait, and what the member sees
 *
 * `resetAt` is the **end of the budget period that blocked** — the platform's own
 * period boundary, read from `BudgetService.getNextPeriodStart` so it can never
 * drift from the boundary the spend was measured against. {@link
 * toUpstreamBudgetWaitResponse} projects the wait onto the wire shape T44 fixes,
 * `202 { state, waiting: 'budget', resetAt }`, and carries the named code and the
 * cap for the approval surface's own copy.
 *
 * ## The alert is the guard's, not a second one here
 *
 * `BudgetGuardService.checkBudget` evaluates the budget, dispatches
 * `BudgetThresholdCrossedEvent` for every newly-crossed threshold (idempotent
 * through `WorkBudgetAlertStateRepository`) and **then** throws when the budget
 * blocks. Routing every contribution run through it is therefore also what raises
 * the Work's alert at its threshold — there is no second alert path to keep in
 * step, and no way for the booking to happen without the threshold being
 * evaluated.
 *
 * ## Fail-open when the guard is not bound, and why that is the right default
 *
 * Both collaborators are `@Optional()`, the house idiom for a service that has to
 * compile in a bare test shell. An unbound guard means the installation has no
 * budget layer wired at all (`BudgetsModule` absent), in which case there is no
 * cap to enforce and refusing every contribution run would be inventing one. The
 * decision says which happened (`gate: 'passed' | 'ungated'`) rather than
 * pretending the two are the same thing.
 */

/** The two runs this epic books against the Work's budget (plan §7, §2.5, §2.6). */
export const UPSTREAM_CONTRIBUTION_RUN_KINDS = ['preparation', 'review_follow_up'] as const;

export type UpstreamContributionRunKind = (typeof UPSTREAM_CONTRIBUTION_RUN_KINDS)[number];

/**
 * The plugin id the booking is scoped to.
 *
 * `BudgetGuardService.checkBudget` resolves the Work's **global** budget plus the
 * budget scoped to this plugin id. A contribution run is an agent run, not a call
 * to a plugin, so this id exists to make the plugin-scoped half explicit and
 * addressable: no `work_budgets` row carries it today, which is why the Work's
 * **global** budget is what binds — exactly the "App Work's own budget" FR-44
 * names. A plugin-scoped cap added under this id later applies as well, without a
 * change here.
 */
export const UPSTREAM_CONTRIBUTION_PLUGIN_ID = 'app-works-upstream';

/** The capability the booking is recorded under (`plugin_usage_events.capability`). */
export const UPSTREAM_CONTRIBUTION_CAPABILITY = PluginUsageCapability.UPSTREAM_CONTRIBUTION;

/** `waiting` on the wire — T44's own word. */
export const UPSTREAM_BUDGET_WAIT = 'budget';

/** The named code the wait carries, beside `waiting`. */
export const UPSTREAM_BUDGET_WAIT_CODE = 'budgetExceeded';

/**
 * The status the write routes answer a budget wait with — **`202`, not `422`**.
 *
 * A budget refusal is not a refusal of the proposal: the row keeps its state and
 * the run resumes when the budget allows, so `422` (the code every genuine
 * upstream refusal uses) would tell the member their proposal failed. Exported so
 * the controller that lands cannot pick the wrong one by hand.
 */
export const UPSTREAM_BUDGET_WAIT_HTTP_STATUS = 202;

/**
 * The copy key the waiting surface renders (FR-36: keys and parameters, never
 * assembled English), beside the credential pause's own table.
 */
export const UPSTREAM_BUDGET_I18N = {
    waiting: 'dashboard.workDetail.upstream.budgetWaiting',
} as const;

/** What an upstream contribution run asks the budget gate to decide. */
export interface UpstreamContributionRunRequest {
    /** The App Work whose budget is booked — never the Task's, never the member's. */
    readonly workId: string;
    /** The member the run is attributed to (the booking's `userId`). */
    readonly userId: string;
    /** Which of this epic's runs it is. */
    readonly kind: UpstreamContributionRunKind;
    /**
     * The state the row keeps while it waits — echoed into the wait so the write
     * route can answer `{ state, waiting, resetAt }` without re-reading the row
     * it deliberately did not change.
     */
    readonly rowState: string;
    /** Override for the plugin-scoped half of the lookup; defaults to {@link UPSTREAM_CONTRIBUTION_PLUGIN_ID}. */
    readonly pluginId?: string;
    /**
     * Worst-case cost of the run in cents, when the caller can estimate it, so a
     * single expensive run cannot cross the cap by an order of magnitude
     * (`BudgetGuardService`'s pre-flight).
     */
    readonly estimatedCostCents?: number;
    /** Injectable clock, for a deterministic `resetAt` in a spec. */
    readonly now?: Date;
}

/** The wait a budget refusal produces. */
export interface UpstreamBudgetWait {
    readonly waiting: typeof UPSTREAM_BUDGET_WAIT;
    readonly code: typeof UPSTREAM_BUDGET_WAIT_CODE;
    /** ISO instant the budget resets — what the member is shown, and when the run resumes. */
    readonly resetAt: string;
    /** The same instant in epoch ms, for a caller that renders a countdown. */
    readonly resetAtMs: number;
    /** The state the row keeps (echoed from the request; nothing was changed). */
    readonly rowState: string;
    readonly kind: UpstreamContributionRunKind;
    /** Which budget blocked: the Work's global cap, or a plugin-scoped one. */
    readonly scope: WorkBudgetScope | null;
    readonly pluginId: string | null;
    readonly currentSpendCents: number;
    readonly capCents: number;
    readonly currency: string;
}

/** The gate's answer: allowed, or waiting. */
export type UpstreamBudgetDecision =
    | { readonly allowed: true; readonly gate: 'passed' | 'ungated' }
    | { readonly allowed: false; readonly wait: UpstreamBudgetWait };

/**
 * The wire shape T44 fixes for the write routes:
 * `202 { state, waiting: 'budget', resetAt }`.
 *
 * `code` and `limit` are **additive** beside those three: the code is what the
 * approval surface keys its copy off (§6's `{ code }` idiom), and `limit` is the
 * cap and the spend the member is waiting on, which FR-44 also puts on the App
 * Work's overview. A caller that only reads the three contracted fields is
 * unaffected by them.
 */
export interface UpstreamBudgetWaitResponse {
    readonly state: string;
    readonly waiting: typeof UPSTREAM_BUDGET_WAIT;
    readonly resetAt: string;
    readonly code: typeof UPSTREAM_BUDGET_WAIT_CODE;
    readonly limit: {
        readonly scope: WorkBudgetScope | null;
        readonly pluginId: string | null;
        readonly currentSpendCents: number;
        readonly capCents: number;
        readonly currency: string;
    };
}

/** Project a wait onto the response the write routes and `GET …/:prId` answer with. */
export function toUpstreamBudgetWaitResponse(wait: UpstreamBudgetWait): UpstreamBudgetWaitResponse {
    return {
        state: wait.rowState,
        waiting: wait.waiting,
        resetAt: wait.resetAt,
        code: wait.code,
        limit: {
            scope: wait.scope,
            pluginId: wait.pluginId,
            currentSpendCents: wait.currentSpendCents,
            capCents: wait.capCents,
            currency: wait.currency,
        },
    };
}

/** What {@link UpstreamContributionBudgetService.dispatch} did. */
export type UpstreamContributionDispatch<T> =
    | { readonly dispatched: true; readonly result: T }
    | {
          readonly dispatched: false;
          readonly wait: UpstreamBudgetWait;
          readonly response: UpstreamBudgetWaitResponse;
      };

/**
 * Does this look like a `BudgetExceededException`?
 *
 * `instanceof` alone is the right test inside this package, where one module
 * instance owns the class. The structural arm is the same defence
 * `isAppUpstreamRefusalError` uses: a bundled copy of the agent package (the API
 * build does exactly that) produces a **look-alike** class, and a gate that
 * stopped recognising it would turn every budget refusal into a 500.
 */
export function isBudgetExceededLike(value: unknown): value is BudgetExceededException {
    if (value instanceof BudgetExceededException) return true;
    if (!value || typeof value !== 'object') return false;
    const candidate = value as {
        getStatus?: () => number;
        details?: { scope?: unknown; capCents?: unknown; currentSpendCents?: unknown };
        name?: string;
    };
    if (typeof candidate.getStatus !== 'function') return false;
    const details = candidate.details;
    return (
        candidate.getStatus() === 402 &&
        candidate.name === 'BudgetExceededException' &&
        Boolean(details) &&
        typeof details?.capCents === 'number' &&
        typeof details?.currentSpendCents === 'number'
    );
}

/**
 * First day of the next calendar month at 00:00:00 UTC — the fallback boundary
 * used only when no `BudgetService` is bound.
 *
 * It is the same rule `BudgetService.getNextPeriodStart` states, and the spec
 * asserts the two agree; the injected service is the authority whenever it is
 * present, because the platform's period rule must have exactly one definition.
 */
export function nextPeriodStartUtc(now: Date): Date {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

@Injectable()
export class UpstreamContributionBudgetService {
    private readonly logger = new Logger(UpstreamContributionBudgetService.name);

    constructor(
        // Both `@Optional()` and in a stable order, the house idiom for a service
        // whose collaborators must not make a bare shell uncompilable.
        @Optional() private readonly guard?: BudgetGuardService,
        @Optional() private readonly budgets?: BudgetService,
    ) {}

    /**
     * Decide whether one contribution run may be booked — **without dispatching
     * anything**.
     *
     * Exported separately from {@link dispatch} because a caller sometimes has to
     * ask before it has a run to start (the write route answering `202` is exactly
     * that case), and asking twice must never book twice.
     */
    async book(request: UpstreamContributionRunRequest): Promise<UpstreamBudgetDecision> {
        const pluginId = request.pluginId ?? UPSTREAM_CONTRIBUTION_PLUGIN_ID;
        const now = request.now ?? new Date();

        if (!this.guard) {
            // No budget layer in this installation: nothing to enforce, and
            // saying so is not the same as saying the run passed a gate.
            return { allowed: true, gate: 'ungated' };
        }

        try {
            await this.guard.checkBudget(
                request.workId,
                request.userId,
                UPSTREAM_CONTRIBUTION_CAPABILITY,
                pluginId,
                {
                    estimatedCostCents: Math.max(0, Math.round(request.estimatedCostCents ?? 0)),
                    now,
                },
            );
            return { allowed: true, gate: 'passed' };
        } catch (error) {
            if (isBudgetExceededLike(error)) {
                return { allowed: false, wait: this.buildWait(request, error, pluginId, now) };
            }
            // A guard that threw for any other reason (a database outage, a
            // programming error) is NOT a budget refusal. Swallowing it into a
            // wait would report "your budget is spent" for a platform fault.
            this.logger.warn(
                `Upstream contribution run (${request.kind}, work ${request.workId}) could not be ` +
                    `booked against the Work budget: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
            );
            throw error;
        }
    }

    /**
     * Book the run and, only when the budget allows, run it — **at most once**.
     *
     * `run` is a thunk rather than a promise so that a refused booking never
     * starts the work: a caller cannot accidentally dispatch while building the
     * argument. On a refusal nothing is invoked, and the caller is handed both the
     * typed wait and the wire projection for its `202`.
     */
    async dispatch<T>(
        request: UpstreamContributionRunRequest,
        run: () => Promise<T>,
    ): Promise<UpstreamContributionDispatch<T>> {
        const decision = await this.book(request);
        // The cast is the tsconfig's fault, not the type's: `strictNullChecks` is
        // off in this package, so TypeScript does not collapse a union on a
        // boolean-literal discriminant and `decision.wait` reads as absent even
        // inside the `allowed === false` arm. The property is genuinely there —
        // `book` builds exactly one of the two arms — and this is the one place
        // that has to say so.
        const wait = decision.allowed
            ? null
            : (decision as { readonly wait: UpstreamBudgetWait }).wait;
        if (wait) {
            return {
                dispatched: false,
                wait,
                response: toUpstreamBudgetWaitResponse(wait),
            };
        }
        return { dispatched: true, result: await run() };
    }

    private buildWait(
        request: UpstreamContributionRunRequest,
        error: BudgetExceededException,
        pluginId: string,
        now: Date,
    ): UpstreamBudgetWait {
        // The boundary the spend was measured against: `BudgetService` when it is
        // bound, and its own rule when this shell has no budget service at all.
        const resetAt = this.budgets?.getNextPeriodStart(now) ?? nextPeriodStartUtc(now);
        const details = error.details;
        return {
            waiting: UPSTREAM_BUDGET_WAIT,
            code: UPSTREAM_BUDGET_WAIT_CODE,
            resetAt: resetAt.toISOString(),
            resetAtMs: resetAt.getTime(),
            rowState: request.rowState,
            kind: request.kind,
            scope: (details?.scope as WorkBudgetScope | undefined) ?? null,
            pluginId: details?.pluginId ?? pluginId,
            currentSpendCents: details?.currentSpendCents ?? 0,
            capCents: details?.capCents ?? 0,
            currency: details?.currency ?? 'usd',
        };
    }
}
