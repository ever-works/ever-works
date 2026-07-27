import { Injectable, Logger } from '@nestjs/common';
import type {
    GateStatus,
    TaskAcceptanceCheck,
    TaskCheckResult,
    WorkChecksPolicy,
} from '@ever-works/contracts';
import {
    computeGateStatus,
    executeAcceptanceChecks,
} from '../tasks-domain/acceptance-check-executor';
import { resolveAcceptanceChecks, resolveChecksPolicy } from '../tasks-domain/task-gates';

/**
 * The Work columns this decision reads. Deliberately a structural shape,
 * not the `Work` entity: every caller already holds the row (or a
 * repository lookup of it), and a structural parameter keeps this module a
 * leaf that unit tests can drive with a two-field literal.
 */
export interface PullRequestGateWork {
    id?: string;
    checksPolicy?: WorkChecksPolicy;
    checkDefaults?: TaskAcceptanceCheck[] | null;
}

export interface PullRequestGateInput {
    /** The Work whose `checksPolicy` / `checkDefaults` govern the decision. */
    work: PullRequestGateWork | null | undefined;
    /**
     * Checkout the check commands run in. Omitted (or empty) means the
     * caller has no working tree to judge — see the class docblock for why
     * that refuses under `required` and passes under `warn`.
     */
    cwd?: string | null;
    /** Short caller label used in log lines only (e.g. `item-submission`). */
    context?: string;
}

export interface PullRequestGateDecision {
    /** May the caller open the pull request? */
    allowed: boolean;
    /** The Work policy that produced this decision (`off` when unset). */
    policy: WorkChecksPolicy;
    /** Aggregate verdict, in the worker's own `GateStatus` vocabulary. */
    gateStatus: GateStatus;
    /** Per-check results; empty when nothing was executed. */
    results: TaskCheckResult[];
    /** Human-readable explanation. Present only when `allowed` is false. */
    reason?: string;
}

/**
 * Thrown by {@link PullRequestGateService.assertAllowed} when the gate
 * refuses. Carries the full decision so a caller can report the failing
 * check ids without re-deriving them.
 *
 * `name` is assigned explicitly (not derived from `constructor.name`) so
 * it survives minification and can be matched by string at boundaries.
 */
export class PullRequestGateRefusedError extends Error {
    constructor(
        message: string,
        public readonly decision: PullRequestGateDecision,
    ) {
        super(message);
        this.name = 'PullRequestGateRefusedError';
    }
}

/**
 * Quality gates — the PR gate for NON-worker pull-request creation.
 *
 * WHY THIS EXISTS
 * ---------------
 * "A red check opens no PR" was implemented only in the `agent-task-execute`
 * worker step: it runs the Work's acceptance checks and, under
 * `checksPolicy: 'required'`, withholds `TaskWorkspaceService.finalizeRun`
 * (and therefore the PR) on anything other than a green gate. Every OTHER
 * pull request the platform opens — item submit / remove / update, the
 * CSV/Excel bulk import, the data-generator update + source-sync flows, the
 * markdown-generator sync, and the `openPullRequest` Agent tool — called
 * `GitFacadeService.createPullRequest` directly and never consulted the
 * gate at all. This service is the shared decision those callers route
 * through, using the SAME resolution helpers (`resolveChecksPolicy`,
 * `resolveAcceptanceChecks`) and the SAME executor
 * (`acceptance-check-executor`) as the worker.
 *
 * DECISION TABLE
 * --------------
 * | policy     | checks     | verdict | allowed |
 * |------------|------------|---------|---------|
 * | `off`      | (ignored)  | none    | yes     |
 * | `warn`     | none       | none    | yes     |
 * | `warn`     | red        | red     | yes     |
 * | `warn`     | green      | green   | yes     |
 * | `required` | none       | skipped | NO      |
 * | `required` | red        | red     | NO      |
 * | `required` | green      | green   | yes     |
 *
 * Three properties are load-bearing:
 *
 * 1. **`off` is a true no-op.** It is the column default, so every Work
 *    that never opted in behaves EXACTLY as it did before this service
 *    existed — no subprocess, no repository read, no log line.
 * 2. **`warn` never blocks.** That is the whole meaning of the policy: the
 *    checks run and report, red included, and the PR still opens.
 * 3. **A gate that could not run does not pass under `required`.** Zero
 *    resolved checks map to `skipped` (mirroring `TaskGateRunnerService`),
 *    and a caller with no checkout is treated the same way — a Work that
 *    demands verification must not get an unverified PR.
 *
 * Checks resolve from the Work's `checkDefaults` only: these flows have no
 * Task, so there is nothing to merge over the defaults.
 */
@Injectable()
export class PullRequestGateService {
    private readonly logger = new Logger(PullRequestGateService.name);

