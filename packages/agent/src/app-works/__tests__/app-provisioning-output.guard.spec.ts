import type { AppSpec } from '@ever-works/contracts';
import type { GitDiffFile, GitDiffResult } from '@ever-works/plugin';

import { TASK_ORIGIN_APP_PROVISIONING } from '../../entities/task-origin';
import { APP_SPEC_PATH, AppChangeGuard } from '../app-change-guard';
import {
    APP_PROVISIONING_MAX_FILES,
    APP_PROVISIONING_MAX_LINES,
    APP_PROVISIONING_OUTPUT_GUARD_ENV,
    appProvisioningOutputGuardEnforced,
    isProvisioningWritablePath,
    provisioningPathViolations,
    provisioningSecretFindings,
    provisioningSizeViolation,
    provisioningSpecViolations,
} from '../app-provisioning-output.guard';
import { DEFAULT_SIZE_GUIDANCE, type AppWorkRules } from '../app-work-rules.service';

/**
 * APW-04 T10 / T57 — the App provisioning output guard (FR-28, FR-29, FR-30;
 * ACC-04-07, ACC-04-08, ACC-04-09, ACC-04-34 guard half, ACC-NEG-05).
 *
 * The provisioning Agent reads a third-party repository, so every case below is
 * "what could an injected run try", and the guard is judged on the DIFF it would
 * produce — never on what the run says it wrote.
 */

// Fixture tokens are assembled at runtime so no credential-shaped literal sits in
// this file (the repository's own secret scanners read it too).
const FAKE_GITHUB_PAT = ['gh', 'p_', 'A'.repeat(36)].join('');
const FAKE_AWS_KEY = ['AK', 'IA', 'B'.repeat(16)].join('');

function rules(overrides: Partial<AppWorkRules> = {}): AppWorkRules {
    return Object.freeze({
        sourceBranch: 'main',
        checks: [],
        protectedPaths: [],
        humanMergePaths: [],
        instructionFiles: [],
        sizeGuidance: DEFAULT_SIZE_GUIDANCE,
        ...overrides,
    });
}

function file(path: string, overrides: Partial<GitDiffFile> = {}): GitDiffFile {
    return { path, status: 'modified', additions: 1, deletions: 0, ...overrides };
}

function diff(files: GitDiffFile[], overrides: Partial<GitDiffResult> = {}): GitDiffResult {
    return {
        files,
        truncated: false,
        totalFiles: files.length,
        totalAdditions: files.reduce((n, f) => n + f.additions, 0),
        totalDeletions: files.reduce((n, f) => n + f.deletions, 0),
        patchBytes: 0,
        ...overrides,
    };
}

const spec = (extra: Record<string, unknown> = {}): AppSpec =>
    ({ kind: 'app', source: { relation: 'fork' }, ...extra }) as unknown as AppSpec;

describe('isProvisioningWritablePath — FR-28', () => {
    it.each([
        '.works/works.yml',
        '.works/overlay/Dockerfile',
        '.works/overlay/scripts/start.sh',
        '.works/overlay/.dockerignore',
    ])('allows %s', (path) => {
        expect(isProvisioningWritablePath(path)).toBe(true);
    });

    it.each([
        ['application source', 'src/x.ts'],
        ['a workflow', '.github/workflows/ci.yml'],
        ['another file under .works', '.works/smoke.yml'],
        ['the .works directory itself', '.works'],
        ['the overlay directory itself', '.works/overlay'],
        ['a parent-directory escape', '.works/../src/x.ts'],
        ['an escape from the overlay', '.works/overlay/../../src/x.ts'],
        ['a current-directory segment', './.works/works.yml'],
        ['an empty segment', '.works//works.yml'],
        ['an upper-case root', '.WORKS/works.yml'],
        ['a mixed-case root', '.Works/overlay/Dockerfile'],
        ['an absolute path', '/.works/works.yml'],
        ['a drive-qualified path', 'C:/.works/works.yml'],
        ['a backslash separator', '.works\\..\\src\\x.ts'],
        ['a backslash inside the overlay', '.works/overlay\\..\\..\\src'],
        ['a nested repository', '.works/overlay/.git/config'],
        ['a nested repository, upper case', '.works/overlay/.GIT/hooks/pre-commit'],
        ['a NUL byte', '.works/overlay/x\u0000.sh'],
        ['a trailing dot (Windows alias)', '.works/overlay/x./y'],
        ['a trailing space segment', '.works/overlay/x /y'],
        ['an empty string', ''],
    ])('refuses %s (%s)', (_label, path) => {
        expect(isProvisioningWritablePath(path)).toBe(false);
    });

    it('refuses anything that is not a string', () => {
        expect(isProvisioningWritablePath(undefined)).toBe(false);
        expect(isProvisioningWritablePath(null)).toBe(false);
        expect(isProvisioningWritablePath(42)).toBe(false);
        expect(isProvisioningWritablePath(['.works/works.yml'])).toBe(false);
    });

    it('refuses an over-long path', () => {
        expect(isProvisioningWritablePath(`.works/overlay/${'a'.repeat(2000)}`)).toBe(false);
    });
});

