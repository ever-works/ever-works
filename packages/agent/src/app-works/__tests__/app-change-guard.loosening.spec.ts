import type { AppSpec } from '@ever-works/contracts';
import type { GitDiffFile, GitDiffResult } from '@ever-works/plugin';

import {
    APP_CHANGE_GUARD_SPEC_SWITCHES_ENV,
    APP_SPEC_PATH,
    AppChangeGuard,
} from '../app-change-guard';
import { DEFAULT_SIZE_GUIDANCE, type AppWorkRules } from '../app-work-rules.service';
import { loosenedSpecSwitches } from '../../app-spec/app-spec-guarded-blocks';

/**
 * Works-security (2026-10-18, item 5) — what the evolve brief promises the
 * guard enforces, and the guard now does:
 *
 *   - rule 4 refuses ANY `upstreamSync` change and switching ON
 *     `upstreamPullRequests.enabled` / `provisioning.autoReprovision` (switching
 *     them OFF tightens and stays allowed);
 *   - an allowed verdict names the changed paths matching
 *     `agents.requireHumanMergePaths`, which the merge gate turns into a
 *     recorded human approval.
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

function diff(files: GitDiffFile[]): GitDiffResult {
    return {
        files,
        truncated: false,
        totalFiles: files.length,
        totalAdditions: files.reduce((n, f) => n + f.additions, 0),
        totalDeletions: files.reduce((n, f) => n + f.deletions, 0),
        patchBytes: 0,
    };
}

const BASE = {
    upstreamSync: { enabled: true, schedule: '0 6 * * 1', mode: 'merge' },
    upstreamPullRequests: { enabled: false, requireApproval: true, maxOpen: 3 },
    provisioning: { autoReprovision: false },
} as unknown as AppSpec;

function withSpec(over: Record<string, unknown>): AppSpec {
    return { ...(BASE as unknown as Record<string, unknown>), ...over } as unknown as AppSpec;
}

const guard = new AppChangeGuard();

function judgeSpec(head: AppSpec) {
    return guard.evaluate({
        rules: rules(),
        diff: diff([file(APP_SPEC_PATH)]),
        baseSpec: BASE,
        headSpec: head,
    });
}

describe('loosenedSpecSwitches', () => {
    it('reports nothing for an identical spec', () => {
        expect(loosenedSpecSwitches(BASE, BASE)).toEqual([]);
    });

    it('reports ANY upstreamSync change (another branch, switched off, a new schedule)', () => {
        for (const upstreamSync of [
            { enabled: true, schedule: '0 6 * * 1', mode: 'merge', branch: 'attacker' },
            { enabled: false, schedule: '0 6 * * 1', mode: 'merge' },
            { enabled: true, schedule: '0 7 * * 1', mode: 'merge' },
        ]) {
            expect(loosenedSpecSwitches(BASE, withSpec({ upstreamSync }))).toEqual([
                'upstreamSync',
            ]);
        }
    });

    it('reports switching ON upstream pull requests and automatic re-provisioning', () => {
        const head = withSpec({
            upstreamPullRequests: { enabled: true, requireApproval: true, maxOpen: 3 },
            provisioning: { autoReprovision: true },
        });
        expect(loosenedSpecSwitches(BASE, head)).toEqual([
            'upstreamPullRequests.enabled',
            'provisioning.autoReprovision',
        ]);
    });

    it('does NOT report switching them OFF (tightening stays allowed)', () => {
        const on = withSpec({
            upstreamPullRequests: { enabled: true, requireApproval: true, maxOpen: 3 },
            provisioning: { autoReprovision: true },
        });
        expect(loosenedSpecSwitches(on, BASE)).toEqual([]);
    });

    it('compares a missing base against the defaults (both switches off)', () => {
        expect(
            loosenedSpecSwitches(null, {
                provisioning: { autoReprovision: true },
            } as unknown as AppSpec),
        ).toEqual(['provisioning.autoReprovision']);
    });
});

describe('AppChangeGuard rule 4 — the loosening switches', () => {
    const previous = process.env[APP_CHANGE_GUARD_SPEC_SWITCHES_ENV];
    afterEach(() => {
        if (previous === undefined) delete process.env[APP_CHANGE_GUARD_SPEC_SWITCHES_ENV];
        else process.env[APP_CHANGE_GUARD_SPEC_SWITCHES_ENV] = previous;
    });

    it('refuses an agent switching on automatic re-provisioning', () => {
        const verdict = judgeSpec(withSpec({ provisioning: { autoReprovision: true } }));
        expect(verdict.allowed).toBe(false);
        expect(verdict.code).toBe('guardedSpecBlock');
        expect(verdict.message).toMatch(/switches on provisioning\.autoReprovision/);
    });

    it('refuses an agent switching on upstream pull requests', () => {
        const verdict = judgeSpec(
            withSpec({
                upstreamPullRequests: { enabled: true, requireApproval: true, maxOpen: 3 },
            }),
        );
        expect(verdict.allowed).toBe(false);
        expect(verdict.message).toMatch(/switches on upstreamPullRequests\.enabled/);
    });

    it('refuses an agent re-pointing the upstream sync', () => {
        const verdict = judgeSpec(
            withSpec({
                upstreamSync: { enabled: true, schedule: '0 6 * * 1', mode: 'merge', branch: 'x' },
            }),
        );
        expect(verdict.allowed).toBe(false);
        expect(verdict.message).toMatch(/changes upstreamSync/);
    });

    it('still allows switching them OFF', () => {
        const on = withSpec({
            upstreamPullRequests: { enabled: true, requireApproval: true, maxOpen: 3 },
            provisioning: { autoReprovision: true },
        });
        const verdict = guard.evaluate({
            rules: rules(),
            diff: diff([file(APP_SPEC_PATH)]),
            baseSpec: on,
            headSpec: BASE,
        });
        expect(verdict.allowed).toBe(true);
    });

    it('APP_CHANGE_GUARD_SPEC_SWITCHES_ENFORCED=false restores the FR-26-only answer', () => {
        process.env[APP_CHANGE_GUARD_SPEC_SWITCHES_ENV] = 'false';
        expect(judgeSpec(withSpec({ provisioning: { autoReprovision: true } })).allowed).toBe(true);
    });
});

describe('AppChangeGuard — agents.requireHumanMergePaths on an allowed verdict', () => {
    it('names the changed paths a person must merge (a rename counts its old path)', () => {
        const verdict = guard.evaluate({
            rules: rules({ humanMergePaths: ['**/migrations/**'] }),
            diff: diff([
                file('src/app.ts'),
                file('db/migrations/001-init.sql'),
                file('src/moved.sql', { status: 'renamed', previousPath: 'db/migrations/002.sql' }),
            ]),
        });
        expect(verdict.allowed).toBe(true);
        expect(verdict.humanMergePaths).toEqual([
            'db/migrations/001-init.sql',
            'db/migrations/002.sql',
        ]);
    });

    it('leaves the verdict exactly as it was when nothing matches', () => {
        const verdict = guard.evaluate({
            rules: rules({ humanMergePaths: ['**/migrations/**'] }),
            diff: diff([file('src/app.ts')]),
        });
        expect(verdict.allowed).toBe(true);
        expect('humanMergePaths' in verdict).toBe(false);
    });

    it('never turns a refusal into a human-merge answer', () => {
        const verdict = guard.evaluate({
            rules: rules({ humanMergePaths: ['**'] }),
            diff: diff([file('.github/workflows/ci.yml')]),
        });
        expect(verdict.allowed).toBe(false);
        expect(verdict.humanMergePaths).toBeUndefined();
    });
});
