import type { AppSpec } from '@ever-works/contracts';
import type { GitDiffFile, GitDiffResult } from '@ever-works/plugin';

import {
    APP_SPEC_PATH,
    AppChangeGuard,
    AppChangeRefusedError,
    MAX_FILES,
    PROVISION_LABEL,
    REFUSAL_MULTIPLE,
} from '../app-change-guard';
import { DEFAULT_SIZE_GUIDANCE, type AppWorkRules } from '../app-work-rules.service';

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
 * dropped.
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
    it('refuses a TRUNCATED diff, whatever is visible in it', () => {
        // The protected path could be in the part that was dropped, so the
        // visible files proving nothing is exactly the point.
        const verdict = guard.evaluate({
            rules: rules({ protectedPaths: ['infra/**'] }),
            diff: diff([file('src/app.ts')], { truncated: true }),
        });

        expect(verdict.allowed).toBe(false);
        expect(verdict.code).toBe('diffTooLarge');
    });

    it('refuses at the file cap, and allows one file below it', () => {
        const at = (totalFiles: number) =>
            guard.evaluate({ rules: rules(), diff: diff([file('a.ts')], { totalFiles }) }).allowed;

        expect(at(MAX_FILES)).toBe(false);
        expect(at(MAX_FILES - 1)).toBe(true);
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

    it('exempts an `app-provision` Task from THIS RULE ONLY', () => {
        const provisioning = {
            rules: rules({ protectedPaths: ['infra/**'] }),
            labels: [PROVISION_LABEL],
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

    it('excludes lockfiles from the count, anywhere in the tree', () => {
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
