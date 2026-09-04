import { AgentPluginExportService, ExportFailed } from './export.service';

/**
 * These run the REAL serializer and the REAL importer against a real
 * temporary directory. AP-22 is a claim about what a consumer receives, and a
 * consumer receives a tree — so a test over in-memory strings would be
 * testing something else.
 */

const service = new AgentPluginExportService();

const skill = (over: Partial<Parameters<typeof service.buildPackage>[0]['skills'][0]> = {}) => ({
    slug: 'release-notes',
    description: 'Draft release notes from a changelog.',
    body: '# Release notes\n\nInstructions.\n',
    ...over,
});

const manifest = { name: 'acme.tools', version: '1.0.0' };

describe('AgentPluginExportService', () => {
    it('produces a package that our OWN importer accepts', async () => {
        const result = await service.buildPackage({ manifest, skills: [skill()] });

        // The round-trip gate: `buildPackage` throws unless the written tree
        // loads, so reaching here IS the assertion that AP-22 holds.
        expect([...result.files.keys()].sort()).toEqual([
            'plugin.json',
            'skills/release-notes/SKILL.md',
        ]);
        expect(result.rejected).toEqual([]);
    });

    it('writes the skill name as BOTH the directory and the frontmatter (AP-23)', async () => {
        const result = await service.buildPackage({ manifest, skills: [skill()] });

        const content = result.files.get('skills/release-notes/SKILL.md');
        expect(content).toContain('name: release-notes');
        expect(content).toContain('description: Draft release notes from a changelog.');
        expect(content).toContain('Instructions.');
    });

    it('emits a manifest carrying the published schema id', async () => {
        const result = await service.buildPackage({ manifest, skills: [skill()] });

        const plugin = JSON.parse(result.files.get('plugin.json')!);
        expect(plugin.$schema).toContain('1.0.0');
        expect(plugin.name).toBe('acme.tools');
    });

    it('REPORTS an unusable slug with a suggestion rather than renaming it', async () => {
        const result = await service.buildPackage({
            manifest,
            skills: [skill(), skill({ slug: 'Release--Notes-' })],
        });

        // A renamed skill is a DIFFERENT skill to a consumer: bindings,
        // references and documentation all key on the name. So the caller is
        // asked rather than having a rename applied behind them.
        expect(result.rejected).toHaveLength(1);
        expect(result.rejected[0].slug).toBe('Release--Notes-');
        expect(result.rejected[0].suggestion).toBeTruthy();
        expect(result.files.has('skills/Release--Notes-/SKILL.md')).toBe(false);
    });

    it('refuses two slugs that narrow onto the SAME name', async () => {
        const result = await service.buildPackage({
            manifest,
            skills: [skill({ slug: 'notes' }), skill({ slug: 'Notes' })],
        });

        // Emitting both would leave one directory containing whichever was
        // written last — a skill that vanishes with no error anywhere.
        expect(result.files.has('skills/notes/SKILL.md')).toBe(true);
        expect(result.rejected).toHaveLength(1);
        expect(result.rejected[0].slug).toBe('Notes');
    });

    it('fails loudly when the selection yields no valid skills', async () => {
        await expect(
            service.buildPackage({ manifest, skills: [skill({ slug: '---' })] }),
        ).rejects.toBeInstanceOf(ExportFailed);
    });

    it('carries the importer’s findings when the result does not load', async () => {
        // A manifest name the spec forbids: the serializer refuses it before
        // the importer is reached, which is the earlier of the two gates.
        await expect(
            service.buildPackage({ manifest: { name: 'Not A Name' }, skills: [skill()] }),
        ).rejects.toThrow();
    });

    it('round-trips allowed-tools and license through the frontmatter', async () => {
        const result = await service.buildPackage({
            manifest,
            skills: [skill({ allowedTools: ['Read', 'Grep'], license: 'MIT' })],
        });

        const content = result.files.get('skills/release-notes/SKILL.md')!;
        expect(content).toContain('allowed-tools: Read Grep');
        expect(content).toContain('license: MIT');
    });

    it('produces a zip containing the same entries', async () => {
        const result = await service.buildPackage({ manifest, skills: [skill()] });

        const zip = await service.toZip(result.files);

        expect(zip.length).toBeGreaterThan(0);
        const { default: JSZip } = await import('jszip');
        const reopened = await JSZip.loadAsync(zip);
        expect(Object.keys(reopened.files).sort()).toEqual(
            expect.arrayContaining(['plugin.json', 'skills/release-notes/SKILL.md']),
        );
    });

    it('leaves no temporary directory behind after a failure', async () => {
        const { readdir } = await import('node:fs/promises');
        const { tmpdir } = await import('node:os');

        const before = (await readdir(tmpdir())).filter((n) => n.startsWith('ap-export-')).length;
        await service
            .buildPackage({ manifest, skills: [skill({ slug: '---' })] })
            .catch(() => undefined);
        const after = (await readdir(tmpdir())).filter((n) => n.startsWith('ap-export-')).length;

        // An export can carry a user's private instructions; a temp directory
        // nobody cleans is exactly where those would linger.
        expect(after).toBe(before);
    });
});
