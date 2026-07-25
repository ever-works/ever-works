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
});
