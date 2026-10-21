import {
    alwaysProtectedRepoPaths,
    isAlwaysProtectedRepoPath,
    workflowChangesAllowedForWork,
} from '../agent-protected-repo-paths';

/** Prompt-injection hardening — repository paths an Agent may never change (reviews of #2769). */
describe('always-protected repository paths', () => {
    it('protects every file under .github/workflows/ and .github/actions/', () => {
        expect(isAlwaysProtectedRepoPath('.github/workflows/ci.yml')).toBe(true);
        expect(isAlwaysProtectedRepoPath('./.GitHub/Actions/setup/action.yml')).toBe(true);
        expect(isAlwaysProtectedRepoPath('.github\\workflows\\deploy.yml')).toBe(true);
        expect(isAlwaysProtectedRepoPath('/.github/workflows/release.yaml')).toBe(true);
    });

    // Review of #2769: replacing the directory entry itself (a symlink or a
    // submodule at `.github`) swaps every workflow at once.
    it('protects the bare .github entry and the protected directories themselves', () => {
        expect(isAlwaysProtectedRepoPath('.github')).toBe(true);
        expect(isAlwaysProtectedRepoPath('.github/')).toBe(true);
        expect(isAlwaysProtectedRepoPath('.GITHUB')).toBe(true);
        expect(isAlwaysProtectedRepoPath('.github/workflows')).toBe(true);
        expect(isAlwaysProtectedRepoPath('.github/actions/')).toBe(true);
    });

    // CodeQL on #2769: no polynomial regex on the (model-supplied) path.
    it('stays linear on a path made of thousands of slashes', () => {
        // The slow case for a `/\/+$/` regex: a long run of `/` that is NOT at
        // the end (every start position scans the run, then fails on `x`) —
        // about 0.8 s with that regex, well under a millisecond with the loop.
        const started = Date.now();
        expect(isAlwaysProtectedRepoPath(`a${'/'.repeat(50_000)}x`)).toBe(false);
        expect(Date.now() - started).toBeLessThan(200);
        expect(isAlwaysProtectedRepoPath(`.github${'/'.repeat(50_000)}`)).toBe(true);
    });

    it('leaves the rest of the repository, and look-alikes, alone', () => {
        expect(isAlwaysProtectedRepoPath('.github/CODEOWNERS')).toBe(false);
        expect(isAlwaysProtectedRepoPath('.github/dependabot.yml')).toBe(false);
        expect(isAlwaysProtectedRepoPath('.github-templates/workflows/x.yml')).toBe(false);
        expect(isAlwaysProtectedRepoPath('docs/.github/workflows/x.yml')).toBe(false);
        expect(isAlwaysProtectedRepoPath('src/index.ts')).toBe(false);
        expect(isAlwaysProtectedRepoPath('')).toBe(false);
        expect(isAlwaysProtectedRepoPath(null)).toBe(false);
    });

    it('lists the distinct protected paths in first-seen order', () => {
        expect(
            alwaysProtectedRepoPaths([
                'src/a.ts',
                '.github',
                '.github/workflows/ci.yml',
                '.github',
            ]),
        ).toEqual(['.github', '.github/workflows/ci.yml']);
    });

    it('lifts the floor only for a Work the operator listed', () => {
        const env = { AGENT_WORKFLOW_CHANGES_ALLOWED_WORKS: ' W-1 , w-2' };
        expect(workflowChangesAllowedForWork('w-1', env)).toBe(true);
        expect(workflowChangesAllowedForWork('w-3', env)).toBe(false);
        expect(workflowChangesAllowedForWork(null, env)).toBe(false);
        expect(workflowChangesAllowedForWork('w-1', {})).toBe(false);
    });
});
