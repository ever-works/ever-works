import { PromptAssemblerService } from '../prompt-assembler.service';

/**
 * Skill files feature — the ACTIVE SKILLS block gains a one-line
 * `files:` manifest per skill that carries companion files. Pinned
 * separately from the main assembler spec: absence of files must leave
 * the historical block shape byte-identical.
 */
describe('PromptAssemblerService — skill file manifests', () => {
    const assembler = new PromptAssemblerService();

    const agent = {
        id: 'a1',
        name: 'Agent',
        slug: 'agent',
        title: 'Agent',
        capabilities: null,
        maxSkillContextTokens: 4000,
        permissions: null,
        soulMd: 'You are the test agent.',
        agentsMd: null,
        heartbeatMd: null,
        toolsMd: null,
        agentYml: null,
    } as any;

    it('appends a files: manifest line inside the <skill> block when files are present', () => {
        const prompt = assembler.assemble({
            agent,
            kind: 'heartbeat',
            skills: [
                {
                    slug: 'deploy-helper',
                    body: 'Deploy carefully.',
                    priority: 10,
                    files: [
                        { filename: 'run.sh', kind: 'script', sizeBytes: 64 },
                        { filename: 'guide.md', kind: 'reference', sizeBytes: 2048 },
                    ],
                },
            ],
        });
        const block = prompt.systemMessage;
        expect(block).toContain('<skill slug="deploy-helper" priority="10">');
        expect(block).toContain(
            'files: run.sh (script, 64 B); guide.md (reference, 2.0 KB) — retrieve content with the getSkillFile tool.',
        );
        // The manifest sits INSIDE the fenced block.
        const skillBlock = block.slice(block.indexOf('<skill '), block.indexOf('</skill>'));
        expect(skillBlock).toContain('files: run.sh');
    });

    it('emits the historical block shape when a skill has no files', () => {
        const prompt = assembler.assemble({
            agent,
            kind: 'heartbeat',
            skills: [{ slug: 'plain', body: 'No files here.', priority: 5 }],
        });
        expect(prompt.systemMessage).toContain(
            '<skill slug="plain" priority="5">\nNo files here.\n</skill>',
        );
        expect(prompt.systemMessage).not.toContain('files:');
    });
});
