import { WORK_KINDS } from '@ever-works/contracts';
import { resolveTaskIsolation } from '../task-isolation';

/**
 * APW-08 T11 (FR-9, ACC-08-07 first half) — `resolveTaskIsolation` forces isolation ON for an
 * App Work, and changes nothing for any other kind.
 *
 * The golden table below is the whole decision space a Task and its Work can present: every
 * Work kind (plus a kind-less view, which is what every structural caller that predates T11
 * passes) × every Work setting × every per-Task override × an Agent that may or may not commit.
 * For every kind but `app` the expected answer is written out as a literal rule — the rules the
 * pre-existing `task-isolation.spec.ts` pins — not computed by the function under test, so the
 * table can only pass if nothing about those kinds moved.
 */

const NON_APP_KINDS: ReadonlyArray<string | undefined> = [
    ...WORK_KINDS.filter((kind) => kind !== 'app'),
    // A view with no kind at all — every caller written before T11.
    undefined,
    // An unknown kind normalizes to `default` and must behave like it.
    'something-new',
];

const WORK_SETTINGS: ReadonlyArray<string | null | undefined> = [
    'worktree',
    'off',
    null,
    undefined,
    'banana',
];
const TASK_OVERRIDES: ReadonlyArray<string | null | undefined> = [
    'on',
    'off',
    null,
    undefined,
    'banana',
];
const AGENT_CAN_COMMIT: ReadonlyArray<boolean | undefined> = [true, false, undefined];

/** Today's rules, written out — the ones `task-isolation.spec.ts` pins. */
function expectedBeforeT11(
    setting: string | null | undefined,
    override: string | null | undefined,
    agentCanCommit: boolean | undefined,
): 'on' | 'off' {
    if (agentCanCommit === false) return 'off';
    if (override === 'on') return 'on';
    if (override === 'off') return 'off';
    return setting === 'worktree' ? 'on' : 'off';
}

describe('APW-08 T11 — resolveTaskIsolation on an App Work (FR-9)', () => {
    it('forces ON with the Work setting OFF and no override', () => {
        expect(resolveTaskIsolation({ workId: 'w1' }, { kind: 'app', taskIsolation: 'off' })).toBe(
            'on',
        );
    });

    it('forces ON even when the Task itself asks for OFF — a Task cannot opt out', () => {
        expect(
            resolveTaskIsolation(
                { workId: 'w1', isolationMode: 'off' },
                { kind: 'app', taskIsolation: 'off' },
            ),
        ).toBe('on');
    });

    it('forces ON with no isolation column at all (a row the backfill has not reached)', () => {
        expect(resolveTaskIsolation({ workId: 'w1' }, { kind: 'app' })).toBe('on');
    });

    it('reads the kind the way the contracts do (casing and whitespace)', () => {
        expect(
            resolveTaskIsolation({ workId: 'w1' }, { kind: ' APP ', taskIsolation: 'off' }),
        ).toBe('on');
    });

    it('keeps the agentCanCommit === false clamp unchanged — the dispatch refusal owns FR-9 there', () => {
        expect(
            resolveTaskIsolation(
                { workId: 'w1', isolationMode: 'on' },
                { kind: 'app', taskIsolation: 'worktree' },
                { agentCanCommit: false },
            ),
        ).toBe('off');
    });

    it('keeps the no-Work clamp: a Task without a Work has nothing to branch', () => {
        expect(resolveTaskIsolation({ workId: null }, { kind: 'app' })).toBe('off');
    });

    it('golden table: every app combination is ON except the two clamps', () => {
        for (const setting of WORK_SETTINGS) {
            for (const override of TASK_OVERRIDES) {
                for (const agentCanCommit of AGENT_CAN_COMMIT) {
                    const got = resolveTaskIsolation(
                        { workId: 'w1', isolationMode: override },
                        { kind: 'app', taskIsolation: setting },
                        { agentCanCommit },
                    );
                    expect({ setting, override, agentCanCommit, got }).toEqual({
                        setting,
                        override,
                        agentCanCommit,
                        got: agentCanCommit === false ? 'off' : 'on',
                    });
                }
            }
        }
    });

    it('golden table: every OTHER kind resolves exactly as before T11', () => {
        let cases = 0;
        for (const kind of NON_APP_KINDS) {
            for (const setting of WORK_SETTINGS) {
                for (const override of TASK_OVERRIDES) {
                    for (const agentCanCommit of AGENT_CAN_COMMIT) {
                        const work =
                            kind === undefined
                                ? { taskIsolation: setting }
                                : { kind, taskIsolation: setting };
                        const got = resolveTaskIsolation(
                            { workId: 'w1', isolationMode: override },
                            work,
                            { agentCanCommit },
                        );
                        expect({ kind, setting, override, agentCanCommit, got }).toEqual({
                            kind,
                            setting,
                            override,
                            agentCanCommit,
                            got: expectedBeforeT11(setting, override, agentCanCommit),
                        });
                        cases += 1;
                    }
                }
            }
        }
        // Every kind the contracts know but `app`, plus the two extra views — nothing skipped.
        expect(cases).toBe(
            NON_APP_KINDS.length *
                WORK_SETTINGS.length *
                TASK_OVERRIDES.length *
                AGENT_CAN_COMMIT.length,
        );
        expect(NON_APP_KINDS.length).toBe(WORK_KINDS.length - 1 + 2);
    });

    it('a null / undefined Work view is never an App Work', () => {
        expect(resolveTaskIsolation({ workId: 'w1' }, null)).toBe('off');
        expect(resolveTaskIsolation({ workId: 'w1' }, undefined)).toBe('off');
    });
});