    /**
     * Evaluate the gate. Never throws for a refusal — callers with a
     * result-object contract branch on `allowed`; callers that want an
     * exception use {@link assertAllowed}.
     */
    async evaluate(input: PullRequestGateInput): Promise<PullRequestGateDecision> {
        const policy = resolveChecksPolicy(input.work);
        if (policy === 'off') {
            // The default. Nothing is resolved, nothing is executed and
            // nothing is logged — byte-for-byte the pre-gate behaviour.
            return { allowed: true, policy, gateStatus: 'none', results: [] };
        }

        const checks = resolveAcceptanceChecks(null, input.work);
        const label = input.context ? `${input.context}: ` : '';

        if (checks.length === 0) {
            // Zero checks under `required` is 'skipped', never 'green' —
            // the same mapping `TaskGateRunnerService.runChecks` makes.
            const gateStatus: GateStatus = policy === 'required' ? 'skipped' : 'none';
            return this.decide({
                allowed: policy !== 'required',
                policy,
                gateStatus,
                results: [],
                reason:
                    'This Work requires acceptance checks before a pull request may be opened, ' +
                    'but none are configured. Add checks to the Work defaults, or change the checks policy.',
                label,
            });
        }

        if (!input.cwd) {
            // No working tree to judge. Under `required` that is a refusal
            // for the same reason a crashed gate fails the worker's run: a
            // gate that did not run must not pass anything.
            return this.decide({
                allowed: policy !== 'required',
                policy,
                gateStatus: 'skipped',
                results: [],
                reason:
                    'This Work requires acceptance checks before a pull request may be opened, ' +
                    'but no checkout was available to run them in.',
                label,
            });
        }

        let results: TaskCheckResult[];
        try {
            results = await executeAcceptanceChecks(checks, input.cwd);
        } catch (error) {
            // Executing the gate is not supposed to throw (spawn failures
            // surface as an 'error' result), so this is an unexpected
            // fault. Same posture as above: `required` refuses, `warn`
            // reports and continues.
            const message = error instanceof Error ? error.message : String(error);
            this.logger.error(`${label}quality gate execution failed: ${message}`);
            return this.decide({
                allowed: policy !== 'required',
                policy,
                gateStatus: 'skipped',
                results: [],
                reason: `The quality gate could not be executed: ${message}`,
                label,
            });
        }

        const gateStatus = computeGateStatus(checks, results);
        // Pair BEFORE filtering — filtering first would re-index the list
        // and mislabel every failing check after the first pass.
        const failing = checks
            .map((check, index) => ({ check, result: results[index] }))
            .filter(({ check, result }) => check.required !== false && result?.status !== 'green')
            .map(({ check, result }) => `${check.id} (${result?.status ?? 'unknown'})`);

        return this.decide({
            allowed: policy !== 'required' || gateStatus === 'green',
            policy,
            gateStatus,
            results,
            reason: `Quality gate red — failing required checks: ${failing.join(', ')}.`,
            label,
        });
    }

    /**
     * Evaluate and THROW {@link PullRequestGateRefusedError} on a refusal.
     * For callers whose contract is "return a pull request or fail" — the
     * `openPullRequest` Agent tool, most obviously.
     */
    async assertAllowed(input: PullRequestGateInput): Promise<PullRequestGateDecision> {
        const decision = await this.evaluate(input);
        if (!decision.allowed) {
            throw new PullRequestGateRefusedError(
                decision.reason ?? 'The quality gate refused this pull request.',
                decision,
            );
        }
        return decision;
    }

    /**
     * Attach the log line every non-`off` decision deserves, then return
     * it. A refusal is an ERROR (a PR the operator expected did not open);
     * a pass under a configured policy is a LOG (the audit trail that the
     * gate actually ran).
     */
    private decide(args: {
        allowed: boolean;
        policy: WorkChecksPolicy;
        gateStatus: GateStatus;
        results: TaskCheckResult[];
        reason: string;
        label: string;
    }): PullRequestGateDecision {
        const { allowed, policy, gateStatus, results, reason, label } = args;
        if (!allowed) {
            this.logger.error(
                `${label}pull request WITHHELD (checks policy '${policy}', gate '${gateStatus}'): ${reason}`,
            );
            return { allowed, policy, gateStatus, results, reason };
        }
        if (gateStatus === 'red') {
            // 'warn' — reported honestly, but never blocking.
            this.logger.warn(
                `${label}quality gate red under checks policy 'warn' — opening the pull request anyway: ${reason}`,
            );
        } else {
            this.logger.log(
                `${label}quality gate '${gateStatus}' under checks policy '${policy}' — pull request allowed.`,
            );
        }
        return { allowed, policy, gateStatus, results };
    }
}
