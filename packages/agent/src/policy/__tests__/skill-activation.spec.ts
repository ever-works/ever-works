import { filterSkillsByToolGrants } from '../skill-activation';
import { resolveToolGrantChain } from '../tool-grant';

/**
 * Grant-aware skill activation (audit item G12).
 *
 * The behaviour that matters: a Skill is suppressed ONLY when every tool
 * it declares is refused. Declaring nothing, or keeping one tool, keeps it
 * active — and with no matrix wired nothing changes at all.
 */

const skill = (slug: string, allowedTools?: string[] | null) => ({ slug, allowedTools });

describe('filterSkillsByToolGrants', () => {
    it('leaves every skill active when no matrix is wired', () => {
        const skills = [skill('a', ['deploy_work']), skill('b')];
        const result = filterSkillsByToolGrants(skills, null);
        expect(result.active).toEqual(skills);
        expect(result.suppressed).toEqual([]);
    });

    it('leaves every skill active under the permissive platform default', () => {
        const grants = resolveToolGrantChain([]);
        const result = filterSkillsByToolGrants([skill('a', ['deploy_work']), skill('b')], grants);
        expect(result.active.map((s) => s.slug)).toEqual(['a', 'b']);
    });

    it('keeps a skill that declares no tools even when the matrix grants nothing', () => {
        const grants = resolveToolGrantChain([{ scope: 'tenant', id: 't1', grant: { allow: [] } }]);
        const result = filterSkillsByToolGrants([skill('style-guide')], grants);
        expect(result.active.map((s) => s.slug)).toEqual(['style-guide']);
    });

    it('suppresses a skill whose every declared tool is refused', () => {
        const grants = resolveToolGrantChain([
            { scope: 'tenant', id: 't1', grant: { allow: ['git_*'] } },
        ]);
        const result = filterSkillsByToolGrants(
            [skill('deployer', ['deploy_work', 'deploy_rollback'])],
            grants,
        );
        expect(result.active).toEqual([]);
        expect(result.suppressed).toHaveLength(1);
        expect(result.suppressed[0].slug).toBe('deployer');
        expect(result.suppressed[0].refusals.map((r) => r.toolName)).toEqual([
            'deploy_work',
            'deploy_rollback',
        ]);
    });

    it('keeps a skill that retains at least ONE granted tool', () => {
        const grants = resolveToolGrantChain([
            { scope: 'tenant', id: 't1', grant: { allow: ['git_*'] } },
        ]);
        const result = filterSkillsByToolGrants(
            [skill('mixed', ['deploy_work', 'git_commit'])],
            grants,
        );
        expect(result.active.map((s) => s.slug)).toEqual(['mixed']);
        expect(result.suppressed).toEqual([]);
    });

    it('honours a deny even when the tool is otherwise allowed', () => {
        const grants = resolveToolGrantChain([
            { scope: 'tenant', id: 't1', grant: { allow: ['*'] } },
            { scope: 'organization', id: 'o1', grant: { deny: ['commitToRepo'] } },
        ]);
        const result = filterSkillsByToolGrants([skill('committer', ['commitToRepo'])], grants);
        expect(result.active).toEqual([]);
        expect(result.suppressed[0].refusals[0].code).toBe('tool-denied');
    });

    it('ignores blank / non-string entries in allowedTools', () => {
        const grants = resolveToolGrantChain([{ scope: 'tenant', id: 't1', grant: { allow: [] } }]);
        const result = filterSkillsByToolGrants(
            [skill('junk', ['   ', '', null as unknown as string])],
            grants,
        );
        // Nothing meaningful was declared → treated as "declares nothing".
        expect(result.active.map((s) => s.slug)).toEqual(['junk']);
    });
});
