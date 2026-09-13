import { join } from 'path';
import type { TaskAcceptanceCheck } from '@ever-works/contracts';
import { TaskGateRunnerService, CHECK_LOG_TAIL_BYTES } from '../task-gate-runner.service';

/**
 * Quality gates (Wave 3 M2) — the acceptance-check runner, exercised with
 * REAL subprocesses. `node -e "…"` is the one command guaranteed present
 * wherever this suite runs (the tests themselves run under node), and it
 * gives deterministic exit codes / output / hangs on every platform.
 */

const RUN_ID = 'run-gate-1';

function check(overrides: Partial<TaskAcceptanceCheck> & { id: string }): TaskAcceptanceCheck {
    return {
        name: overrides.id,
        kind: 'custom',
        command: 'node -e "process.exit(0)"',
        required: true,
        ...overrides,
    };
}

describe('TaskGateRunnerService.runChecks', () => {
    let runs: { updateGateResults: jest.Mock };
    let runner: TaskGateRunnerService;

    beforeEach(() => {
        runs = { updateGateResults: jest.fn().mockResolvedValue(undefined) };
        runner = new TaskGateRunnerService(runs as never);
        jest.spyOn(
            (runner as never as { logger: { warn: (m: string) => void } }).logger,
            'warn',
        ).mockImplementation(() => undefined);
    });

    afterEach(() => jest.restoreAllMocks());

    it('exit 0 → check green with the real exit code, gate green', async () => {
        const outcome = await runner.runChecks({
            checks: [check({ id: 'ok' })],
            cwd: process.cwd(),
            runId: RUN_ID,
        });
        expect(outcome.gateStatus).toBe('green');
        expect(outcome.results).toHaveLength(1);
        expect(outcome.results[0]).toMatchObject({ id: 'ok', status: 'green', exitCode: 0 });
        expect(outcome.results[0].durationMs).toBeGreaterThanOrEqual(0);
    });

    it('nonzero exit on a required check → check red with its exit code, gate red', async () => {
        const outcome = await runner.runChecks({
            checks: [check({ id: 'boom', command: 'node -e "process.exit(3)"' })],
            cwd: process.cwd(),
            runId: RUN_ID,
        });
        expect(outcome.gateStatus).toBe('red');
        expect(outcome.results[0]).toMatchObject({ id: 'boom', status: 'red', exitCode: 3 });
    });

    it('a required:false check can fail without turning the gate red', async () => {
        const outcome = await runner.runChecks({
            checks: [
                check({ id: 'ok' }),
                check({
                    id: 'advisory',
                    required: false,
                    command: 'node -e "process.exit(1)"',
                }),
            ],
            cwd: process.cwd(),
            runId: RUN_ID,
        });
        // The informational failure is still REPORTED honestly…
        expect(outcome.results[1]).toMatchObject({ id: 'advisory', status: 'red', exitCode: 1 });
        // …but never blocks.
        expect(outcome.gateStatus).toBe('green');
    });

    it('a hung check is killed at its timeoutSec → status timeout, null exit code, gate red', async () => {
        const startedAt = Date.now();
        const outcome = await runner.runChecks({
            checks: [
                check({
                    id: 'hang',
                    command: 'node -e "setTimeout(function () {}, 5000)"',
                    timeoutSec: 1,
                }),
            ],
            cwd: process.cwd(),
            runId: RUN_ID,
        });
        expect(outcome.results[0]).toMatchObject({ id: 'hang', status: 'timeout', exitCode: null });
        expect(outcome.gateStatus).toBe('red');
        // Killed at ~1s, not at the command's own 5s sleep.
        expect(Date.now() - startedAt).toBeLessThan(4500);
    }, 15000);

    it('an unspawnable check (nonexistent cwd) → status error, distinguished from red', async () => {
        const outcome = await runner.runChecks({
            checks: [check({ id: 'no-cwd', cwd: 'definitely-not-a-real-subdir-xyz' })],
            cwd: process.cwd(),
            runId: RUN_ID,
        });
        expect(outcome.results[0]).toMatchObject({ id: 'no-cwd', status: 'error', exitCode: null });
        expect(outcome.gateStatus).toBe('red');
    });

    it('captures combined stdout/stderr as logTail', async () => {
        const outcome = await runner.runChecks({
            checks: [
                check({
                    id: 'noisy',
                    command:
                        'node -e "console.log(String.fromCharCode(111,117,116,45,109,97,114,107,101,114)); console.error(String.fromCharCode(101,114,114,45,109,97,114,107,101,114)); process.exit(1)"',
                }),
            ],
            cwd: process.cwd(),
            runId: RUN_ID,
        });
        expect(outcome.results[0].logTail).toContain('out-marker');
        expect(outcome.results[0].logTail).toContain('err-marker');
    });

    it('keeps only the LAST ~4KB of output as logTail', async () => {
        const outcome = await runner.runChecks({
            checks: [
                check({
                    id: 'chatty',
                    // 10KB of 'a', then a tail marker — the head must be
                    // dropped, the tail kept.
                    command:
                        'node -e "process.stdout.write(new Array(10001).join(String.fromCharCode(97))); process.stdout.write(String.fromCharCode(84,65,73,76,45,69,78,68))"',
                }),
            ],
            cwd: process.cwd(),
            runId: RUN_ID,
        });
        const tail = outcome.results[0].logTail ?? '';
        expect(tail.length).toBeLessThanOrEqual(CHECK_LOG_TAIL_BYTES);
        expect(tail.endsWith('TAIL-END')).toBe(true);
    });

    it('joins check.cwd under the checkout root', async () => {
        const outcome = await runner.runChecks({
            checks: [
                check({
                    id: 'where',
                    cwd: '__tests__',
                    command: 'node -e "console.log(process.cwd())"',
                }),
            ],
            cwd: join(__dirname, '..'),
            runId: RUN_ID,
        });
        expect(outcome.results[0].status).toBe('green');
        expect(outcome.results[0].logTail).toContain('__tests__');
    });

    it('runs checks sequentially, reporting results in declared order', async () => {
        const outcome = await runner.runChecks({
            checks: [
                check({ id: 'first' }),
                check({ id: 'second', command: 'node -e "process.exit(2)"' }),
                check({ id: 'third' }),
            ],
            cwd: process.cwd(),
            runId: RUN_ID,
        });
        expect(outcome.results.map((r) => r.id)).toEqual(['first', 'second', 'third']);
        expect(outcome.gateStatus).toBe('red');
    });

    describe('empty check set — gate per policy, skipped is never green', () => {
        it("policy 'off' → gateStatus none", async () => {
            const outcome = await runner.runChecks({
                checks: [],
                cwd: process.cwd(),
                runId: RUN_ID,
                policy: 'off',
            });
            expect(outcome).toEqual({ gateStatus: 'none', results: [] });
        });

        it("policy 'warn' → gateStatus none (reports, never blocks)", async () => {
            const outcome = await runner.runChecks({
                checks: [],
                cwd: process.cwd(),
                runId: RUN_ID,
                policy: 'warn',
            });
            expect(outcome).toEqual({ gateStatus: 'none', results: [] });
        });

        it("policy 'required' → gateStatus skipped — a gate that did not run must never read green", async () => {
            const outcome = await runner.runChecks({
                checks: [],
                cwd: process.cwd(),
                runId: RUN_ID,
                policy: 'required',
            });
            expect(outcome).toEqual({ gateStatus: 'skipped', results: [] });
        });

        it('omitted policy fails toward none, and no gate attempt is recorded', async () => {
            const outcome = await runner.runChecks({
                checks: [],
                cwd: process.cwd(),
                runId: RUN_ID,
            });
            expect(outcome.gateStatus).toBe('none');
            expect(runs.updateGateResults).toHaveBeenCalledWith(RUN_ID, {
                checkResults: [],
                gateStatus: 'none',
            });
        });
    });

    describe('persistence', () => {
        it('persists checkResults + gateStatus + gateAttempts=1 onto the run', async () => {
            await runner.runChecks({
                checks: [check({ id: 'ok' })],
                cwd: process.cwd(),
                runId: RUN_ID,
            });
            expect(runs.updateGateResults).toHaveBeenCalledTimes(1);
            const [runId, patch] = runs.updateGateResults.mock.calls[0];
            expect(runId).toBe(RUN_ID);
            expect(patch.gateStatus).toBe('green');
            expect(patch.gateAttempts).toBe(1);
            expect(patch.checkResults).toHaveLength(1);
            expect(patch.checkResults[0]).toMatchObject({ id: 'ok', status: 'green' });
        });

        it('persists the attempt counter threaded from the iterate loop (Wave 3 M5)', async () => {
            await runner.runChecks({
                checks: [check({ id: 'ok' })],
                cwd: process.cwd(),
                runId: RUN_ID,
                attempt: 3,
            });
            expect(runs.updateGateResults.mock.calls[0][1].gateAttempts).toBe(3);
        });

        it('clamps a nonsense attempt value to 1 instead of persisting it', async () => {
            await runner.runChecks({
                checks: [check({ id: 'ok' })],
                cwd: process.cwd(),
                runId: RUN_ID,
                attempt: -7,
            });
            expect(runs.updateGateResults.mock.calls[0][1].gateAttempts).toBe(1);
        });

        it('a persistence failure is swallowed — the verdict the caller enforces still returns', async () => {
            runs.updateGateResults.mockRejectedValue(new Error('db down'));
            const outcome = await runner.runChecks({
                checks: [check({ id: 'boom', command: 'node -e "process.exit(1)"' })],
                cwd: process.cwd(),
                runId: RUN_ID,
            });
            expect(outcome.gateStatus).toBe('red');
            expect(outcome.results[0].status).toBe('red');
        });
    });

    /**
     * Environment scrubbing, observed in a REAL child process: the check
     * command is user-authored, so `env`/`printenv` inside it must not be
     * able to read the platform's secrets.
     *
     * The probes print KEY NAMES plus one sentinel value rather than the
     * whole `JSON.stringify(process.env)`: `logTail` keeps only the last
     * ~4KB, and a Windows `PATH` alone can fill that — an absence assertion
     * over a truncated dump would be worthless.
     */
    describe('subprocess environment is scrubbed, never inherited', () => {
        const SECRET_VALUE = 'ew-gate-secret-do-not-leak';
        const GRANT_VALUE = 'ew-gate-granted-value';
        let restoreEnv: NodeJS.ProcessEnv;

        const PRINT_ENV =
            "node -e \"console.log('KEYS=' + Object.keys(process.env).sort().join(','))" +
            "; console.log('SENTINEL=' + String(process.env.EW_GATE_TEST_SECRET))" +
            "; console.log('GRANT=' + String(process.env.EW_GATE_TEST_GRANT))" +
            "; console.log('DBURL=' + String(process.env.DATABASE_URL))" +
            "; console.log('ENCKEY=' + String(process.env.PLATFORM_ENCRYPTION_KEY))" +
            "; console.log('HASPATH=' + (process.env.PATH ? 'yes' : 'no'))" +
            "; console.log('CI=' + String(process.env.CI))\"";

        beforeEach(() => {
            restoreEnv = { ...process.env };
            process.env.EW_GATE_TEST_SECRET = SECRET_VALUE;
            process.env.EW_GATE_TEST_GRANT = GRANT_VALUE;
            process.env.DATABASE_URL = `postgres://u:${SECRET_VALUE}@db/ever`;
            process.env.PLATFORM_ENCRYPTION_KEY = SECRET_VALUE;
        });

        afterEach(() => {
            process.env = restoreEnv;
        });

        const probe = async (overrides: Partial<TaskAcceptanceCheck> = {}) => {
            const outcome = await runner.runChecks({
                checks: [check({ id: 'env-probe', command: PRINT_ENV, ...overrides })],
                cwd: process.cwd(),
                runId: RUN_ID,
            });
            expect(outcome.results[0].status).toBe('green');
            return outcome.results[0].logTail ?? '';
        };

        it('a platform secret in the parent env is invisible to the check', async () => {
            const tail = await probe();
            expect(tail).toContain('SENTINEL=undefined');
            expect(tail).toContain('ENCKEY=undefined');
            expect(tail).toContain('DBURL=undefined');
            // …and the secret VALUE appears nowhere, under any name.
            expect(tail).not.toContain(SECRET_VALUE);
        });

        it('the platform secret NAMES are absent from the child key list', async () => {
            const keys = (/KEYS=(.*)/.exec(await probe())?.[1] ?? '').split(',');
            expect(keys).not.toContain('EW_GATE_TEST_SECRET');
            expect(keys).not.toContain('PLATFORM_ENCRYPTION_KEY');
            expect(keys).not.toContain('DATABASE_URL');
        });

        it('PATH survives the scrub, so the check can resolve its commands', async () => {
            const tail = await probe();
            // The probe itself is proof: `node` resolved through PATH.
            expect(tail).toContain('HASPATH=yes');
        });

        it('runs non-interactive (CI is set) so watch modes cannot hang the gate', async () => {
            expect(await probe()).not.toContain('CI=undefined');
        });

        it('an explicit envPassthrough grant reaches the subprocess', async () => {
            const tail = await probe({ envPassthrough: ['EW_GATE_TEST_GRANT'] });
            expect(tail).toContain(`GRANT=${GRANT_VALUE}`);
        });

        it('without the grant the same variable is absent (opt-in, not opt-out)', async () => {
            expect(await probe()).toContain('GRANT=undefined');
        });

        it('platform-owned configuration stays refused even when explicitly granted', async () => {
            const tail = await probe({
                envPassthrough: ['PLATFORM_ENCRYPTION_KEY', 'DATABASE_URL'],
            });
            expect(tail).toContain('ENCKEY=undefined');
            expect(tail).toContain('DBURL=undefined');
            expect(tail).not.toContain(SECRET_VALUE);
        });

        it('a check that greps its own environment finds no platform secret', async () => {
            const outcome = await runner.runChecks({
                checks: [
                    check({
                        id: 'exfiltrate',
                        // The attack from the report, verbatim in spirit:
                        // dump the environment and look for the secret.
                        command:
                            "node -e \"var hit = JSON.stringify(process.env).indexOf('ew-gate-secret-do-not-leak'); console.log('HIT=' + hit); process.exit(hit === -1 ? 0 : 9)\"",
                    }),
                ],
                cwd: process.cwd(),
                runId: RUN_ID,
            });
            expect(outcome.results[0]).toMatchObject({ status: 'green', exitCode: 0 });
            expect(outcome.results[0].logTail).toContain('HIT=-1');
        });
    });
});

