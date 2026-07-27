import type { TaskAcceptanceCheck } from '@ever-works/contracts';
import { PullRequestGateRefusedError, PullRequestGateService } from '../pull-request-gate.service';

/**
 * Quality gates (audit W3 M3) — the PR gate for the non-worker
 * `createPullRequest` callers, exercised with REAL subprocesses (the same
 * posture as `task-gate-runner.service.spec.ts`): `node -e "…"` is the one
 * command guaranteed present wherever this suite runs, and it gives
 * deterministic exit codes on every platform.
 */

const GREEN = 'node -e "process.exit(0)"';
const RED = 'node -e "process.exit(1)"';

function check(overrides: Partial<TaskAcceptanceCheck> & { id: string }): TaskAcceptanceCheck {
    return {
        name: overrides.id,
        kind: 'custom',
        command: GREEN,
        required: true,
        ...overrides,
    };
}

describe('PullRequestGateService', () => {
    let gate: PullRequestGateService;

    beforeEach(() => {
        gate = new PullRequestGateService();
        const logger = (gate as unknown as { logger: Record<string, jest.Mock> }).logger;
        jest.spyOn(logger, 'log').mockImplementation(() => undefined);
        jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
        jest.spyOn(logger, 'error').mockImplementation(() => undefined);
    });

    afterEach(() => jest.restoreAllMocks());

    describe('no policy configured (the default) → unchanged behaviour', () => {
        it('allows the PR without executing anything when checksPolicy is absent', async () => {
            const decision = await gate.evaluate({
                work: { id: 'w1', checkDefaults: [check({ id: 'build', command: RED })] },
                cwd: process.cwd(),
            });
            // Even with a check that WOULD fail, `off` never runs it.
            expect(decision).toEqual({
                allowed: true,
                policy: 'off',
                gateStatus: 'none',
                results: [],
            });
        });

        it("allows the PR when checksPolicy is explicitly 'off'", async () => {
            const decision = await gate.evaluate({
                work: { id: 'w1', checksPolicy: 'off', checkDefaults: [check({ id: 'x' })] },
                cwd: process.cwd(),
            });
            expect(decision.allowed).toBe(true);
            expect(decision.results).toEqual([]);
        });

        it('allows the PR when the Work row itself is missing', async () => {
            const decision = await gate.evaluate({ work: null, cwd: process.cwd() });
            expect(decision.allowed).toBe(true);
            expect(decision.policy).toBe('off');
        });

        it('treats an unrecognized policy value as off (never toward blocking)', async () => {
            const decision = await gate.evaluate({
                work: {
                    id: 'w1',
                    checksPolicy: 'REQUIRED' as never,
                    checkDefaults: [check({ id: 'x', command: RED })],
                },
                cwd: process.cwd(),
            });
            expect(decision.allowed).toBe(true);
            expect(decision.policy).toBe('off');
        });
    });

    describe("policy 'required'", () => {
        it('gate passes → PR allowed, results reported', async () => {
            const decision = await gate.evaluate({
                work: {
                    id: 'w1',
                    checksPolicy: 'required',
                    checkDefaults: [check({ id: 'build' }), check({ id: 'test' })],
                },
                cwd: process.cwd(),
            });
            expect(decision.allowed).toBe(true);
            expect(decision.gateStatus).toBe('green');
            expect(decision.results.map((r) => r.status)).toEqual(['green', 'green']);
            expect(decision.reason).toBeUndefined();
        });

        it('gate fails → PR refused, and the failing check is named', async () => {
            const decision = await gate.evaluate({
                work: {
                    id: 'w1',
                    checksPolicy: 'required',
                    checkDefaults: [check({ id: 'build' }), check({ id: 'test', command: RED })],
                },
                cwd: process.cwd(),
            });
            expect(decision.allowed).toBe(false);
            expect(decision.gateStatus).toBe('red');
            expect(decision.reason).toContain('test (red)');
            // The green check is NOT listed as a failure.
            expect(decision.reason).not.toContain('build');
        });

        it('a required:false check that fails can never withhold the PR', async () => {
            const decision = await gate.evaluate({
                work: {
                    id: 'w1',
                    checksPolicy: 'required',
                    checkDefaults: [
                        check({ id: 'build' }),
                        check({ id: 'advisory', command: RED, required: false }),
                    ],
                },
                cwd: process.cwd(),
            });
            expect(decision.gateStatus).toBe('green');
            expect(decision.allowed).toBe(true);
            // …but the informational failure is still REPORTED honestly.
            expect(decision.results[1]).toMatchObject({ id: 'advisory', status: 'red' });
        });

        it('zero resolved checks → skipped, PR refused (a skipped gate is not green)', async () => {
            const decision = await gate.evaluate({
                work: { id: 'w1', checksPolicy: 'required', checkDefaults: [] },
                cwd: process.cwd(),
            });
            expect(decision.allowed).toBe(false);
            expect(decision.gateStatus).toBe('skipped');
            expect(decision.reason).toContain('none are configured');
        });

        it('disabled checks are filtered out before the count is taken', async () => {
            const decision = await gate.evaluate({
                work: {
                    id: 'w1',
                    checksPolicy: 'required',
                    checkDefaults: [check({ id: 'build', disabled: true })],
                },
                cwd: process.cwd(),
            });
            expect(decision.gateStatus).toBe('skipped');
            expect(decision.allowed).toBe(false);
        });

        it('no checkout to run the checks in → refused, never silently passed', async () => {
            const decision = await gate.evaluate({
                work: { id: 'w1', checksPolicy: 'required', checkDefaults: [check({ id: 'b' })] },
                cwd: null,
            });
            expect(decision.allowed).toBe(false);
            expect(decision.gateStatus).toBe('skipped');
            expect(decision.reason).toContain('no checkout');
        });
    });

    describe("policy 'warn'", () => {
        it('runs the checks and reports red, but still allows the PR', async () => {
            const decision = await gate.evaluate({
                work: {
                    id: 'w1',
                    checksPolicy: 'warn',
                    checkDefaults: [check({ id: 'test', command: RED })],
                },
                cwd: process.cwd(),
            });
            expect(decision.gateStatus).toBe('red');
            expect(decision.allowed).toBe(true);
            expect(decision.results[0]).toMatchObject({ id: 'test', status: 'red', exitCode: 1 });
        });

        it('zero checks under warn is none, not skipped, and allows the PR', async () => {
            const decision = await gate.evaluate({
                work: { id: 'w1', checksPolicy: 'warn', checkDefaults: null },
                cwd: process.cwd(),
            });
            expect(decision.gateStatus).toBe('none');
            expect(decision.allowed).toBe(true);
        });
    });

    describe('assertAllowed', () => {
        it('returns the decision when the gate allows the PR', async () => {
            const decision = await gate.assertAllowed({
                work: { id: 'w1', checksPolicy: 'required', checkDefaults: [check({ id: 'ok' })] },
                cwd: process.cwd(),
            });
            expect(decision.gateStatus).toBe('green');
        });

        it('throws PullRequestGateRefusedError carrying the decision on a refusal', async () => {
            expect.assertions(3);
            try {
                await gate.assertAllowed({
                    work: {
                        id: 'w1',
                        checksPolicy: 'required',
                        checkDefaults: [check({ id: 'test', command: RED })],
                    },
                    cwd: process.cwd(),
                });
            } catch (error) {
                expect(error).toBeInstanceOf(PullRequestGateRefusedError);
                expect((error as PullRequestGateRefusedError).name).toBe(
                    'PullRequestGateRefusedError',
                );
                expect((error as PullRequestGateRefusedError).decision.gateStatus).toBe('red');
            }
        });
    });
});
