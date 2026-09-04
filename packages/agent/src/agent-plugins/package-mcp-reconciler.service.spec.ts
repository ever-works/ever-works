import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectionNameFor, PackageMcpReconcilerService } from './package-mcp-reconciler.service';
import { McpServerConfigService } from './mcp-server-config.service';
import type { McpServerConnectionRepository } from '../database/repositories/mcp-server-connection.repository';
import type { McpServerConnection } from '../entities/mcp-server-connection.entity';

const PLUGIN_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
const MCP_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json';

async function writePackage(
    root: string,
    dirName: string,
    name: string,
    mcpServers: Record<string, unknown>,
): Promise<void> {
    const dir = join(root, dirName);
    await mkdir(dir, { recursive: true });
    await writeFile(
        join(dir, 'plugin.json'),
        JSON.stringify({ $schema: PLUGIN_SCHEMA, name, version: '1.0.0' }),
        'utf8',
    );
    await writeFile(
        join(dir, 'mcp.json'),
        JSON.stringify({ $schema: MCP_SCHEMA, mcpServers }),
        'utf8',
    );
}

function repoStub(existing: McpServerConnection[] = []) {
    const rows = [...existing];
    return {
        rows,
        findByUserAndName: jest.fn().mockImplementation(async (_userId: string, name: string) => {
            return rows.find((row) => row.name === name) ?? null;
        }),
        create: jest.fn().mockImplementation(async (data: Partial<McpServerConnection>) => {
            const row = { id: `id-${rows.length}`, ...data } as McpServerConnection;
            rows.push(row);
            return row;
        }),
        save: jest.fn().mockImplementation(async (row: McpServerConnection) => row),
    } as unknown as McpServerConnectionRepository & {
        rows: McpServerConnection[];
        findByUserAndName: jest.Mock;
        create: jest.Mock;
        save: jest.Mock;
    };
}

describe('connectionNameFor', () => {
    it('combines package and server so two packages declaring "api" do not collide', () => {
        expect(connectionNameFor('acme.tools', 'api')).toBe('acme-tools-api');
        expect(connectionNameFor('other.tools', 'api')).toBe('other-tools-api');
    });

    it('lower-cases and strips to the permitted charset', () => {
        expect(connectionNameFor('Acme_Tools', 'My_Server')).toBe('acme-tools-my-server');
    });

    it('never returns a name the connection entity would reject', () => {
        // The pattern is anchored and allows only [a-z0-9-] starting
        // alphanumeric, so anything else must come back null rather than be
        // written and rejected at INSERT.
        expect(connectionNameFor('...', '...')).toBeNull();
        expect(connectionNameFor('', '')).toBeNull();
    });

    it('truncates to the column limit without leaving a trailing hyphen', () => {
        const name = connectionNameFor('a'.repeat(70), 'b'.repeat(40));
        expect(name).not.toBeNull();
        expect(name!.length).toBeLessThanOrEqual(80);
        expect(name!.endsWith('-')).toBe(false);
    });
});

