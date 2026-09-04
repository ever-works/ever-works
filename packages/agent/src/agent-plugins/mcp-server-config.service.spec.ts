import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpServerConfigService, usesPluginData } from './mcp-server-config.service';

/**
 * Runs against the REAL conformance library and REAL files: what a package
 * declares is a fact about bytes on disk, and a stubbed loader would not
 * exercise the validation this service depends on.
 */

const PLUGIN_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
const MCP_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json';

async function packagesRoot(): Promise<string> {
    return mkdtemp(join(tmpdir(), 'ap-mcp-'));
}

async function writePackage(
    root: string,
    dirName: string,
    name: string,
    mcpServers: Record<string, unknown>,
): Promise<string> {
    const dir = join(root, dirName);
    await mkdir(dir, { recursive: true });
    await writeFile(
        join(dir, 'plugin.json'),
        JSON.stringify({ $schema: PLUGIN_SCHEMA, name, version: '1.0.0' }, null, 2),
        'utf8',
    );
    await writeFile(
        join(dir, 'mcp.json'),
        JSON.stringify({ $schema: MCP_SCHEMA, mcpServers }, null, 2),
        'utf8',
    );
    return dir;
}

describe('usesPluginData', () => {
    it('finds the placeholder anywhere it can appear in a stdio config', () => {
        expect(
            usesPluginData({ type: 'stdio', command: 'node', args: ['${PLUGIN_DATA}/x.js'] }),
        ).toBe(true);
        expect(
            usesPluginData({ type: 'stdio', command: 'node', env: { DB: '${PLUGIN_DATA}/db' } }),
        ).toBe(true);
        expect(usesPluginData({ type: 'stdio', command: 'node', cwd: '${PLUGIN_DATA}' })).toBe(
            true,
        );
        expect(usesPluginData({ type: 'stdio', command: 'node', args: ['./x.js'] })).toBe(false);
    });

    it('finds it in a remote config too', () => {
        expect(usesPluginData({ type: 'streamable-http', url: 'https://x/${PLUGIN_DATA}' })).toBe(
            true,
        );
        expect(usesPluginData({ type: 'streamable-http', url: 'https://x/mcp' })).toBe(false);
    });
});

