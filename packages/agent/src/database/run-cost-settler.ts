/**
 * Pricing Wave 9 M2 — run-cost settlement seam.
 *
 * Token + contract for the hook `AgentRunRepository` fires after every
 * terminal transition (completed / failed / dispatch-failed / cancelled /
 * stuck-swept). Same circular-dep dodge as the agent injection tokens
 * (`docs/architecture/agent-injection-tokens.md`): the repository lives
 * in `DatabaseModule`, while the implementation
 * (`RunCostSettlementService`) lives in `SubscriptionsModule` which
 * itself imports `DatabaseModule` — direct injection would cycle. The
 * api-side `@Global()` SubscriptionsModule binds this token to the real
 * service; unit tests and installs without the credits stack leave it
 * unbound and the repository's `@Optional()` injection no-ops.
 *
 * The settlement itself is best-effort BY CONTRACT: implementations must
 * never throw (a credits/metering outage must never fail or delay a
 * run's terminal write), and the repository additionally guards the call.
 */

/** Outcome of one settlement pass — returned for observability/tests. */
export interface RunSettlementResult {
    runId: string;
    /**
     * - `settled`   — costCents stamped; debit recorded (or nothing owed).
     * - `partial`   — balance could not cover the debit; a partial debit
     *                 down to zero was recorded + notification emitted.
     * - `exhausted` — balance was already ≤ 0; zero debit + notification.
     * - `skipped`   — no run row, or no usage events tagged with the run.
     * - `error`     — settlement failed internally (logged, never thrown).
     */
    status: 'settled' | 'partial' | 'exhausted' | 'skipped' | 'error';
    /** Metered spend summed over the run's tagged usage events. */
    totalCostCents: number;
    /** Spend actually billable to credits (BYOK-exempt plugins removed). */
    billableCostCents: number;
    /** Credits actually debited (0 when nothing was owed / exhausted). */
    debitedCredits: number;
    /** Plugins excluded because their calls ran on user-supplied keys. */
    exemptPluginIds: string[];
}

export interface RunCostSettler {
    /** Never rejects — failures are absorbed + logged by the implementation. */
    settleRun(runId: string): Promise<RunSettlementResult>;
}

export const RUN_COST_SETTLER = 'RUN_COST_SETTLER' as const;
