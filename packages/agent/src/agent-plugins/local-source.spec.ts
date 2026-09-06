import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import {
    DEFAULT_MAX_LOCAL_ENTRIES,
    parsePackageDirs,
    scanLocalPackages,
    scanLocalSources,
} from './local-source';

const PLUGIN_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
const MCP_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json';

async function scratch(): Promise<string> {
    return mkdtemp(join(tmpdir(), 'agent-plugins-local-'));
}

/** Writes a package directory and returns its path. */
async function makePackage(
    root: string,
    dirName: string,
    options?: {
        manifest?: unknown;
        rawManifest?: string;
        skills?: Record<string, string>;
        mcp?: unknown;
        omitManifest?: boolean;
    },
): Promise<string> {
    const dir = join(root, dirName);
    await mkdir(dir, { recursive: true });

    if (!options?.omitManifest) {
        const text =
            options?.rawManifest ??
            JSON.stringify(options?.manifest ?? { $schema: PLUGIN_SCHEMA, name: dirName }, null, 2);
        await writeFile(join(dir, 'plugin.json'), text, 'utf8');
    }

    for (const [name, body] of Object.entries(options?.skills ?? {})) {
        await mkdir(join(dir, 'skills', name), { recursive: true });
        await writeFile(join(dir, 'skills', name, 'SKILL.md'), body, 'utf8');
    }

    if (options?.mcp !== undefined) {
        await writeFile(join(dir, 'mcp.json'), JSON.stringify(options.mcp, null, 2), 'utf8');
    }

    return dir;
}

const skill = (name: string, description: string): string =>
    `---\nname: ${name}\ndescription: ${description}\n---\n\nBody.\n`;

