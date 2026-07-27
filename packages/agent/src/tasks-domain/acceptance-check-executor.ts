import { spawn } from 'child_process';
import { join } from 'path';
import type { GateStatus, TaskAcceptanceCheck, TaskCheckResult } from '@ever-works/contracts';
import { buildCheckEnv } from './check-env';

/**
 * Acceptance-check EXECUTION — the one place a check command becomes a
 * real subprocess with a real exit code.
 *
 * Extracted from `TaskGateRunnerService` (Wave 3 M2) so the same execution
 * semantics can back BOTH gate consumers without a second implementation:
 *
 *  - `TaskGateRunnerService` — the worker's post-run gate, which also
 *    persists the verdict onto `agent_runs`;
 *  - `PullRequestGateService` — the non-worker PR gate, which owns no run
 *    row and therefore persists nothing.
 *
 * Nothing here reads or writes the database, so a caller with no
 * `AgentRun` context can use it as-is.
 */

/** Wall-clock budget applied when a check declares no `timeoutSec`. */
export const DEFAULT_CHECK_TIMEOUT_SEC = 600;

/**
 * Hard per-check ceiling. A hostile/typo'd `timeoutSec` on a simple-json
 * column must never let one check eat the whole Trigger.dev `maxDuration`.
 */
export const MAX_CHECK_TIMEOUT_SEC = 1800;

/** Last-N-bytes window of combined stdout/stderr kept as `logTail`. */
export const CHECK_LOG_TAIL_BYTES = 4096;

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
export function executeAcceptanceCheck(
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

/**
 * Run a check list sequentially, in declared order — deterministic
 * reports, no resource contention between e.g. a build and a test run.
 * Results are index-aligned with `checks`.
 */
export async function executeAcceptanceChecks(
    checks: readonly TaskAcceptanceCheck[],
    cwd: string,
    ceilingSec?: number,
): Promise<TaskCheckResult[]> {
    const results: TaskCheckResult[] = [];
    for (const check of checks) {
        results.push(await executeAcceptanceCheck(check, cwd, ceilingSec));
    }
    return results;
}

/**
 * The gate is red iff any REQUIRED check is not green. `required:false`
 * checks report but can never turn the gate red.
 *
 * `results` MUST be index-aligned with `checks` (as
 * {@link executeAcceptanceChecks} returns them).
 */
export function computeGateStatus(
    checks: readonly TaskAcceptanceCheck[],
    results: readonly TaskCheckResult[],
): GateStatus {
    const failedRequired = checks.filter(
        (check, index) => check.required !== false && results[index]?.status !== 'green',
    );
    return failedRequired.length > 0 ? 'red' : 'green';
}
