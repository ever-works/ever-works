import { Injectable, Logger } from '@nestjs/common';
import { spawn } from 'child_process';
import { join } from 'path';
import type {
    GateStatus,
    TaskAcceptanceCheck,
    TaskCheckResult,
    WorkChecksPolicy,
} from '@ever-works/contracts';
import { AgentRunRepository } from '../database/repositories/agent-run.repository';
import { config } from '../config';
import { buildCheckEnv } from './check-env';

/** Wall-clock budget applied when a check declares no `timeoutSec`. */
export const DEFAULT_CHECK_TIMEOUT_SEC = 600;

/**
 * Hard per-check ceiling. A hostile/typo'd `timeoutSec` on a simple-json
 * column must never let one check eat the whole Trigger.dev `maxDuration`.
 */
export const MAX_CHECK_TIMEOUT_SEC = 1800;

/** Last-N-bytes window of combined stdout/stderr kept as `logTail`. */
export const CHECK_LOG_TAIL_BYTES = 4096;

export interface RunChecksInput {
    /** The dispatch-frozen check set (`agent_runs.resolvedChecks`). */
    checks: TaskAcceptanceCheck[];
    /** Checkout root the commands run in (`check.cwd` joins under it). */
    cwd: string;
    /** Run the results are persisted onto. */
    runId: string;
    /**
     * The Work's enforcement policy — only consulted for the empty-check
     * mapping (`required` → 'skipped', anything else → 'none'). When the
     * caller omits it, the mapping fails toward 'none' (never toward
     * blocking), mirroring `resolveChecksPolicy`'s posture.
     */
    policy?: WorkChecksPolicy;
    /**
     * Which gate attempt this execution is (Wave 3 M5 iterate loop) —
     * persisted onto `agent_runs.gateAttempts` so a crash/resume cannot
     * reset the bounded loop. Defaults to 1 (the single-attempt M2/M3
     * behavior) when the caller doesn't iterate.
     */
    attempt?: number;
}

export interface RunChecksOutcome {
    gateStatus: GateStatus;
    results: TaskCheckResult[];
}

/**
 * Quality gates (Wave 3 M2) — the acceptance-check runner.
 *
 * Harness code, not agent tool calls: after the agent loop for a Task run
 * completes, the worker step hands this service the run's dispatch-frozen
 * check set and the workspace checkout, and each check's command is
 * spawned as a real subprocess. Exit codes are observed by the process
 * supervisor — the agent's transcript claims are irrelevant.
 *
 * Verdict rules:
 * - exit 0 → check 'green'; nonzero → 'red'; killed at its timeout →
 *   'timeout'; unspawnable (bad cwd, missing shell) → 'error' — infra
 *   problems are distinguishable from code problems.
 * - the GATE is red iff any REQUIRED check is not green. `required:false`
 *   checks report but can never turn the gate red.
 * - zero checks: 'skipped' under policy 'required' (a skipped gate must
 *   never render as green), 'none' otherwise.
 *
 * Checks run sequentially, in declared order — deterministic reports, no
 * resource contention between e.g. a build and a test run.
 */
@Injectable()
export class TaskGateRunnerService {
    private readonly logger = new Logger(TaskGateRunnerService.name);

    constructor(private readonly runs: AgentRunRepository) {}

    /**
     * Judgment layer G2 — the **L0 pre-check**: run the cheap structural
     * checks BEFORE the model call, so an obviously broken workspace is
     * described to the agent instead of discovered by it.
     *
     * Three deliberate differences from {@link runChecks}:
     *
     * 1. **Nothing is persisted.** No `gateStatus`, no `checkResults`, no
     *    `gateAttempts`. A pre-check is not a verdict on the run's work —
     *    the work has not happened yet — and writing one would make the
     *    Sessions view show a red gate for a run that never executed.
     * 2. **It never blocks.** The caller feeds the output into the prompt
     *    and continues, whatever the result. A pre-check that could fail
     *    a run would turn a misconfigured lint command into an outage.
     * 3. **Its own tighter timeout.** Capped by
     *    `AGENT_GATE_L0_PRECHECK_TIMEOUT_SEC` (default 120s) on top of
     *    each check's own `timeoutSec`: a pre-check exists to be cheap,
     *    and one that approaches the post-run gate's 30-minute ceiling is
     *    a regression, not a feature.
     */
    async runPreChecks(input: {
        checks: TaskAcceptanceCheck[];
        cwd: string;
        /** Hard per-check ceiling in seconds; defaults to the config value. */
        timeoutSec?: number;
    }): Promise<{ results: TaskCheckResult[]; failing: TaskCheckResult[] }> {
        const checks = Array.isArray(input.checks) ? input.checks : [];
        if (checks.length === 0) return { results: [], failing: [] };

        const ceiling =
            typeof input.timeoutSec === 'number' && input.timeoutSec > 0
                ? input.timeoutSec
                : config.agents.getGateL0PreCheckTimeoutSec();

        const results: TaskCheckResult[] = [];
        for (const check of checks) {
            results.push(await this.executeCheck(check, input.cwd, ceiling));
        }
        // `required` is irrelevant here: a pre-check is INFORMATION for the
        // prompt, so every non-green result is worth telling the agent
        // about, including the ones that could never turn the gate red.
        const failing = results.filter((result) => result.status !== 'green');
        if (failing.length > 0) {
            this.logger.log(
                `L0 pre-check: ${failing.length}/${results.length} check(s) not green — ` +
                    `feeding output into the run's first input.`,
            );
        }
        return { results, failing };
    }