describe('McpServerConfigService', () => {
    const originalEnv = process.env;
    let service: McpServerConfigService;

    beforeEach(() => {
        process.env = { ...originalEnv };
        process.env.FEATURE_AGENT_PLUGINS = 'true';
        service = new McpServerConfigService();
    });

    afterAll(() => {
        process.env = originalEnv;
    });

    it('reports enabled:false and nothing else while the flag is off', async () => {
        delete process.env.FEATURE_AGENT_PLUGINS;
        const root = await packagesRoot();
        await writePackage(root, 'acme', 'acme.tools', {
            api: { type: 'streamable-http', url: 'https://acme.example.com/mcp' },
        });
        process.env.AGENT_PLUGINS_DIR = root;

        const result = await service.resolveAll();

        // "Off" must be distinguishable from "on with no servers".
        expect(result).toEqual({ enabled: false, servers: [], skipped: [] });
    });

    it('resolves a remote server with full provenance', async () => {
        const root = await packagesRoot();
        const dir = await writePackage(root, 'acme', 'acme.tools', {
            api: { type: 'streamable-http', url: 'https://acme.example.com/mcp' },
        });
        process.env.AGENT_PLUGINS_DIR = root;

        const result = await service.resolveAll();

        expect(result.enabled).toBe(true);
        expect(result.servers).toHaveLength(1);
        expect(result.servers[0]).toMatchObject({
            name: 'api',
            toolNamespace: 'api',
            transport: 'streamable-http',
            config: { type: 'streamable-http', url: 'https://acme.example.com/mcp' },
        });
        // Provenance travels WITH the server, so the origin of a tool is
        // answerable at the point of use rather than only in a log.
        expect(result.servers[0].provenance).toMatchObject({
            packageName: 'acme.tools',
            packageRoot: dir,
            packageVersion: '1.0.0',
            sourceKind: 'local',
        });
    });

    it('expands ${PLUGIN_ROOT} against the package directory', async () => {
        // stdio is gated separately, and this test is about expansion rather
        // than the gate.
        process.env.AGENT_PLUGINS_STDIO = 'true';
        const root = await packagesRoot();
        const dir = await writePackage(root, 'acme', 'acme.tools', {
            local: {
                type: 'stdio',
                command: './bin/server',
                args: ['--root', '${PLUGIN_ROOT}/data'],
                env: { CONFIG: '${PLUGIN_ROOT}/config.json' },
            },
        });
        process.env.AGENT_PLUGINS_DIR = root;

        const result = await service.resolveAll();

        // `McpServerConfig` is a union, and `packages/agent` compiles with
        // strictNullChecks off, so narrowing it by `type` does not work here.
        const config = result.servers[0]?.config as unknown as {
            type: string;
            args: string[];
            env: Record<string, string>;
        };

        expect(config.type).toBe('stdio');

        // Expansion is TEXTUAL substitution, so the separator the package
        // author wrote survives — `${PLUGIN_ROOT}/data` stays a forward slash
        // even on Windows. That is deliberate: normalising to the platform
        // separator would rewrite the author's string, and the value may not
        // be a filesystem path at all (a URL fragment, an argument to a tool
        // that parses it itself). Node accepts forward slashes on Windows, so
        // nothing is lost by leaving it alone.
        expect(config.args).toEqual(['--root', `${dir}/data`]);
        expect(config.env.CONFIG).toBe(`${dir}/config.json`);

        // The placeholder must be GONE, not merely joined onto something.
        expect(JSON.stringify(config)).not.toContain('PLUGIN_ROOT');
    });

    it('leaves ${PLUGIN_DATA} INTACT for a stdio server, so the launcher can resolve it', async () => {
        process.env.AGENT_PLUGINS_STDIO = 'true';
        const root = await packagesRoot();
        await writePackage(root, 'acme', 'acme.tools', {
            stateful: { type: 'stdio', command: 'node', args: ['${PLUGIN_DATA}/db.js'] },
        });
        process.env.AGENT_PLUGINS_DIR = root;

        const result = await service.resolveAll();

        // This resolver has no owner, and ${PLUGIN_DATA} is per (owner,
        // package) — so it cannot supply the value and must not pretend to.
        // The launcher, which does know the owner, resolves it.
        expect(result.skipped).toEqual([]);
        const config = result.servers[0]?.config as unknown as { args: string[] };
        expect(config.args).toEqual(['${PLUGIN_DATA}/db.js']);
    });

    it('refuses a REMOTE server referencing ${PLUGIN_DATA}, which nothing can resolve', async () => {
        const root = await packagesRoot();
        await writePackage(root, 'acme', 'acme.tools', {
            api: { type: 'streamable-http', url: 'https://acme.example.com/${PLUGIN_DATA}' },
        });
        process.env.AGENT_PLUGINS_DIR = root;

        const result = await service.resolveAll();

        // No launcher is involved, so nobody can supply it for a URL.
        expect(result.servers).toEqual([]);
        expect(result.skipped[0]?.code).toBe('needs-plugin-data');
    });

    it('never turns ${PLUGIN_DATA} into an absolute path at the filesystem root', async () => {
        process.env.AGENT_PLUGINS_STDIO = 'true';
        const root = await packagesRoot();
        await writePackage(root, 'acme', 'acme.tools', {
            stateful: { type: 'stdio', command: 'node', args: ['${PLUGIN_DATA}/db.sqlite'] },
        });
        process.env.AGENT_PLUGINS_DIR = root;

        const result = await service.resolveAll();

        // Expanding with an empty string, as this once did, silently produced
        // `/db.sqlite`.
        const config = result.servers[0]?.config as unknown as { args: string[] };
        expect(config.args[0]).not.toBe('/db.sqlite');
        expect(config.args[0]).toContain('${PLUGIN_DATA}');
    });

    describe('AP-19: stdio is present-but-disabled, not absent', () => {
        it('reports a stdio server as disabled BY POLICY while the gate is off', async () => {
            const root = await packagesRoot();
            await writePackage(root, 'acme', 'acme.tools', {
                local: { type: 'stdio', command: './bin/server' },
            });
            process.env.AGENT_PLUGINS_DIR = root;
            // AGENT_PLUGINS_STDIO deliberately unset — the default.

            const result = await service.resolveAll();

            expect(result.servers).toEqual([]);
            expect(result.skipped).toHaveLength(1);
            expect(result.skipped[0]).toMatchObject({
                name: 'local',
                packageName: 'acme.tools',
                code: 'disabled-by-policy',
                // The distinction AP-19 asks for: this is a setting away from
                // working, not a broken package. A UI can offer to enable it.
                enableable: true,
            });
            expect(result.skipped[0].reason).toContain('AGENT_PLUGINS_STDIO');
        });

        it('resolves the same server once the gate is open', async () => {
            const root = await packagesRoot();
            await writePackage(root, 'acme', 'acme.tools', {
                local: { type: 'stdio', command: './bin/server' },
            });
            process.env.AGENT_PLUGINS_DIR = root;
            process.env.AGENT_PLUGINS_STDIO = 'true';

            const result = await service.resolveAll();

            expect(result.skipped).toEqual([]);
            expect(result.servers[0]).toMatchObject({ name: 'local', transport: 'stdio' });
        });

        it('leaves REMOTE servers untouched by the stdio gate', async () => {
            const root = await packagesRoot();
            await writePackage(root, 'acme', 'acme.tools', {
                api: { type: 'streamable-http', url: 'https://acme.example.com/mcp' },
            });
            process.env.AGENT_PLUGINS_DIR = root;
            // Gate off: a remote server is inert data and is not affected.

            const result = await service.resolveAll();

            expect(result.servers.map((s) => s.name)).toEqual(['api']);
            expect(result.skipped).toEqual([]);
        });
    });

    it('resolves servers from several packages together', async () => {
        const root = await packagesRoot();
        await writePackage(root, 'one', 'pkg.one', {
            alpha: { type: 'streamable-http', url: 'https://one.example.com/mcp' },
        });
        await writePackage(root, 'two', 'pkg.two', {
            beta: { type: 'sse', url: 'https://two.example.com/sse' },
        });
        process.env.AGENT_PLUGINS_DIR = root;

        const result = await service.resolveAll();

        expect(result.servers.map((s) => s.name).sort()).toEqual(['alpha', 'beta']);
        expect(result.servers.map((s) => s.provenance.packageName).sort()).toEqual([
            'pkg.one',
            'pkg.two',
        ]);
    });

    it('filters to one package by manifest name', async () => {
        const root = await packagesRoot();
        await writePackage(root, 'one', 'pkg.one', {
            alpha: { type: 'streamable-http', url: 'https://one.example.com/mcp' },
        });
        await writePackage(root, 'two', 'pkg.two', {
            beta: { type: 'streamable-http', url: 'https://two.example.com/mcp' },
        });
        process.env.AGENT_PLUGINS_DIR = root;

        const servers = await service.resolveForPackage('pkg.two');

        expect(servers.map((s) => s.name)).toEqual(['beta']);
    });

    it('returns an empty result when no package declares any server', async () => {
        const root = await packagesRoot();
        const dir = join(root, 'plain');
        await mkdir(dir, { recursive: true });
        await writeFile(
            join(dir, 'plugin.json'),
            JSON.stringify({ $schema: PLUGIN_SCHEMA, name: 'plain' }),
            'utf8',
        );
        process.env.AGENT_PLUGINS_DIR = root;

        const result = await service.resolveAll();

        // Enabled, and genuinely empty — the caller can tell this apart from
        // the flag being off.
        expect(result).toMatchObject({ enabled: true, servers: [], skipped: [] });
    });
});
