import type { AppSpec } from '@ever-works/contracts';
import {
    GUARDED_SPEC_BLOCKS,
    HUMAN_REQUIRED_SPEC_BLOCKS,
    PATH_LIST_BLOCKS,
    diffGuardedSpecBlocks,
    isProtectedPath,
    isRequireHumanMergePath,
} from '../app-spec-guarded-blocks';

/**
 * APW-03 T12 — the guarded App spec blocks (FR-26, ACC-03-15, plan §2.7:386).
 *
 * > A Task pull request that changes `source`, `blueprint`, `license`,
 * > `display.protectedPaths`, `upstreamPullRequests` or `provisioning` MUST be
 * > reported to the quality gate as needing a person.
 *
 * The two halves of T12's rule that decide whether the guard is usable or
 * obstructive are both asserted here: **a removal from a path list is reported**
 * (the member is taking protection away) and **an addition is not** (a member —
 * or an agent — tightening the list must never need a person). ACC-03-15's
 * "`license.class` change is reported to the gate" is the whole-block half.
 */
describe('app-spec-guarded-blocks (APW-03 T12, FR-26)', () => {
    /** A spec whose guarded blocks are all present and all restrictive. */
    function spec(overrides: Partial<AppSpec> = {}): AppSpec {
        return {
            source: { relation: 'fork', upstream: { repo: 'calcom/cal.diy' }, branch: 'main' },
            blueprint: {
                id: 'cal-diy',
                version: '1.0.0',
                repo: 'ever-works/cal-diy-template',
                sha: '0'.repeat(40),
            },
            license: { spdx: 'MIT', class: 'green', source: 'blueprint' },
            display: {
                name: 'Cal.diy (community build)',
                protectedPaths: ['apps/web/public/brand/**', '.github/workflows/**'],
            },
            agents: {
                instructionFiles: ['AGENTS.md'],
                requireHumanMergePaths: ['.github/**', 'LICENSE'],
            },
            upstreamPullRequests: { enabled: false, requireApproval: true, maxOpen: 3 },
            provisioning: { autoReprovision: false },
            build: { strategy: 'dockerfile' },
            components: [{ name: 'web', role: 'web', port: 3000 }],
            ...overrides,
        };
    }

    describe('the block list itself', () => {
        it('is exactly FR-26’s six blocks plus the second path list, in the spec’s order', () => {
            expect(GUARDED_SPEC_BLOCKS).toEqual([
                'source',
                'blueprint',
                'license',
                'display.protectedPaths',
                'agents.requireHumanMergePaths',
                'upstreamPullRequests',
                'provisioning',
            ]);
        });

        it('names the three blocks a whole change to which needs a person, and the two path lists', () => {
            expect(HUMAN_REQUIRED_SPEC_BLOCKS).toEqual(['source', 'blueprint', 'license']);
            expect(PATH_LIST_BLOCKS).toEqual([
                'display.protectedPaths',
                'agents.requireHumanMergePaths',
            ]);
            // Every one of them is a guarded block: a block cannot need a person
            // without being reported as changed.
            for (const block of [...HUMAN_REQUIRED_SPEC_BLOCKS, ...PATH_LIST_BLOCKS]) {
                expect(GUARDED_SPEC_BLOCKS).toContain(block);
            }
            // The two sets are disjoint: a path list needs a person for a removal,
            // never for the block changing as such.
            for (const block of PATH_LIST_BLOCKS) {
                expect(HUMAN_REQUIRED_SPEC_BLOCKS).not.toContain(block);
            }
        });
    });

    describe('diffGuardedSpecBlocks', () => {
        it('reports nothing when the spec is unchanged', () => {
            const diff = diffGuardedSpecBlocks(spec(), spec());

            expect(diff.changedBlocks).toEqual([]);
            expect(diff.removedProtectedPaths).toEqual([]);
            expect(diff.removedRequireHumanMergePaths).toEqual([]);
            expect(diff.requiresHumanReview).toBe(false);
            expect(diff.unchanged).toBe(true);
        });

        it('reports a key-order or comment-only difference as unchanged (FR-23’s definition of "same")', () => {
            const reordered: AppSpec = {
                components: [{ port: 3000, role: 'web', name: 'web' }],
                build: { strategy: 'dockerfile' },
                provisioning: { autoReprovision: false },
                upstreamPullRequests: { requireApproval: true, enabled: false, maxOpen: 3 },
                agents: {
                    requireHumanMergePaths: ['.github/**', 'LICENSE'],
                    instructionFiles: ['AGENTS.md'],
                },
                display: {
                    protectedPaths: ['apps/web/public/brand/**', '.github/workflows/**'],
                    name: 'Cal.diy (community build)',
                },
                license: { class: 'green', spdx: 'MIT', source: 'blueprint' },
                blueprint: {
                    sha: '0'.repeat(40),
                    repo: 'ever-works/cal-diy-template',
                    version: '1.0.0',
                    id: 'cal-diy',
                },
                source: { branch: 'main', upstream: { repo: 'calcom/cal.diy' }, relation: 'fork' },
            };

            expect(diffGuardedSpecBlocks(spec(), reordered).unchanged).toBe(true);
        });

        it('reports a license.class change — ACC-03-15 — and needs a person', () => {
            const diff = diffGuardedSpecBlocks(
                spec(),
                spec({ license: { spdx: 'MIT', class: 'amber', source: 'user' } }),
            );

            expect(diff.changedBlocks).toEqual(['license']);
            expect(diff.requiresHumanReview).toBe(true);
            expect(diff.unchanged).toBe(false);
        });

        it('reports a source change and a blueprint change as needing a person', () => {
            const source = diffGuardedSpecBlocks(spec(), spec({ source: { relation: 'link' } }));
            expect(source.changedBlocks).toEqual(['source']);
            expect(source.requiresHumanReview).toBe(true);

            const blueprint = diffGuardedSpecBlocks(
                spec(),
                spec({
                    blueprint: {
                        id: 'cal-diy',
                        version: '2.0.0',
                        repo: 'ever-works/cal-diy-template',
                        sha: '1'.repeat(40),
                    },
                }),
            );
            expect(blueprint.changedBlocks).toEqual(['blueprint']);
            expect(blueprint.requiresHumanReview).toBe(true);
        });

        it('reports a REMOVED protected path, names it, and needs a person', () => {
            const diff = diffGuardedSpecBlocks(
                spec(),
                spec({
                    display: {
                        name: 'Cal.diy (community build)',
                        protectedPaths: ['.github/workflows/**'],
                    },
                }),
            );

            expect(diff.changedBlocks).toEqual(['display.protectedPaths']);
            expect(diff.removedProtectedPaths).toEqual(['apps/web/public/brand/**']);
            expect(diff.requiresHumanReview).toBe(true);
        });

        it('does NOT report an ADDED protected path — a member may always tighten', () => {
            const diff = diffGuardedSpecBlocks(
                spec(),
                spec({
                    display: {
                        name: 'Cal.diy (community build)',
                        protectedPaths: [
                            'apps/web/public/brand/**',
                            '.github/workflows/**',
                            'apps/web/public/logo.svg',
                        ],
                    },
                }),
            );

            expect(diff.removedProtectedPaths).toEqual([]);
            expect(diff.requiresHumanReview).toBe(false);
            // The block is still reported as changed (APW-05/06/08 see it), but it is
            // not a change a person has to approve.
            expect(diff.changedBlocks).toEqual(['display.protectedPaths']);
        });

        it('reports a REMOVED agents.requireHumanMergePaths entry, names it, and needs a person', () => {
            const diff = diffGuardedSpecBlocks(
                spec(),
                spec({
                    agents: {
                        instructionFiles: ['AGENTS.md'],
                        requireHumanMergePaths: ['.github/**'],
                    },
                }),
            );

            expect(diff.changedBlocks).toEqual(['agents.requireHumanMergePaths']);
            expect(diff.removedRequireHumanMergePaths).toEqual(['LICENSE']);
            expect(diff.requiresHumanReview).toBe(true);
        });

        it('does NOT report an ADDED agents.requireHumanMergePaths entry', () => {
            const diff = diffGuardedSpecBlocks(
                spec(),
                spec({
                    agents: {
                        instructionFiles: ['AGENTS.md'],
                        requireHumanMergePaths: ['.github/**', 'LICENSE', 'infra/**'],
                    },
                }),
            );

            expect(diff.removedRequireHumanMergePaths).toEqual([]);
            expect(diff.requiresHumanReview).toBe(false);
            expect(diff.changedBlocks).toEqual(['agents.requireHumanMergePaths']);
        });

        it('reports both removals when both lists lose an entry, in the spec’s order', () => {
            const diff = diffGuardedSpecBlocks(
                spec(),
                spec({
                    display: { protectedPaths: [] },
                    agents: { requireHumanMergePaths: [] },
                }),
            );

            expect(diff.changedBlocks).toEqual([
                'display.protectedPaths',
                'agents.requireHumanMergePaths',
            ]);
            expect(diff.removedProtectedPaths).toEqual([
                'apps/web/public/brand/**',
                '.github/workflows/**',
            ]);
            expect(diff.removedRequireHumanMergePaths).toEqual(['.github/**', 'LICENSE']);
            expect(diff.requiresHumanReview).toBe(true);
        });

        it('reports changes to upstreamPullRequests and provisioning WITHOUT needing a person', () => {
            const diff = diffGuardedSpecBlocks(
                spec(),
                spec({
                    upstreamPullRequests: { enabled: true, requireApproval: true, maxOpen: 5 },
                    provisioning: { autoReprovision: true },
                }),
            );

            expect(diff.changedBlocks).toEqual(['upstreamPullRequests', 'provisioning']);
            expect(diff.requiresHumanReview).toBe(false);
        });

        it('does NOT report display.name — renaming a Work is not a guarded block', () => {
            const diff = diffGuardedSpecBlocks(
                spec(),
                spec({
                    display: {
                        name: 'My own Cal.diy',
                        protectedPaths: spec().display?.protectedPaths as string[],
                    },
                }),
            );

            expect(diff.changedBlocks).toEqual([]);
            expect(diff.unchanged).toBe(true);
        });

        it('reports every guarded block as changed against an absent previous spec (the first apply)', () => {
            const diff = diffGuardedSpecBlocks(null, spec());

            expect(diff.changedBlocks).toEqual([...GUARDED_SPEC_BLOCKS]);
            expect(diff.requiresHumanReview).toBe(true);
        });

        it('reports every guarded block as changed when the new spec has none of them', () => {
            const diff = diffGuardedSpecBlocks(spec(), null);

            expect(diff.changedBlocks).toEqual([...GUARDED_SPEC_BLOCKS]);
            expect(diff.removedProtectedPaths).toEqual([
                'apps/web/public/brand/**',
                '.github/workflows/**',
            ]);
            expect(diff.removedRequireHumanMergePaths).toEqual(['.github/**', 'LICENSE']);
        });
    });

    describe('isProtectedPath (minimatch, { dot: true })', () => {
        it('matches a declared glob, at any depth', () => {
            const withPaths = spec();

            expect(isProtectedPath(withPaths, 'apps/web/public/brand/logo.svg')).toBe(true);
            expect(isProtectedPath(withPaths, '.github/workflows/ci.yml')).toBe(true);
        });

        it('matches a dot-prefixed path — the reason for { dot: true }', () => {
            const withPaths = spec({ display: { protectedPaths: ['*', '**/*'] } });

            // Without `dot: true` minimatch's `*` does not cross a leading dot, and
            // the App spec itself (`.works/works.yml`) would be unprotected.
            expect(isProtectedPath(withPaths, '.works/works.yml')).toBe(true);
            expect(isProtectedPath(withPaths, '.env')).toBe(true);
        });

        it('answers false for a path no glob covers, without throwing on a partial spec', () => {
            const withPaths = spec();

            expect(isProtectedPath(withPaths, 'README.md')).toBe(false);
            expect(
                isProtectedPath(spec({ display: undefined }), 'apps/web/public/brand/logo.svg'),
            ).toBe(false);
            expect(isProtectedPath(null, 'anything')).toBe(false);
            expect(isProtectedPath(withPaths, '')).toBe(false);
        });

        it('matches an exact path and a brace-free character class', () => {
            const withPaths = spec({ display: { protectedPaths: ['LICENSE', 'docs/[0-9]*.md'] } });

            expect(isProtectedPath(withPaths, 'LICENSE')).toBe(true);
            expect(isProtectedPath(withPaths, 'docs/1-intro.md')).toBe(true);
            expect(isProtectedPath(withPaths, 'docs/x-intro.md')).toBe(false);
        });

        it('matches the second list through isRequireHumanMergePath with the same matcher', () => {
            const withPaths = spec();

            expect(isRequireHumanMergePath(withPaths, 'LICENSE')).toBe(true);
            expect(isRequireHumanMergePath(withPaths, '.github/PULL_REQUEST_TEMPLATE.md')).toBe(
                true,
            );
            expect(isRequireHumanMergePath(withPaths, 'apps/web/public/brand/logo.svg')).toBe(
                false,
            );
            expect(isRequireHumanMergePath(null, 'LICENSE')).toBe(false);
        });
    });
});