describe('PackageMcpReconcilerService', () => {
    const originalEnv = process.env;

    beforeEach(async () => {
        process.env = { ...originalEnv };
        process.env.FEATURE_AGENT_PLUGINS = 'true';
        process.env.AGENT_PLUGINS_DIR = await mkdtemp(join(tmpdir(), 'ap-recon-'));
    });

    afterAll(() => {
        process.env = originalEnv;
    });

    function build(repo = repoStub()) {
        return {
            repo,
            service: new PackageMcpReconcilerService(new McpServerConfigService(), repo),
        };
    }

    it('does nothing while the feature is off', async () => {
        delete process.env.FEATURE_AGENT_PLUGINS;
        const { service, repo } = build();

        const result = await service.reconcile('user-1');

        expect(result.created).toEqual([]);
        expect(repo.create).not.toHaveBeenCalled();
    });

    it('creates a package connection DISABLED and with no binding', async () => {
        await writePackage(process.env.AGENT_PLUGINS_DIR!, 'acme', 'acme.tools', {
            api: { type: 'streamable-http', url: 'https://acme.example.com/mcp' },
        });
        const { service, repo } = build();

        const result = await service.reconcile('user-1');

        expect(result.created).toEqual(['acme-tools-api']);
        // The security property of this whole bridge: a package arriving on
        // disk must not grant any agent network reach. Enabled would do
        // exactly that, since a manual connection also gets a tenant binding.
        expect(repo.create).toHaveBeenCalledWith(
            expect.objectContaining({
                name: 'acme-tools-api',
                url: 'https://acme.example.com/mcp',
                transport: 'streamable-http',
                enabled: false,
                source: 'package',
            }),
        );
    });

    describe('SSRF: two layers, and what each one catches', () => {
        /**
         * The conformance library permits plain `http:` for LOOPBACK hosts
         * (spec 7.2.2) — reasonable for a desktop client talking to a local
         * dev server. Ever Works is the server case, where loopback means the
         * API pod's own localhost, so a package pointing at `127.0.0.1:6379`
         * would reach Redis. The library blocks non-loopback plain HTTP; the
         * reconciler's own guard blocks what the spec deliberately allows.
         */

        it.each([
            ['http://169.254.169.254/latest/meta-data/', 'cloud metadata'],
            ['http://10.0.0.5/mcp', 'private range'],
        ])('the LIBRARY rejects %s (%s) as non-loopback plain HTTP', async (url) => {
            await writePackage(process.env.AGENT_PLUGINS_DIR!, 'acme', 'acme.tools', {
                api: { type: 'streamable-http', url },
            });
            const { service, repo } = build();

            const result = await service.reconcile('user-1');

            // Never becomes a valid server entry, so it never reaches the
            // reconciler at all.
            expect(result.created).toEqual([]);
            expect(repo.create).not.toHaveBeenCalled();
        });

        it.each([
            ['http://127.0.0.1:6379/mcp', 'IPv4 loopback'],
            ['http://[::1]/mcp', 'IPv6 loopback'],
        ])('the RECONCILER rejects %s (%s), which the spec permits', async (url) => {
            await writePackage(process.env.AGENT_PLUGINS_DIR!, 'acme', 'acme.tools', {
                api: { type: 'streamable-http', url },
            });
            const { service, repo } = build();

            const result = await service.reconcile('user-1');

            // This is the gap the second layer exists for: writing to the
            // repository bypasses `McpConnectionsService`, so the SSRF guard
            // every operator-entered URL must pass is repeated here.
            expect(result.created).toEqual([]);
            expect(repo.create).not.toHaveBeenCalled();
            expect(result.skipped[0]?.reason).toContain('public http(s)');
        });

        it('still accepts an ordinary public https URL', async () => {
            await writePackage(process.env.AGENT_PLUGINS_DIR!, 'acme', 'acme.tools', {
                api: { type: 'streamable-http', url: 'https://acme.example.com/mcp' },
            });
            const { service } = build();

            const result = await service.reconcile('user-1');

            expect(result.created).toEqual(['acme-tools-api']);
        });
    });

    it('is idempotent — a second run creates nothing', async () => {
        await writePackage(process.env.AGENT_PLUGINS_DIR!, 'acme', 'acme.tools', {
            api: { type: 'streamable-http', url: 'https://acme.example.com/mcp' },
        });
        const { service, repo } = build();

        await service.reconcile('user-1');
        const second = await service.reconcile('user-1');

        expect(second.created).toEqual([]);
        expect(second.unchanged).toEqual(['acme-tools-api']);
        expect(repo.create).toHaveBeenCalledTimes(1);
    });

    it('updates the URL when the package moves its server, without re-enabling it', async () => {
        await writePackage(process.env.AGENT_PLUGINS_DIR!, 'acme', 'acme.tools', {
            api: { type: 'streamable-http', url: 'https://new.example.com/mcp' },
        });
        const existing = {
            id: 'c1',
            name: 'acme-tools-api',
            url: 'https://old.example.com/mcp',
            transport: 'streamable-http',
            source: 'package',
            enabled: true,
        } as McpServerConnection;
        const { service, repo } = build(repoStub([existing]));

        const result = await service.reconcile('user-1');

        expect(result.updated).toEqual(['acme-tools-api']);
        expect(repo.save).toHaveBeenCalled();
        // A new address is not a reason to re-authorise, nor to revoke: the
        // operator's decision is left exactly as they set it.
        expect(existing.enabled).toBe(true);
        expect(existing.url).toBe('https://new.example.com/mcp');
    });

    it('REFUSES to overwrite a manually-created connection of the same name', async () => {
        await writePackage(process.env.AGENT_PLUGINS_DIR!, 'acme', 'acme.tools', {
            api: { type: 'streamable-http', url: 'https://attacker.example.com/mcp' },
        });
        const manual = {
            id: 'c1',
            name: 'acme-tools-api',
            url: 'https://trusted.example.com/mcp',
            transport: 'streamable-http',
            source: 'manual',
            enabled: true,
        } as McpServerConnection;
        const { service, repo } = build(repoStub([manual]));

        const result = await service.reconcile('user-1');

        // Otherwise a package could silently repoint a connection the operator
        // created and trusts at an address of its choosing.
        expect(result.skipped).toEqual([
            expect.objectContaining({ reason: expect.stringContaining('refusing to overwrite') }),
        ]);
        expect(repo.save).not.toHaveBeenCalled();
        expect(manual.url).toBe('https://trusted.example.com/mcp');
    });

    it('skips a stdio server as DISABLED BY POLICY while the gate is off', async () => {
        await writePackage(process.env.AGENT_PLUGINS_DIR!, 'acme', 'acme.tools', {
            local: { type: 'stdio', command: './bin/server' },
        });
        const { service, repo } = build();

        const result = await service.reconcile('user-1');

        expect(result.created).toEqual([]);
        expect(result.skipped[0]?.code).toBe('disabled-by-policy');
        expect(repo.create).not.toHaveBeenCalled();
    });

    it('skips a stdio server as UNSUPPORTED-TRANSPORT once the gate is open', async () => {
        // With stdio allowed the resolver hands it over, and the reconciler
        // refuses it for its own reason: a connection row is URL-shaped, and a
        // stdio server is launched rather than connected to.
        process.env.AGENT_PLUGINS_STDIO = 'true';
        await writePackage(process.env.AGENT_PLUGINS_DIR!, 'acme', 'acme.tools', {
            local: { type: 'stdio', command: './bin/server' },
        });
        const { service, repo } = build();

        const result = await service.reconcile('user-1');

        expect(result.created).toEqual([]);
        expect(result.skipped[0]?.code).toBe('unsupported-transport');
        expect(repo.create).not.toHaveBeenCalled();
    });

    it('carries forward what the resolver already refused, in one report', async () => {
        await writePackage(process.env.AGENT_PLUGINS_DIR!, 'acme', 'acme.tools', {
            // A REMOTE server referencing ${PLUGIN_DATA}: nothing can resolve
            // it, so the resolver refuses it and the reconciler passes the
            // refusal through rather than producing a second half-report.
            api: { type: 'streamable-http', url: 'https://x.example.com/${PLUGIN_DATA}' },
        });
        const { service } = build();

        const result = await service.reconcile('user-1');

        // One report explaining every declared server beats two half-reports.
        expect(result.skipped).toHaveLength(1);
        expect(result.skipped[0].reason).toContain('PLUGIN_DATA');
        // The resolver's code survives the reconciler boundary.
        expect(result.skipped[0].code).toBe('needs-plugin-data');
    });

    it('reconciles several packages in one pass', async () => {
        const root = process.env.AGENT_PLUGINS_DIR!;
        await writePackage(root, 'one', 'pkg.one', {
            api: { type: 'streamable-http', url: 'https://one.example.com/mcp' },
        });
        await writePackage(root, 'two', 'pkg.two', {
            api: { type: 'sse', url: 'https://two.example.com/sse' },
        });
        const { service } = build();

        const result = await service.reconcile('user-1');

        // Same server name in both packages, distinct connection names.
        expect([...result.created].sort()).toEqual(['pkg-one-api', 'pkg-two-api']);
    });
});
