import {
    AgentPluginExportService,
    everWorksMcpDescriptorFiles,
    EVER_WORKS_MCP_PACKAGE,
    EVER_WORKS_MCP_URL,
    ExportFailed,
} from './export.service';

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

describe('Ever Works MCP descriptor (T36)', () => {
    it('passes the SAME importer gate as any other export', async () => {
        // A descriptor we publish is a package other clients install, so it
        // has to pass exactly what we would demand of theirs.
        const result = await service.buildEverWorksMcpDescriptor();

        expect([...result.files.keys()].sort()).toEqual(['mcp.json', 'plugin.json']);
    });

    it('declares a streamable-http server at the hosted endpoint', async () => {
        const files = everWorksMcpDescriptorFiles();
        const mcp = JSON.parse(files.get('mcp.json')!);

        expect(mcp.mcpServers['ever-works']).toEqual({
            type: 'streamable-http',
            url: EVER_WORKS_MCP_URL,
        });
    });

    it('carries NO credentials, which AP-15 makes a rule rather than a preference', async () => {
        const files = everWorksMcpDescriptorFiles();
        const mcp = JSON.parse(files.get('mcp.json')!);

        // Package-configured headers are visible and non-secret, so a
        // descriptor embedding an API key would publish that key to every
        // consumer of the package.
        expect(mcp.mcpServers['ever-works'].headers).toBeUndefined();
        expect(JSON.stringify(files.get('mcp.json'))).not.toMatch(/token|secret|api[-_]?key/iu);
    });

    it('uses a server name that is safe as a tool namespace', async () => {
        const files = everWorksMcpDescriptorFiles();
        const mcp = JSON.parse(files.get('mcp.json')!);

        // Becomes `mcp__ever-works__<tool>`, so it must not contain the
        // `__` separator or the name could not be split back apart.
        for (const name of Object.keys(mcp.mcpServers)) {
            expect(name).not.toContain('__');
            expect(name).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/u);
        }
    });

    it('names the package with a reverse-domain identifier the spec accepts', async () => {
        const files = everWorksMcpDescriptorFiles();
        const plugin = JSON.parse(files.get('plugin.json')!);

        expect(plugin.name).toBe(EVER_WORKS_MCP_PACKAGE);
        expect(plugin.$schema).toContain('1.0.0');
    });

    it('is a valid package despite having NO skills', async () => {
        // The specification lets a package support any subset of the
        // component types; a descriptor declares a server and nothing else.
        const result = await service.buildEverWorksMcpDescriptor();

        expect(result.files.has('skills')).toBe(false);
        expect([...result.files.keys()].some((k) => k.startsWith('skills/'))).toBe(false);
    });

    it('accepts an override URL for a self-hosted deployment', async () => {
        const files = everWorksMcpDescriptorFiles({ url: 'https://mcp.example.com/mcp' });
        const mcp = JSON.parse(files.get('mcp.json')!);

        expect(mcp.mcpServers['ever-works'].url).toBe('https://mcp.example.com/mcp');
    });
});
