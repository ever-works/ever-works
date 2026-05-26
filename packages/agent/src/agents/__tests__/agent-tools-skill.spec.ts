import { createGetSkillBodyTool, shouldRegisterSkillTool } from '../agent-tools-skill';

describe('agent-tools-skill (Phase 10.3)', () => {
    describe('shouldRegisterSkillTool', () => {
        it('returns false when no skills are resolved', () => {
            expect(shouldRegisterSkillTool([])).toBe(false);
        });
        it('returns true when at least one skill is resolved', () => {
            expect(shouldRegisterSkillTool([{ slug: 'one' }])).toBe(true);
        });
    });

    describe('createGetSkillBodyTool', () => {
        let skills: any;
        let bindings: any;

        beforeEach(() => {
            skills = { findByIdAndUser: jest.fn() };
            bindings = { resolveActive: jest.fn().mockResolvedValue([]) };
        });

        it('emits a stable tool descriptor with the right shape', () => {
            const tool = createGetSkillBodyTool(skills, bindings, { userId: 'u1', agentId: 'a1' });
            expect(tool.name).toBe('getSkillBody');
            expect(tool.parameters.required).toEqual(['slug']);
            expect(tool.parameters.properties.slug.type).toBe('string');
        });

        it('returns an error when slug is missing', async () => {
            const tool = createGetSkillBodyTool(skills, bindings, { userId: 'u1', agentId: 'a1' });
            const out = await tool.invoke({ slug: '' as any });
            expect('error' in out).toBe(true);
        });

        it('returns an error when slug is not bound to the Agent', async () => {
            bindings.resolveActive.mockResolvedValueOnce([
                { binding: { priority: 100 }, skill: { id: 's1', slug: 'one' } },
            ]);
            const tool = createGetSkillBodyTool(skills, bindings, { userId: 'u1', agentId: 'a1' });
            const out = await tool.invoke({ slug: 'unknown' });
            expect('error' in out).toBe(true);
            expect((out as any).error).toMatch(/not bound/);
        });

        it('happy path returns the full skill body for a bound slug', async () => {
            bindings.resolveActive.mockResolvedValueOnce([
                { binding: { priority: 50 }, skill: { id: 's1', slug: 'cron-defaults' } },
            ]);
            skills.findByIdAndUser.mockResolvedValueOnce({
                id: 's1',
                slug: 'cron-defaults',
                title: 'Cron defaults',
                instructionsMd: '# Use UTC',
                version: '1.0.0',
            });
            const tool = createGetSkillBodyTool(skills, bindings, { userId: 'u1', agentId: 'a1' });
            const out = await tool.invoke({ slug: 'cron-defaults' });
            expect('body' in out && out.body).toBe('# Use UTC');
            expect('priority' in out && out.priority).toBe(50);
        });

        it('returns an error if the skill row is missing after binding-resolution', async () => {
            bindings.resolveActive.mockResolvedValueOnce([
                { binding: { priority: 100 }, skill: { id: 's-gone', slug: 'gone' } },
            ]);
            skills.findByIdAndUser.mockResolvedValueOnce(null);
            const tool = createGetSkillBodyTool(skills, bindings, { userId: 'u1', agentId: 'a1' });
            const out = await tool.invoke({ slug: 'gone' });
            expect('error' in out).toBe(true);
        });
    });
});