    async runChecks(input: RunChecksInput): Promise<RunChecksOutcome> {
        const checks = Array.isArray(input.checks) ? input.checks : [];

        if (checks.length === 0) {
            const gateStatus: GateStatus = input.policy === 'required' ? 'skipped' : 'none';
            // gateAttempts stays untouched (default 0): nothing executed,
            // so no attempt was consumed.
            await this.persist(input.runId, [], gateStatus);
            return { gateStatus, results: [] };
        }

        const results: TaskCheckResult[] = [];
        for (const check of checks) {
            results.push(await this.executeCheck(check, input.cwd));
        }

        const failedRequired = checks.filter(
            (check, index) => check.required !== false && results[index].status !== 'green',
        );
        const gateStatus: GateStatus = failedRequired.length > 0 ? 'red' : 'green';

        // Attempt counter threaded from the M5 iterate loop; clamped so a
        // bad caller value can never write a nonsense counter. Defaults to
        // 1 — the single-attempt M2/M3 behavior.
        const attempt =
            typeof input.attempt === 'number' && Number.isFinite(input.attempt)
                ? Math.max(1, Math.trunc(input.attempt))
                : 1;
        await this.persist(input.runId, results, gateStatus, attempt);
        return { gateStatus, results };
    }

    /**
     * Persist the verdict onto the run. Best-effort BY DESIGN: the gate
     * decision the worker enforces is the returned value; a DB hiccup here
     * must not convert an honest verdict into a failed run. The warn keeps
     * the miss observable.
     */
    private async persist(
        runId: string,
        checkResults: TaskCheckResult[],
        gateStatus: GateStatus,
        gateAttempts?: number,
    ): Promise<void> {
        try {
            await this.runs.updateGateResults(runId, {
                checkResults,
                gateStatus,
                ...(gateAttempts !== undefined ? { gateAttempts } : {}),
            });
        } catch (error) {
            this.logger.warn(
                `gate results persist failed for run ${runId}: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }

    /**
     * Spawn one check command and observe its real exit code.
     *
     * `shell: true` — a check is "a command and an exit code", authored the
     * way package scripts are (`pnpm build`, `npm test -- --ci`), so it gets
     * the platform shell. This adds no privilege beyond the status quo:
     * pipeline agents already run arbitrary commands in the same checkout,
     * and only Work members with settings/Task-edit rights author checks.
     *
     * The child env is SCRUBBED (`buildCheckEnv`), never inherited: the
     * command is user-authored, so `env`/`printenv` in a check must not be
     * able to read the platform's database, auth, Trigger or plugin
     * credentials. A check that genuinely needs one more variable names it
     * in `envPassthrough`.
     */
    private executeCheck(
        check: TaskAcceptanceCheck,
        rootCwd: string,
        /**
         * Judgment layer G2 — optional tighter ceiling for the L0
         * pre-check pass. Omitted = the normal `MAX_CHECK_TIMEOUT_SEC`
         * gate ceiling, so the post-run path is byte-identical.
         */
        ceilingSec?: number,
    ): Promise<TaskCheckResult> {
        const cwd = check.cwd ? join(rootCwd, check.cwd) : rootCwd;
        const ceiling =
            typeof ceilingSec === 'number' && ceilingSec > 0
                ? Math.min(ceilingSec, MAX_CHECK_TIMEOUT_SEC)
                : MAX_CHECK_TIMEOUT_SEC;
        const timeoutSec = Math.min(
            typeof check.timeoutSec === 'number' && check.timeoutSec > 0
                ? check.timeoutSec
                : DEFAULT_CHECK_TIMEOUT_SEC,
            ceiling,
        );
        const startedAt = Date.now();

        return new Promise<TaskCheckResult>((resolve) => {
            let settled = false;
            let timedOut = false;
            let tail = '';
            let timer: ReturnType<typeof setTimeout> | undefined;

            const finish = (status: TaskCheckResult['status'], exitCode: number | null) => {
                if (settled) return;
                settled = true;
                if (timer) clearTimeout(timer);
                resolve({
                    id: check.id,
                    exitCode,
                    status,
                    durationMs: Date.now() - startedAt,
                    ...(tail.length > 0 ? { logTail: tail } : {}),
                });
            };

            let child: ReturnType<typeof spawn>;
            try {
                child = spawn(check.command, {
                    cwd,
                    shell: true,
                    windowsHide: true,
                    env: buildCheckEnv({ passthrough: check.envPassthrough }),
                });
            } catch (error) {
                tail = error instanceof Error ? error.message : String(error);
                finish('error', null);
                return;
            }

            timer = setTimeout(() => {
                timedOut = true;
                try {
                    child.kill('SIGKILL');
                } catch {
                    // Process already gone — the close handler settles.
                }
            }, timeoutSec * 1000);

            const append = (chunk: Buffer | string) => {
                tail = (tail + chunk.toString()).slice(-CHECK_LOG_TAIL_BYTES);
            };
            child.stdout?.on('data', append);
            child.stderr?.on('data', append);

            // Spawn failures (nonexistent cwd, missing shell) surface here,
            // not as a throw — 'error' status keeps infra problems from
            // reading as code problems.
            child.on('error', (error) => {
                append(`\n${error.message}`);
                finish('error', null);
            });

            // On timeout, settle on 'exit' (process death) instead of
            // 'close' (stdio drain): a killed shell can leave a grandchild
            // holding the pipes open, and the gate must not wait for it.
            // Destroying our read ends releases those handles immediately.
            child.on('exit', () => {
                if (timedOut) {
                    child.stdout?.destroy();
                    child.stderr?.destroy();
                    finish('timeout', null);
                }
            });

            child.on('close', (code) => {
                if (timedOut) {
                    finish('timeout', null);
                } else if (code === 0) {
                    finish('green', 0);
                } else {
                    // Killed by an external signal (code null) is still not
                    // a pass — red, with the null exit code preserved.
                    finish('red', code);
                }
            });
        });
    }
}