describe('provisioningPathViolations — renames count on both sides', () => {
    it('names a rename OUT of the overlay by its old path', () => {
        expect(
            provisioningPathViolations([
                file('.works/overlay/Dockerfile', {
                    previousPath: 'Dockerfile',
                    status: 'renamed',
                }),
            ]),
        ).toEqual(['Dockerfile']);
    });

    it('names a rename INTO source by its new path', () => {
        expect(
            provisioningPathViolations([
                file('src/main.ts', { previousPath: '.works/overlay/main.ts', status: 'renamed' }),
            ]),
        ).toEqual(['src/main.ts']);
    });

    it('is empty for the two writable shapes, and bounded and de-duplicated otherwise', () => {
        expect(
            provisioningPathViolations([
                file('.works/works.yml'),
                file('.works/overlay/Dockerfile'),
            ]),
        ).toEqual([]);
        const many = Array.from({ length: 30 }, (_, i) => file(`src/f${i}.ts`));
        expect(provisioningPathViolations([...many, ...many])).toHaveLength(10);
    });

    it('never echoes a control character back', () => {
        const [shown] = provisioningPathViolations([file('src/\u001b[31mx.ts')]);
        expect(shown).not.toMatch(/\u001b/);
    });
});

describe('provisioningSizeViolation — FR-29', () => {
    it(`refuses more than ${APP_PROVISIONING_MAX_FILES} files, counting the provider's total`, () => {
        const files = Array.from({ length: APP_PROVISIONING_MAX_FILES }, (_, i) =>
            file(`.works/overlay/f${i}`),
        );
        expect(provisioningSizeViolation(files)).toBeNull();
        expect(provisioningSizeViolation([...files, file('.works/overlay/x')])?.code).toBe(
            'tooManyFiles',
        );
        expect(provisioningSizeViolation(files, APP_PROVISIONING_MAX_FILES + 1)?.code).toBe(
            'tooManyFiles',
        );
    });

    it(`refuses more than ${APP_PROVISIONING_MAX_LINES} changed lines`, () => {
        expect(
            provisioningSizeViolation([
                file(APP_SPEC_PATH, { additions: APP_PROVISIONING_MAX_LINES, deletions: 0 }),
            ]),
        ).toBeNull();
        expect(
            provisioningSizeViolation([
                file(APP_SPEC_PATH, { additions: APP_PROVISIONING_MAX_LINES, deletions: 1 }),
            ]),
        ).toEqual({ code: 'tooManyLines', count: APP_PROVISIONING_MAX_LINES + 1 });
    });
});

describe('provisioningSecretFindings — T10 secretLiteral', () => {
    it('finds a credential in the head App spec and names the pattern, never the value', () => {
        const findings = provisioningSecretFindings({
            headSpec: spec({ env: { GITHUB_TOKEN: { value: FAKE_GITHUB_PAT } } }),
        });
        expect(findings).toEqual(['github_pat_classic']);
        expect(JSON.stringify(findings)).not.toContain(FAKE_GITHUB_PAT.slice(0, 12));
    });

    it('reads only the ADDED lines of overlay patches', () => {
        const added = provisioningSecretFindings({
            files: [
                file('.works/overlay/.env', { patch: `@@ -0,0 +1 @@\n+AWS_KEY=${FAKE_AWS_KEY}` }),
            ],
        });
        expect(added).toEqual(['aws_access_key']);
        const removed = provisioningSecretFindings({
            files: [
                file('.works/overlay/.env', { patch: `@@ -1 +0,0 @@\n-AWS_KEY=${FAKE_AWS_KEY}` }),
            ],
        });
        expect(removed).toEqual([]);
    });

    it('does not flag names that merely start with key- / token-', () => {
        expect(
            provisioningSecretFindings({
                headSpec: spec({
                    components: [{ name: 'key-value-store-worker' }, { name: 'token-refresh-job' }],
                }),
            }),
        ).toEqual([]);
    });
});