describe('scanLocalPackages', () => {
    it('finds every immediate child directory carrying a manifest', async () => {
        const root = await scratch();
        await makePackage(root, 'alpha', {
            skills: { summarise: skill('summarise', 'Summarise a document. Use when condensing.') },
        });
        await makePackage(root, 'beta', {
            mcp: {
                $schema: MCP_SCHEMA,
                mcpServers: { api: { type: 'streamable-http', url: 'https://x.example.com/mcp' } },
            },
        });

        const scan = await scanLocalPackages(root);

        expect(scan.unavailable).toBe(false);
        expect(scan.candidates.map((c) => c.dirName)).toEqual(['alpha', 'beta']);
        expect(scan.candidates.every((c) => c.ok)).toBe(true);
        expect(scan.candidates[0]?.skillNames).toEqual(['summarise']);
        expect(scan.candidates[1]?.mcpServerNames).toEqual(['api']);
    });

    it('ignores a directory with no manifest instead of reporting it', async () => {
        // An operator may legitimately keep other folders alongside their
        // packages; those are not broken packages and must not generate noise.
        const root = await scratch();
        await makePackage(root, 'real');
        await mkdir(join(root, 'notes'), { recursive: true });
        await writeFile(join(root, 'notes', 'README.md'), '# not a package\n', 'utf8');
        await writeFile(join(root, 'loose-file.txt'), 'x', 'utf8');

        const scan = await scanLocalPackages(root);

        expect(scan.candidates.map((c) => c.dirName)).toEqual(['real']);
    });

    it('reports a package whose manifest is fatally invalid, rather than hiding it', async () => {
        // This one the operator MEANT to work, so silence would be wrong.
        const root = await scratch();
        await makePackage(root, 'good');
        await makePackage(root, 'broken', {
            manifest: { $schema: PLUGIN_SCHEMA, name: 'Bad Name' },
        });

        const scan = await scanLocalPackages(root);

        expect(scan.candidates.map((c) => c.dirName)).toEqual(['broken', 'good']);
        const broken = scan.candidates.find((c) => c.dirName === 'broken');
        expect(broken?.ok).toBe(false);
        expect(broken?.name).toBeUndefined();
        expect(broken?.summary.fatalCount).toBeGreaterThan(0);
        expect(scan.candidates.find((c) => c.dirName === 'good')?.ok).toBe(true);
    });

    it('carries per-package findings through without interpreting them', async () => {
        const root = await scratch();
        await makePackage(root, 'noisy', {
            manifest: { $schema: PLUGIN_SCHEMA, name: 'noisy', unknownField: 1 },
            skills: {
                good: skill('good', 'Loads fine.'),
                mismatched: skill('other', 'Name disagrees.'),
            },
        });

        const scan = await scanLocalPackages(root);
        const pkg = scan.candidates[0];

        expect(pkg?.ok).toBe(true);
        expect(pkg?.skillNames).toEqual(['good']);
        expect(pkg?.findings.map((f) => f.code)).toEqual(
            expect.arrayContaining(['manifest.unknown-field', 'skill.name-directory-mismatch']),
        );
    });

    it('treats a missing directory as empty rather than as an error', async () => {
        // The feature is off by default; a packages directory that has not been
        // created yet means zero packages, not a broken deployment, and must
        // never be able to stop the API booting.
        const scan = await scanLocalPackages(join(await scratch(), 'never-created'));

        expect(scan.unavailable).toBe(true);
        expect(scan.unavailableReason).toContain('does not exist');
        expect(scan.candidates).toEqual([]);
    });

    it('refuses a relative configured path', async () => {
        const scan = await scanLocalPackages('./packages');

        expect(scan.unavailable).toBe(true);
        expect(scan.unavailableReason).toContain('absolute');
    });

    it('caps how many entries it examines, and says so', async () => {
        const root = await scratch();
        for (const name of ['a', 'b', 'c']) {
            await makePackage(root, name);
        }

        const scan = await scanLocalPackages(root, { maxEntries: 2 });

        expect(scan.candidates).toHaveLength(2);
        expect(scan.unavailable).toBe(false);
        // Truncation is reported. A silent cap would read as "you have two
        // packages" to an operator who installed three.
        expect(scan.unavailableReason).toContain('only the first 2');
    });

    it('defaults the cap to a sane ceiling', () => {
        expect(DEFAULT_MAX_LOCAL_ENTRIES).toBe(200);
    });

    it('passes component support through to the loader', async () => {
        const root = await scratch();
        await makePackage(root, 'both', {
            skills: { s: skill('s', 'A skill.') },
            mcp: {
                $schema: MCP_SCHEMA,
                mcpServers: { api: { type: 'streamable-http', url: 'https://x.example.com/mcp' } },
            },
        });

        const skillsOnly = await scanLocalPackages(root, {
            load: { components: { skills: true, mcpServers: false } },
        });

        expect(skillsOnly.candidates[0]?.skillNames).toEqual(['s']);
        expect(skillsOnly.candidates[0]?.mcpServerNames).toEqual([]);
    });

    it('returns candidates in a stable order regardless of filesystem iteration', async () => {
        const root = await scratch();
        for (const name of ['zulu', 'alpha', 'mike']) {
            await makePackage(root, name);
        }

        const first = await scanLocalPackages(root);
        const second = await scanLocalPackages(root);

        expect(first.candidates.map((c) => c.dirName)).toEqual(['alpha', 'mike', 'zulu']);
        expect(second.candidates.map((c) => c.dirName)).toEqual(
            first.candidates.map((c) => c.dirName),
        );
    });

    it('records the manifest version when the package declares one', async () => {
        const root = await scratch();
        await makePackage(root, 'versioned', {
            manifest: { $schema: PLUGIN_SCHEMA, name: 'versioned', version: '2.1.0' },
        });
        await makePackage(root, 'unversioned');

        const scan = await scanLocalPackages(root);

        expect(scan.candidates.find((c) => c.dirName === 'versioned')?.version).toBe('2.1.0');
        // Absent is legal: the specification forbids rejecting a package for it.
        expect(scan.candidates.find((c) => c.dirName === 'unversioned')?.version).toBeUndefined();
    });

    it('never throws for a package an author could plausibly write', async () => {
        const root = await scratch();
        await makePackage(root, 'invalid-json', { rawManifest: '{ "name": "broken", }' });
        await makePackage(root, 'array-manifest', { rawManifest: '[]' });
        await makePackage(root, 'empty-manifest', { rawManifest: '' });

        await expect(scanLocalPackages(root)).resolves.toBeDefined();
        const scan = await scanLocalPackages(root);
        expect(scan.candidates).toHaveLength(3);
        expect(scan.candidates.every((c) => !c.ok)).toBe(true);
    });
});