describe('TaskGateRunnerService — inputs this runtime cannot honour (EW-807)', () => {
    let runs: { updateGateResults: jest.Mock };
    let runner: TaskGateRunnerService;

    beforeEach(() => {
        runs = { updateGateResults: jest.fn().mockResolvedValue(undefined) };
        runner = new TaskGateRunnerService(runs as never);
        const logger = (
            runner as never as {
                logger: { warn: (m: string) => void; error: (m: string) => void };
            }
        ).logger;
        jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
        jest.spyOn(logger, 'error').mockImplementation(() => undefined);
    });

    afterEach(() => jest.restoreAllMocks());

    /**
     * `mountDir` names WHICH repository of a multi-repo run a command runs
     * in. This runtime provisions one checkout and has no mounts, so the
     * name cannot resolve. Running the command in the primary checkout and
     * grading THAT as the verdict for the named repository is the
     * wrong-repository green the slice exists to delete — the fleet node
     * refuses the same input loudly, and a check that is correct on one
     * runtime and a lie on the other is worse than one that fails on both.
     */
    it('refuses a mount-scoped check instead of silently running it in the primary checkout', async () => {
        const outcome = await runner.runChecks({
            checks: [
                {
                    id: 'template-tests',
                    name: 'template tests',
                    kind: 'custom',
                    // Would exit 0 in the primary checkout, and the gate would
                    // have gone green having tested nothing in `template`.
                    command: 'node -e "process.exit(0)"',
                    mountDir: 'template',
                    required: true,
                },
            ],
            cwd: process.cwd(),
            runId: 'run-mount-1',
        });
        expect(outcome.results[0]).toMatchObject({
            id: 'template-tests',
            status: 'error',
            exitCode: null,
        });
        expect(outcome.results[0].logTail).toContain("names repository 'template'");
        expect(outcome.gateStatus).toBe('red');
    });

    /**
     * `phase: 'setup'` is a dependency install that runs BEFORE the model
     * with its own budget and its own reporting block. Only the fleet node
     * has that phase, and `resolveAcceptanceChecks` filters those entries
     * out — so grading what is left would report a verdict for a workspace
     * whose declared preparation never happened, and an owner who re-phased
     * an EXISTING check would silently lose a command that used to run.
     */
    it('records a run with declared setup steps as skipped rather than grading it', async () => {
        const outcome = await runner.runChecks({
            checks: [
                {
                    id: 'tests',
                    name: 'tests',
                    kind: 'custom',
                    command: 'node -e "process.exit(0)"',
                    required: true,
                },
            ],
            setup: [
                {
                    id: 'install',
                    name: 'install',
                    kind: 'custom',
                    command: 'pnpm install --frozen-lockfile',
                    required: true,
                    phase: 'setup',
                },
            ],
            cwd: process.cwd(),
            runId: 'run-setup-1',
            policy: 'required',
        });
        // Never 'green' and never 'none' — a gate that did not run must not
        // pass anything, and 'none' would read as "nothing was configured".
        expect(outcome.gateStatus).toBe('skipped');
        expect(outcome.results).toEqual([]);
        expect(runs.updateGateResults).toHaveBeenCalledWith(
            'run-setup-1',
            expect.objectContaining({ gateStatus: 'skipped' }),
        );
    });

    it('is unchanged for the runs that declare no setup phase — which is every run before EW-807', async () => {
        const outcome = await runner.runChecks({
            checks: [
                {
                    id: 'tests',
                    name: 'tests',
                    kind: 'custom',
                    command: 'node -e "process.exit(0)"',
                    required: true,
                },
            ],
            setup: [],
            cwd: process.cwd(),
            runId: 'run-setup-2',
        });
        expect(outcome.gateStatus).toBe('green');
    });
});