describe('provisioningSpecViolations — FR-30 / T57', () => {
    it('never lets a run switch on automatic re-provisioning or upstream pull requests', () => {
        expect(
            provisioningSpecViolations(
                null,
                spec({
                    provisioning: { autoReprovision: true },
                    upstreamPullRequests: { enabled: true },
                }),
            ),
        ).toEqual(['upstreamPullRequests.enabled', 'provisioning.autoReprovision']);
        // Already on in the owner's base spec: copying it is not a change.
        const on = spec({ provisioning: { autoReprovision: true } });
        expect(provisioningSpecViolations(on, on)).toEqual([]);
    });

    it('does not inherit a hostile pre-seeded requireApproval: false (ACC-NEG-05)', () => {
        const hostile = spec({ upstreamPullRequests: { requireApproval: false } });
        // No valid base: the base is the schema-safe default (`requireApproval: true`).
        expect(provisioningSpecViolations(null, hostile)).toEqual([
            'upstreamPullRequests.requireApproval',
        ]);
        // The proposal that drops it passes.
        expect(provisioningSpecViolations(null, spec())).toEqual([]);
    });

    it('keeps upstreamSync and license exactly as the valid base has them', () => {
        const base = spec({ upstreamSync: { schedule: '0 6 * * 1' }, license: { spdx: 'MIT' } });
        expect(provisioningSpecViolations(base, base)).toEqual([]);
        expect(
            provisioningSpecViolations(
                base,
                spec({ upstreamSync: { schedule: '* * * * *' }, license: { spdx: 'MIT' } }),
            ),
        ).toEqual(['upstreamSync']);
        expect(
            provisioningSpecViolations(
                base,
                spec({ upstreamSync: { schedule: '0 6 * * 1' }, license: { spdx: 'Apache-2.0' } }),
            ),
        ).toEqual(['license']);
        // First provisioning (no base): the draft writes them from platform state.
        expect(provisioningSpecViolations(null, base)).toEqual([]);
    });

    it('refuses a REMOVAL from the protection lists and allows an addition', () => {
        const base = spec({
            display: { protectedPaths: ['infra/**'] },
            agents: { requireHumanMergePaths: ['db/**'] },
        });
        expect(
            provisioningSpecViolations(
                base,
                spec({
                    display: { protectedPaths: ['infra/**', 'secrets/**'] },
                    agents: { requireHumanMergePaths: ['db/**', 'ops/**'] },
                }),
            ),
        ).toEqual([]);
        expect(
            provisioningSpecViolations(
                base,
                spec({ display: { protectedPaths: [] }, agents: { requireHumanMergePaths: [] } }),
            ),
        ).toEqual(['display.protectedPaths', 'agents.requireHumanMergePaths']);
    });
});

