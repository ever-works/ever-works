import type { AppSpec } from '@ever-works/contracts';
import { TASK_ORIGIN_APP_PROVISIONING } from '../../entities/task-origin';
import type { GitDiffFile, GitDiffResult } from '@ever-works/plugin';

import {
    APP_SPEC_PATH,
    AppChangeGuard,
    AppChangeRefusedError,
    MAX_FILES,
    PROVISION_LABEL,
    REFUSAL_MULTIPLE,
} from '../app-change-guard';
import {
    DEFAULT_FILE_GUIDANCE,
    DEFAULT_SIZE_GUIDANCE,
    MAX_FILE_GUIDANCE,
    type AppWorkRules,
} from '../app-work-rules.service';

/**
 * APW-08 T17 — the change guard, every case of plan §9.1.
 *
 * The guard runs on the DIFF and not on what the agent said it did, so the
 * cases below are all shaped the same way: build a diff that a plausible run
 * could produce, and check the guard answers about what is actually in it.
 *
 * The two that carry the most weight are the rename case — moving a protected
 * file out of the way is invisible in the new path's hunks alone — and the
 * truncation case, where the protected path could be in the part the provider
 * dropped. Since APW08-G06 "dropped" means dropped FILE ENTRIES: patch text
 * past the byte budget hides no path, so `truncated` alone refuses nothing.
 */

