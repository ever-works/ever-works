import { platform } from 'os';
import type { TaskAcceptanceCheck } from '@ever-works/contracts';
import { TaskGateRunnerService } from '../task-gate-runner.service';
import { resolveL0Checks, shouldRunL0PreCheck } from '../task-gates';

/**
 * L0 pre-check (judgment layer G2).
 *
 * The cheap syntactic pass that runs BEFORE the model call, so an
 * obviously broken workspace is described to the agent instead of
 * discovered by it. Three properties carry the whole feature:
 *
 *   1. it is OFF unless an operator turns it on AND the Work declares an
 *      `L0` check — the default run is byte-identical to today's;
 *   2. it never persists a gate verdict (there is no work to grade yet);
 *   3. it never blocks (a misconfigured lint command must not become an
 *      outage).
 */
describe('L0 pre-check gating (G2)', () => {
    function check(over: Partial<TaskAcceptanceCheck> = {}): TaskAcceptanceCheck {
        return {
            id: 'lint',
            name: 'Lint',
            kind: 'lint',
            command: 'echo ok',
            required: true,
            ...over,
        };
    }

    describe('resolveL0Checks', () => {
        it('⭐ returns nothing for checks authored before the level field existed', () => {
            // THE DEFAULT-OFF TEST. Every check in every repo today omits
            // `level`. If they defaulted into L0, every run would suddenly
            // spawn subprocesses before its first token.
            expect(resolveL0Checks([check(), check({ id: 'build' })])).toEqual([]);
        });

        it('selects only the checks that opt in', () => {
            const l0 = check({ id: 'fast-lint', level: 'L0' });
            expect(resolveL0Checks([check({ id: 'build' }), l0, check({ level: 'L1' })])).toEqual([
                l0,
            ]);
        });
    });

    describe('shouldRunL0PreCheck', () => {
        const l0 = [check({ level: 'L0' })];

        it('requires the operator switch', () => {
            expect(shouldRunL0PreCheck({ enabled: false, policy: 'required', l0Checks: l0 })).toBe(
                false,
            );
        });

        it('requires at least one declared L0 check', () => {
            expect(shouldRunL0PreCheck({ enabled: true, policy: 'required', l0Checks: [] })).toBe(
                false,
            );
        });

        it("refuses when the Work's checks policy is off", () => {
            // A Work that switched its gate off is saying "do not run my
            // check commands" — "except before the model call" would be a
            // surprising exception to that.
            expect(shouldRunL0PreCheck({ enabled: true, policy: 'off', l0Checks: l0 })).toBe(false);
        });

        it('runs under warn and required policies once everything lines up', () => {
            expect(shouldRunL0PreCheck({ enabled: true, policy: 'warn', l0Checks: l0 })).toBe(true);
            expect(shouldRunL0PreCheck({ enabled: true, policy: 'required', l0Checks: l0 })).toBe(
                true,
            );
        });
    });
});

describe('TaskGateRunnerService.runPreChecks (G2)', () => {
    let runs: { updateGateResults: jest.Mock };
    const isWindows = platform() === 'win32';

    function makeSvc(): TaskGateRunnerService {
        const svc = new TaskGateRunnerService(runs as never);
        jest.spyOn(
            (svc as never as { logger: { log: () => void } }).logger,
            'log',
        ).mockImplementation(() => undefined);
        jest.spyOn(
            (svc as never as { logger: { warn: () => void } }).logger,
            'warn',
        ).mockImplementation(() => undefined);
        return svc;
    }

    function check(over: Partial<TaskAcceptanceCheck> = {}): TaskAcceptanceCheck {
        return {
            id: 'ok',
            name: 'ok',
            kind: 'lint',
            command: 'exit 0',
            required: true,
            level: 'L0',
            ...over,
        };
    }

    beforeEach(() => {
        runs = { updateGateResults: jest.fn().mockResolvedValue(undefined) };
    });

    afterEach(() => jest.restoreAllMocks());

    it('is a no-op with an empty check list', async () => {
        const outcome = await makeSvc().runPreChecks({ checks: [], cwd: process.cwd() });
        expect(outcome).toEqual({ results: [], failing: [] });
        expect(runs.updateGateResults).not.toHaveBeenCalled();
    });

    it('⭐ NEVER persists a gate verdict — the work has not happened yet', async () => {
        // THE "NOT A VERDICT" TEST. Writing gateStatus here would make the
        // Sessions view show a red gate for a run that never executed.
        await makeSvc().runPreChecks({ checks: [check()], cwd: process.cwd() });
        expect(runs.updateGateResults).not.toHaveBeenCalled();
    });

    it('reports a green pre-check with no failures', async () => {
        const outcome = await makeSvc().runPreChecks({
            checks: [check({ command: 'exit 0' })],
            cwd: process.cwd(),
        });
        expect(outcome.results).toHaveLength(1);
        expect(outcome.results[0].status).toBe('green');
        expect(outcome.failing).toHaveLength(0);
    });

    it('collects a failing pre-check with its exit code', async () => {
        const outcome = await makeSvc().runPreChecks({
            checks: [check({ id: 'bad', command: 'exit 3' })],
            cwd: process.cwd(),
        });
        expect(outcome.failing).toHaveLength(1);
        expect(outcome.failing[0].id).toBe('bad');
        expect(outcome.failing[0].status).toBe('red');
        expect(outcome.failing[0].exitCode).toBe(3);
    });

    it('⭐ reports non-required pre-checks too — this is information, not a gate', async () => {
        // In the post-run gate, `required: false` can never turn the gate
        // red. A PRE-check has no gate to turn red: everything it learned
        // is worth telling the agent.
        const outcome = await makeSvc().runPreChecks({
            checks: [check({ id: 'advisory', command: 'exit 1', required: false })],
            cwd: process.cwd(),
        });
        expect(outcome.failing.map((r) => r.id)).toEqual(['advisory']);
    });

    it('runs every declared pre-check, in order', async () => {
        const outcome = await makeSvc().runPreChecks({
            checks: [
                check({ id: 'a', command: 'exit 0' }),
                check({ id: 'b', command: 'exit 1' }),
                check({ id: 'c', command: 'exit 0' }),
            ],
            cwd: process.cwd(),
        });
        expect(outcome.results.map((r) => r.id)).toEqual(['a', 'b', 'c']);
        expect(outcome.failing.map((r) => r.id)).toEqual(['b']);
    });

    it('marks an unspawnable pre-check `error`, distinct from a code failure', async () => {
        const outcome = await makeSvc().runPreChecks({
            checks: [check({ id: 'nowhere', command: 'exit 0', cwd: 'does-not-exist-xyz' })],
            cwd: process.cwd(),
        });
        expect(outcome.failing).toHaveLength(1);
        expect(outcome.failing[0].status).toBe('error');
    });

    // The sleep syntax differs per shell; skipped on Windows rather than
    // asserting a `timeout` verdict a cmd.exe shell cannot produce.
    (isWindows ? it.skip : it)(
        'enforces the tighter pre-check ceiling over the check own timeout',
        async () => {
            const outcome = await makeSvc().runPreChecks({
                checks: [check({ id: 'slow', command: 'sleep 5', timeoutSec: 600 })],
                cwd: process.cwd(),
                timeoutSec: 1,
            });
            expect(outcome.failing[0].status).toBe('timeout');
        },
        20_000,
    );
});