describe('AppChangeGuard — rule 3b applies to App provisioning Tasks only', () => {
    const guard = new AppChangeGuard();
    const provisioning = { rules: rules(), taskOrigin: TASK_ORIGIN_APP_PROVISIONING };
    const saved = process.env[APP_PROVISIONING_OUTPUT_GUARD_ENV];

    afterEach(() => {
        if (saved === undefined) delete process.env[APP_PROVISIONING_OUTPUT_GUARD_ENV];
        else process.env[APP_PROVISIONING_OUTPUT_GUARD_ENV] = saved;
    });

    it('refuses application source from a provisioning run (ACC-04-07, ACC-04-34 guard half)', () => {
        const verdict = guard.evaluate({
            ...provisioning,
            diff: diff([file(APP_SPEC_PATH), file('src/x.ts'), file('AGENTS.md')]),
        });
        expect(verdict.allowed).toBe(false);
        expect(verdict.code).toBe('provisioningPathNotWritable');
        expect(verdict.paths).toEqual(['src/x.ts', 'AGENTS.md']);
    });

    it('refuses a `.works/../` escape and a rename out of `.works`', () => {
        expect(
            guard.evaluate({ ...provisioning, diff: diff([file('.works/../src/x.ts')]) }).code,
        ).toBe('provisioningPathNotWritable');
        expect(
            guard.evaluate({
                ...provisioning,
                diff: diff([
                    file('.works/overlay/package.json', {
                        previousPath: 'package.json',
                        status: 'renamed',
                    }),
                ]),
            }).paths,
        ).toEqual(['package.json']);
    });

    it('lets the workflow and protected-path rules answer first, with their own codes', () => {
        expect(
            guard.evaluate({ ...provisioning, diff: diff([file('.github/workflows/ci.yml')]) })
                .code,
        ).toBe('workflowPath');
        expect(
            guard.evaluate({
                ...provisioning,
                rules: rules({ protectedPaths: ['infra/**'] }),
                diff: diff([file('infra/main.tf')]),
            }).code,
        ).toBe('protectedPath');
    });

    it('allows the App spec and an overlay Dockerfile', () => {
        const verdict = guard.evaluate({
            ...provisioning,
            diff: diff([file(APP_SPEC_PATH), file('.works/overlay/Dockerfile')]),
            baseSpec: null,
            headSpec: spec(),
        });
        expect(verdict.allowed).toBe(true);
    });

    it('refuses a provisioning proposal over FR-29', () => {
        const files = Array.from({ length: APP_PROVISIONING_MAX_FILES + 1 }, (_, i) =>
            file(`.works/overlay/f${i}`),
        );
        expect(guard.evaluate({ ...provisioning, diff: diff(files) }).code).toBe(
            'provisioningTooLarge',
        );
    });

    it('refuses a credential literal and never puts it in the verdict', () => {
        const verdict = guard.evaluate({
            ...provisioning,
            diff: diff([file(APP_SPEC_PATH)]),
            baseSpec: null,
            headSpec: spec({ env: { TOKEN: { value: FAKE_GITHUB_PAT } } }),
        });
        expect(verdict.code).toBe('secretLiteral');
        // Property check: no substring of the secret longer than 8 characters.
        const text = JSON.stringify(verdict);
        for (let i = 0; i + 9 <= FAKE_GITHUB_PAT.length; i += 1) {
            expect(text).not.toContain(FAKE_GITHUB_PAT.slice(i, i + 9));
        }
    });

    it('keeps the source/blueprint exemption but refuses an owner-owned switch', () => {
        const base = spec({ source: { relation: 'fork', branch: 'main' } });
        expect(
            guard.evaluate({
                ...provisioning,
                diff: diff([file(APP_SPEC_PATH)]),
                baseSpec: base,
                headSpec: spec({ source: { relation: 'link' }, blueprint: { id: 'x' } }),
            }).allowed,
        ).toBe(true);
        const verdict = guard.evaluate({
            ...provisioning,
            diff: diff([file(APP_SPEC_PATH)]),
            baseSpec: base,
            headSpec: spec({ provisioning: { autoReprovision: true } }),
        });
        expect(verdict.code).toBe('provisioningOwnedField');
        expect(verdict.message).toContain('provisioning.autoReprovision');
    });

    it('refuses a provisioning run that leaves the App spec unparseable', () => {
        expect(
            guard.evaluate({
                ...provisioning,
                diff: diff([file(APP_SPEC_PATH)]),
                baseSpec: null,
                headSpec: null,
            }).code,
        ).toBe('guardedSpecBlock');
    });

    it('changes nothing for a Task that is not a provisioning Task', () => {
        expect(guard.evaluate({ rules: rules(), diff: diff([file('src/x.ts')]) }).allowed).toBe(
            true,
        );
        expect(
            guard.evaluate({
                rules: rules(),
                diff: diff([file('src/x.ts')]),
                taskOrigin: 'app-provision',
            }).allowed,
        ).toBe(true);
    });

    it('is ON by default and OFF only for an explicit `false`', () => {
        expect(appProvisioningOutputGuardEnforced({})).toBe(true);
        expect(
            appProvisioningOutputGuardEnforced({ [APP_PROVISIONING_OUTPUT_GUARD_ENV]: '0' }),
        ).toBe(true);
        expect(
            appProvisioningOutputGuardEnforced({ [APP_PROVISIONING_OUTPUT_GUARD_ENV]: 'FALSE' }),
        ).toBe(false);

        process.env[APP_PROVISIONING_OUTPUT_GUARD_ENV] = 'false';
        expect(guard.evaluate({ ...provisioning, diff: diff([file('src/x.ts')]) }).allowed).toBe(
            true,
        );
    });
});