describe('scanLocalSources', () => {
    it('scans directories in order and lets the first definition of a name win', async () => {
        const primary = await scratch();
        const secondary = await scratch();
        await makePackage(primary, 'shared', {
            manifest: { $schema: PLUGIN_SCHEMA, name: 'shared-tools' },
        });
        await makePackage(secondary, 'shared-copy', {
            manifest: { $schema: PLUGIN_SCHEMA, name: 'shared-tools' },
        });
        await makePackage(secondary, 'unique', {
            manifest: { $schema: PLUGIN_SCHEMA, name: 'unique' },
        });

        const { scans, shadowed } = await scanLocalSources([primary, secondary]);

        expect(scans).toHaveLength(2);
        expect(scans[0]?.candidates.map((c) => c.name)).toEqual(['shared-tools']);
        expect(scans[1]?.candidates.map((c) => c.name)).toEqual(['unique']);
        expect(shadowed.map((c) => c.dirName)).toEqual(['shared-copy']);
    });

    it('does not deduplicate packages that failed to load, since they have no name', async () => {
        const a = await scratch();
        const b = await scratch();
        await makePackage(a, 'broken', { manifest: { $schema: PLUGIN_SCHEMA, name: 'Bad Name' } });
        await makePackage(b, 'broken', { manifest: { $schema: PLUGIN_SCHEMA, name: 'Bad Name' } });

        const { scans, shadowed } = await scanLocalSources([a, b]);

        expect(shadowed).toEqual([]);
        expect(scans[0]?.candidates).toHaveLength(1);
        expect(scans[1]?.candidates).toHaveLength(1);
    });

    it('tolerates an unavailable directory among available ones', async () => {
        const good = await scratch();
        await makePackage(good, 'real');

        const { scans } = await scanLocalSources([join(good, 'missing'), good]);

        expect(scans[0]?.unavailable).toBe(true);
        expect(scans[1]?.candidates.map((c) => c.dirName)).toEqual(['real']);
    });

    it('returns nothing for an empty source list', async () => {
        const { scans, shadowed } = await scanLocalSources([]);
        expect(scans).toEqual([]);
        expect(shadowed).toEqual([]);
    });
});

describe('parsePackageDirs', () => {
    it('returns nothing for an absent or empty value', () => {
        expect(parsePackageDirs(undefined)).toEqual([]);
        expect(parsePackageDirs('')).toEqual([]);
        expect(parsePackageDirs('   ')).toEqual([]);
    });

    it('splits on commas and semicolons and trims', () => {
        expect(parsePackageDirs('/a, /b ;/c')).toEqual(['/a', '/b', '/c']);
    });

    it('splits on the platform path delimiter', () => {
        expect(parsePackageDirs(['/one', '/two'].join(delimiter))).toEqual(['/one', '/two']);
    });

    it('never splits a Windows drive letter', () => {
        // `C:\packages` contains a colon, which is exactly why the Windows path
        // delimiter is `;`. Splitting on a bare colon would turn one real path
        // into two broken ones.
        const parsed = parsePackageDirs('C:\\packages;D:\\more');
        if (delimiter === ';') {
            expect(parsed).toEqual(['C:\\packages', 'D:\\more']);
        } else {
            // On POSIX the semicolon still separates, and the drive-letter
            // colons are not delimiters there either.
            expect(parsed).toEqual(['C:\\packages', 'D:\\more']);
        }
    });

    it('drops empty segments from a trailing or doubled separator', () => {
        expect(parsePackageDirs('/a,,/b,')).toEqual(['/a', '/b']);
    });
});
