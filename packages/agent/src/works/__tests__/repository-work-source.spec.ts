import { parseRepositoryWorkSource } from '../repository-work-source';

/**
 * `parseRepositoryWorkSource` is the only thing standing between a
 * user-typed URL and `sourceRepository.relatedRepositories.data` — the
 * coordinates `Work.getDataRepo()` hands to the Task worktree provisioner.
 * Pin what it accepts, what it normalizes, and what it refuses.
 */
describe('parseRepositoryWorkSource', () => {
    it('parses a canonical GitHub URL into data-repository coordinates', () => {
        expect(parseRepositoryWorkSource('https://github.com/ever-works/ever-works')).toEqual({
            url: 'https://github.com/ever-works/ever-works',
            owner: 'ever-works',
            repo: 'ever-works',
            gitProvider: 'github',
            storageProvider: 'user-github',
        });
    });

    it.each([
        ['a .git suffix', 'https://github.com/ever-works/directory-web-template.git'],
        ['a trailing slash', 'https://github.com/ever-works/directory-web-template/'],
        ['surrounding whitespace', '  https://github.com/ever-works/directory-web-template  '],
        ['a www host', 'https://www.github.com/ever-works/directory-web-template'],
        ['plain http', 'http://github.com/ever-works/directory-web-template'],
        ['no scheme', 'github.com/ever-works/directory-web-template'],
    ])('normalizes %s to the canonical https form', (_label, input) => {
        const parsed = parseRepositoryWorkSource(input);
        expect(parsed?.url).toBe('https://github.com/ever-works/directory-web-template');
        expect(parsed?.owner).toBe('ever-works');
        expect(parsed?.repo).toBe('directory-web-template');
    });

    it('keeps the owner and repository case the user wrote', () => {
        const parsed = parseRepositoryWorkSource('https://github.com/Ever-Works/Ever-Works');
        expect(parsed?.owner).toBe('Ever-Works');
        expect(parsed?.repo).toBe('Ever-Works');
        expect(parsed?.url).toBe('https://github.com/Ever-Works/Ever-Works');
    });

    it('accepts repository names that start with a dot (`.github`, `.dotfiles`) — owners still may not', () => {
        expect(parseRepositoryWorkSource('https://github.com/ever-works/.github')).toMatchObject({
            owner: 'ever-works',
            repo: '.github',
            url: 'https://github.com/ever-works/.github',
        });
        expect(parseRepositoryWorkSource('https://github.com/evereq/.dotfiles')?.repo).toBe(
            '.dotfiles',
        );
        // A GitHub owner cannot start with a dot, and `.` / `..` are path
        // components rather than repository names.
        expect(parseRepositoryWorkSource('https://github.com/.ever-works/repo')).toBeNull();
        expect(parseRepositoryWorkSource('https://github.com/ever-works/.')).toBeNull();
        expect(parseRepositoryWorkSource('https://github.com/ever-works/..')).toBeNull();
    });

    it('returns null for GitLab and Bitbucket hosts until a git-provider plugin for them ships', () => {
        // Only the `github` git-provider plugin exists. A Work persisted with
        // `gitProvider: 'gitlab'` would be one no Task can ever clone, so the
        // parser refuses the URL up front — the same 400 as an unknown host.
        // When GitLab lands, remember nested groups (`group/subgroup/project`).
        expect(parseRepositoryWorkSource('https://gitlab.com/group/project')).toBeNull();
        expect(parseRepositoryWorkSource('https://gitlab.com/group/subgroup/project')).toBeNull();
        expect(parseRepositoryWorkSource('https://bitbucket.org/team/project')).toBeNull();
    });

    it.each([
        ['undefined', undefined],
        ['null', null],
        ['an empty string', ''],
        ['whitespace', '   '],
        ['a non-string', 42 as unknown as string],
        ['an unsupported host', 'https://example.com/owner/repo'],
        ['an owner-only path', 'https://github.com/ever-works'],
        ['a deeper path', 'https://github.com/ever-works/ever-works/tree/develop'],
        ['an ssh URL', 'git@github.com:ever-works/ever-works.git'],
        ['a query string', 'https://github.com/ever-works/ever-works?tab=readme'],
        ['embedded credentials', 'https://token@github.com/ever-works/ever-works'],
        ['a bad segment', 'https://github.com/ever-works/<script>'],
        ['an over-long value', `https://github.com/ever-works/${'a'.repeat(400)}`],
    ])('returns null for %s instead of throwing', (_label, input) => {
        expect(() => parseRepositoryWorkSource(input)).not.toThrow();
        expect(parseRepositoryWorkSource(input)).toBeNull();
    });
});