function rules(overrides: Partial<AppWorkRules> = {}): AppWorkRules {
    return Object.freeze({
        sourceBranch: 'production',
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

const guard = new AppChangeGuard();

describe('rule 1 — a diff too big to police', () => {
    it('refuses a TRUNCATED diff whose file list was cut short, whatever is visible in it', () => {
        // The protected path could be in the part that was dropped, so the
        // visible files proving nothing is exactly the point. APW08-G06 keeps
        // this case: the provider counted two files and listed one, so an
        // entry — and a path — is missing.
        const verdict = guard.evaluate({
            rules: rules({ protectedPaths: ['infra/**'] }),
            diff: diff([file('src/app.ts')], { truncated: true, totalFiles: 2 }),
        });

        expect(verdict.allowed).toBe(false);
        expect(verdict.code).toBe('diffTooLarge');
    });

    it('still refuses a TRUNCATED diff that reports no file count — nothing else can vouch for its list', () => {
        // A provider that breaks the `GitDiffResult` contract (no numeric
        // `totalFiles`) leaves `truncated` as the only signal: fail closed.
        const verdict = guard.evaluate({
            rules: rules(),
            diff: diff([file('src/app.ts')], {
                truncated: true,
                totalFiles: undefined as unknown as number,
            }),
        });

        expect(verdict.code).toBe('diffTooLarge');
    });

    it('does NOT refuse on `truncated` alone: a few files with a huge patch pass (APW08-G06)', () => {
        // `capDiffFiles` also sets `truncated` when PATCH TEXT runs past the
        // byte budget. A five-file dependency update with a big lockfile patch
        // lists every path, so refusing it as "over 300 files" was wrong.
        const verdict = guard.evaluate({
            rules: rules({ protectedPaths: ['infra/**'] }),
            diff: diff(
                [
                    file('package.json', { additions: 2, deletions: 2 }),
                    file('apps/web/package.json', { additions: 1, deletions: 1 }),
                    file('src/app.ts', { additions: 3, deletions: 0 }),
                    file('src/app.spec.ts', { additions: 4, deletions: 0 }),
                    file('pnpm-lock.yaml', { additions: 48_000, deletions: 47_000 }),
                ],
                { truncated: true, patchBytes: 0 },
            ),
        });

        expect(verdict.allowed).toBe(true);
        expect(verdict.code).toBeNull();
        // …and every other rule still reads the full list it was given.
        expect(verdict.changedLines).toBe(13);
    });

    it('a few files with a huge patch are still judged by the path rules (APW08-G06)', () => {
        const verdict = guard.evaluate({
            rules: rules({ protectedPaths: ['infra/**'] }),
            diff: diff([file('src/app.ts'), file('infra/main.tf')], { truncated: true }),
        });

        expect(verdict.code).toBe('protectedPath');
    });

    it('refuses at the file cap, and allows one file below it', () => {
        // The App's own file guidance is set to its maximum here, so only the
        // platform's ceiling decides (APW08-G22's 3× rule is pinned below). The
        // list is as long as the count, as a provider asked for 300 files gives
        // it: since APW08-G06 a list SHORTER than its count refuses on its own.
        const at = (totalFiles: number) =>
            guard.evaluate({
                rules: rules({ fileGuidance: MAX_FILE_GUIDANCE }),
                diff: diff(
                    Array.from({ length: totalFiles }, (_, i) => file(`src/f${i}.ts`)),
                    { totalFiles },
                ),
            }).allowed;

        expect(at(MAX_FILES)).toBe(false);
        expect(at(MAX_FILES - 1)).toBe(true);
    });

    it('refuses EXACTLY 300 files — the provider lists at most 300, so 300 means "300 or more" (FR-21)', () => {
        const files = Array.from({ length: MAX_FILES }, (_, i) => file(`src/f${i}.ts`));
        const verdict = guard.evaluate({
            rules: rules({ fileGuidance: MAX_FILE_GUIDANCE }),
            diff: diff(files),
        });

        expect(MAX_FILES).toBe(300);
        expect(verdict.code).toBe('diffTooLarge');
    });

    it('refuses a short list below the cap — a provider that dropped entries hid a path', () => {
        const verdict = guard.evaluate({
            rules: rules(),
            diff: diff([file('src/a.ts'), file('src/b.ts')], { totalFiles: 12 }),
        });

        expect(verdict.code).toBe('diffTooLarge');
    });

    it('refuses BEFORE reading the file list, so a huge clean diff still refuses', () => {
        const verdict = guard.evaluate({
            rules: rules(),
            diff: diff([file('README.md')], { totalFiles: MAX_FILES + 50 }),
        });

        expect(verdict.code).toBe('diffTooLarge');
    });
});

describe('rule 2 — protected paths', () => {
    it('refuses a protected glob hit', () => {
        const verdict = guard.evaluate({
            rules: rules({ protectedPaths: ['infra/**'] }),
            diff: diff([file('src/ok.ts'), file('infra/terraform/main.tf')]),
        });

        expect(verdict.code).toBe('protectedPath');
        expect(verdict.paths).toContain('infra/terraform/main.tf');
    });

    it('refuses on the PREVIOUS path of a rename', () => {
        // Moving a protected file out of its protected location is a change to
        // the old path, and the new path alone says nothing.
        const verdict = guard.evaluate({
            rules: rules({ protectedPaths: ['infra/**'] }),
            diff: diff([file('src/main.tf', { status: 'renamed', previousPath: 'infra/main.tf' })]),
        });

        expect(verdict.code).toBe('protectedPath');
        expect(verdict.paths).toContain('infra/main.tf');
    });

    it('matches dotfiles, because `dot: true` is the shared option', () => {
        const verdict = guard.evaluate({
            rules: rules({ protectedPaths: ['**/.env*'] }),
            diff: diff([file('config/.env.production')]),
        });

        expect(verdict.code).toBe('protectedPath');
    });

    it('allows a change that matches nothing', () => {
        const verdict = guard.evaluate({
            rules: rules({ protectedPaths: ['infra/**'] }),
            diff: diff([file('src/app.ts'), file('README.md')]),
        });

        expect(verdict.allowed).toBe(true);
        expect(verdict.code).toBeNull();
    });
});

describe('rule 3 — workflow files, whatever the spec says', () => {
    it('refuses a workflow edit even with NO protected paths declared', () => {
        // The workflow file is what RUNS the checks. An agent that may edit it
        // may switch them off and pass every gate afterwards.
        const verdict = guard.evaluate({
            rules: rules({ protectedPaths: [] }),
            diff: diff([file('.github/workflows/ci.yml')]),
        });

        expect(verdict.code).toBe('workflowPath');
    });

    it('refuses a workflow file moved AWAY, via previousPath', () => {
        const verdict = guard.evaluate({
            rules: rules(),
            diff: diff([
                file('docs/old-ci.yml', {
                    status: 'renamed',
                    previousPath: '.github/workflows/ci.yml',
                }),
            ]),
        });

        expect(verdict.code).toBe('workflowPath');
    });

    it('does not refuse a path that merely looks like one', () => {
        const verdict = guard.evaluate({
            rules: rules(),
            diff: diff([file('docs/github/workflows/guide.md')]),
        });

        expect(verdict.allowed).toBe(true);
    });
});

describe('rule 4 — guarded App spec blocks', () => {
    const base = { kind: 'app', source: { relation: 'fork', branch: 'production' } } as AppSpec;

    it('does not apply when the spec file is not in the diff', () => {
        const verdict = guard.evaluate({
            rules: rules(),
            diff: diff([file('src/app.ts')]),
            baseSpec: base,
            headSpec: { kind: 'app', source: { relation: 'link' } } as AppSpec,
        });

        expect(verdict.allowed).toBe(true);
    });

    it('refuses a change to `source`', () => {
        const verdict = guard.evaluate({
            rules: rules(),
            diff: diff([file(APP_SPEC_PATH)]),
            baseSpec: base,
            headSpec: {
                kind: 'app',
                source: { relation: 'fork', branch: 'somewhere-else' },
            } as AppSpec,
        });

        expect(verdict.code).toBe('guardedSpecBlock');
        expect(verdict.message).toContain('source');
    });

    it('refuses a REMOVAL from protectedPaths, and allows an addition', () => {
        // A member may always tighten; only loosening needs a person.
        const withTwo = {
            kind: 'app',
            display: { protectedPaths: ['infra/**', 'Dockerfile'] },
        } as AppSpec;
        const withOne = { kind: 'app', display: { protectedPaths: ['infra/**'] } } as AppSpec;

        expect(
            guard.evaluate({
                rules: rules(),
                diff: diff([file(APP_SPEC_PATH)]),
                baseSpec: withTwo,
                headSpec: withOne,
            }).code,
        ).toBe('guardedSpecBlock');

        expect(
            guard.evaluate({
                rules: rules(),
                diff: diff([file(APP_SPEC_PATH)]),
                baseSpec: withOne,
                headSpec: withTwo,
            }).allowed,
        ).toBe(true);
    });

    it('refuses a removal from requireHumanMergePaths', () => {
        const verdict = guard.evaluate({
            rules: rules(),
            diff: diff([file(APP_SPEC_PATH)]),
            baseSpec: {
                kind: 'app',
                agents: { requireHumanMergePaths: ['Dockerfile'] },
            } as AppSpec,
            headSpec: { kind: 'app', agents: { requireHumanMergePaths: [] } } as AppSpec,
        });

        expect(verdict.code).toBe('guardedSpecBlock');
        expect(verdict.message).toContain('human-merge');
    });

    it('refuses a head spec that does not parse', () => {
        // `null` is "read and invalid" — a branch that leaves the Work unable to
        // describe itself must not become a pull request.
        const verdict = guard.evaluate({
            rules: rules(),
            diff: diff([file(APP_SPEC_PATH)]),
            baseSpec: base,
            headSpec: null,
        });

        expect(verdict.code).toBe('guardedSpecBlock');
        expect(verdict.message).toContain('invalid');
    });

    it('does nothing when the head spec was NOT READ — undefined is not null', () => {
        const verdict = guard.evaluate({
            rules: rules(),
            diff: diff([file(APP_SPEC_PATH)]),
            baseSpec: base,
        });

        expect(verdict.allowed).toBe(true);
    });

    it('does NOT exempt a Task because it carries the `app-provision` label (works-security)', () => {
        // Labels are free-form: an injected run could add this one to its own
        // Task through `PATCH /api/tasks/:id`. The label exempts nothing.
        const verdict = guard.evaluate({
            rules: rules(),
            diff: diff([file(APP_SPEC_PATH)]),
            baseSpec: base,
            headSpec: { kind: 'app', source: { relation: 'link' } } as AppSpec,
            ...({ labels: [PROVISION_LABEL] } as object),
        });
        expect(verdict.code).toBe('guardedSpecBlock');
        // Nor does any other origin string.
        expect(
            guard.evaluate({
                rules: rules(),
                diff: diff([file(APP_SPEC_PATH)]),
                baseSpec: base,
                headSpec: { kind: 'app', source: { relation: 'link' } } as AppSpec,
                taskOrigin: 'app-provision',
            }).code,
        ).toBe('guardedSpecBlock');
    });

    it('exempts an App provisioning Task (server-written origin) from THIS RULE ONLY', () => {
        const provisioning = {
            rules: rules({ protectedPaths: ['infra/**'] }),
            taskOrigin: TASK_ORIGIN_APP_PROVISIONING,
            baseSpec: base,
            headSpec: { kind: 'app', source: { relation: 'link' } } as AppSpec,
        };

        // The spec-block rule is skipped …
        expect(guard.evaluate({ ...provisioning, diff: diff([file(APP_SPEC_PATH)]) }).allowed).toBe(
            true,
        );

        // … and nothing else is. A provisioning Task has no more business
        // editing a protected path or a workflow than any other.
        expect(guard.evaluate({ ...provisioning, diff: diff([file('infra/main.tf')]) }).code).toBe(
            'protectedPath',
        );
        expect(
            guard.evaluate({ ...provisioning, diff: diff([file('.github/workflows/ci.yml')]) })
                .code,
        ).toBe('workflowPath');
    });
});

describe('rule 5 — size', () => {
    const big = (lines: number) => file('src/app.ts', { additions: lines, deletions: 0 });

    it('allows under the guidance with no note', () => {
        const verdict = guard.evaluate({
            rules: rules({ sizeGuidance: 500 }),
            diff: diff([big(100)]),
        });

        expect(verdict.allowed).toBe(true);
        expect(verdict.note).toBeNull();
        expect(verdict.changedLines).toBe(100);
    });

    it('allows over the guidance WITH a note', () => {
        const verdict = guard.evaluate({
            rules: rules({ sizeGuidance: 500 }),
            diff: diff([big(700)]),
        });

        expect(verdict.allowed).toBe(true);
        expect(verdict.note).toContain('700');
    });

    it(`refuses past ${REFUSAL_MULTIPLE}x the guidance`, () => {
        const verdict = guard.evaluate({
            rules: rules({ sizeGuidance: 500 }),
            diff: diff([big(1501)]),
        });

        expect(verdict.code).toBe('tooManyLines');
    });

    it('allows exactly 3x — the refusal is PAST the multiple', () => {
        expect(
            guard.evaluate({ rules: rules({ sizeGuidance: 500 }), diff: diff([big(1500)]) })
                .allowed,
        ).toBe(true);
    });

    it('excludes lockfiles from the LINE count, anywhere in the tree', () => {
        // A dependency bump is thousands of lines no human wrote and no
        // reviewer reads. Counting them makes the guidance meaningless for the
        // change that most needs to be small elsewhere.
        const verdict = guard.evaluate({
            rules: rules({ sizeGuidance: 500 }),
            diff: diff([
                big(10),
                file('pnpm-lock.yaml', { additions: 40_000, deletions: 39_000 }),
                file('apps/web/package-lock.json', { additions: 9_000, deletions: 0 }),
            ]),
        });

        expect(verdict.allowed).toBe(true);
        expect(verdict.changedLines).toBe(10);
    });
});

describe('rule 5 — the App spec’s own file guidance (APW08-G22)', () => {
    const many = (count: number) =>
        Array.from({ length: count }, (_, i) => file(`src/f${i}.ts`, { additions: 1 }));

    it('defaults to 50 when the rules carry no file guidance — never silence', () => {
        expect(DEFAULT_FILE_GUIDANCE).toBe(50);
        expect(guard.evaluate({ rules: rules(), diff: diff(many(50)) }).note).toBeNull();
        expect(guard.evaluate({ rules: rules(), diff: diff(many(51)) }).note).toContain(
            '51 files, over this Work’s file guidance of 50',
        );
        expect(guard.evaluate({ rules: rules(), diff: diff(many(151)) }).code).toBe('tooManyFiles');
    });

    it('an over-guidance file count is allowed WITH a note', () => {
        const verdict = guard.evaluate({
            rules: rules({ fileGuidance: 20 }),
            diff: diff(many(21)),
        });

        expect(verdict.allowed).toBe(true);
        expect(verdict.note).toContain('21 files');
        expect(verdict.note).toContain('file guidance of 20');
    });

    it(`an over-${REFUSAL_MULTIPLE}× count is refused; exactly ${REFUSAL_MULTIPLE}× is not`, () => {
        const at = (count: number) =>
            guard.evaluate({ rules: rules({ fileGuidance: 20 }), diff: diff(many(count)) });

        expect(at(60).allowed).toBe(true);
        const refused = at(61);
        expect(refused.allowed).toBe(false);
        expect(refused.code).toBe('tooManyFiles');
        expect(refused.message).toContain('61 files');
        expect(refused.message).toContain('file guidance of 20');
    });

    it('counts the provider’s total, lockfiles included (only their LINES are excluded)', () => {
        const verdict = guard.evaluate({
            rules: rules({ fileGuidance: 2 }),
            diff: diff([
                file('src/a.ts'),
                file('pnpm-lock.yaml', { additions: 900 }),
                file('apps/web/package-lock.json', { additions: 900 }),
            ]),
        });

        expect(verdict.allowed).toBe(true);
        expect(verdict.changedLines).toBe(1);
        expect(verdict.note).toContain('3 files');
    });

    it('never replaces the 300-file ceiling, whatever the App sets', () => {
        // 500 × 3 = 1,500, far past the platform's 300: the ceiling still answers first.
        const verdict = guard.evaluate({
            rules: rules({ fileGuidance: MAX_FILE_GUIDANCE }),
            diff: diff([file('a.ts')], { totalFiles: MAX_FILES }),
        });

        expect(verdict.code).toBe('diffTooLarge');
    });

    it('carries the line note and the file note together when both apply', () => {
        const verdict = guard.evaluate({
            rules: rules({ sizeGuidance: 50, fileGuidance: 2 }),
            diff: diff([
                file('src/a.ts', { additions: 40 }),
                file('src/b.ts', { additions: 40 }),
                file('src/c.ts', { additions: 1 }),
            ]),
        });

        expect(verdict.allowed).toBe(true);
        expect(verdict.note).toContain('81 lines');
        expect(verdict.note).toContain('3 files');
    });

    it('the line refusal still answers before the file refusal', () => {
        const verdict = guard.evaluate({
            rules: rules({ sizeGuidance: 50, fileGuidance: 1 }),
            diff: diff([
                file('src/a.ts', { additions: 200 }),
                file('src/b.ts'),
                file('src/c.ts'),
                file('src/d.ts'),
            ]),
        });

        expect(verdict.code).toBe('tooManyLines');
    });
});

describe('assertPathsAllowed — the commit tool’s half', () => {
    it('throws before a write for a protected path', () => {
        expect(() =>
            guard.assertPathsAllowed(rules({ protectedPaths: ['infra/**'] }), [
                'src/ok.ts',
                'infra/main.tf',
            ]),
        ).toThrow(AppChangeRefusedError);
    });

    it('throws for a workflow path with no protected paths declared', () => {
        const error = (() => {
            try {
                guard.assertPathsAllowed(rules(), ['.github/workflows/ci.yml']);
                return null;
            } catch (e) {
                return e as AppChangeRefusedError;
            }
        })();

        expect(error?.code).toBe('workflowPath');
        expect(error?.paths).toContain('.github/workflows/ci.yml');
    });

    it('allows a clean write', () => {
        expect(() =>
            guard.assertPathsAllowed(rules({ protectedPaths: ['infra/**'] }), ['src/app.ts']),
        ).not.toThrow();
    });

    it('answers for an empty list without throwing', () => {
        expect(() => guard.assertPathsAllowed(rules(), [])).not.toThrow();
    });
});
