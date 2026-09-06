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

    it('gives two long names that share a prefix DIFFERENT connection names', () => {
        // Truncation alone collides, and the consequence is not cosmetic:
        // reconciliation finds the first server's row for the second and
        // overwrites its URL, silently pointing one server at another's
        // address.
        const long = 'x'.repeat(70);
        const a = connectionNameFor('acme.tools', `${long}-alpha`);
        const b = connectionNameFor('acme.tools', `${long}-beta`);

        expect(a).not.toBe(b);
        expect(a!.length).toBeLessThanOrEqual(80);
        expect(b!.length).toBeLessThanOrEqual(80);
    });

    it('leaves a short name untouched, with no digest appended', () => {
        // A digest on every name would make the common case unreadable for no
        // benefit.
        expect(connectionNameFor('acme.tools', 'api')).toBe('acme-tools-api');
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

        const result = await service.reconcile({ userId: 'user-1' }, 'acme.tools');

        expect(result.created).toEqual([]);
        expect(repo.create).not.toHaveBeenCalled();
    });

    it('creates a package connection DISABLED and with no binding', async () => {
        await writePackage(process.env.AGENT_PLUGINS_DIR!, 'acme', 'acme.tools', {
            api: { type: 'streamable-http', url: 'https://acme.example.com/mcp' },
        });
        const { service, repo } = build();

        const result = await service.reconcile({ userId: 'user-1' }, 'acme.tools');

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

            const result = await service.reconcile({ userId: 'user-1' }, 'acme.tools');

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

            const result = await service.reconcile({ userId: 'user-1' }, 'acme.tools');

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

            const result = await service.reconcile({ userId: 'user-1' }, 'acme.tools');

            expect(result.created).toEqual(['acme-tools-api']);
        });
    });

    it('is idempotent — a second run creates nothing', async () => {
        await writePackage(process.env.AGENT_PLUGINS_DIR!, 'acme', 'acme.tools', {
            api: { type: 'streamable-http', url: 'https://acme.example.com/mcp' },
        });
        const { service, repo } = build();

        await service.reconcile({ userId: 'user-1' }, 'acme.tools');
        const second = await service.reconcile({ userId: 'user-1' }, 'acme.tools');

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

        const result = await service.reconcile({ userId: 'user-1' }, 'acme.tools');

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

        const result = await service.reconcile({ userId: 'user-1' }, 'acme.tools');

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

        const result = await service.reconcile({ userId: 'user-1' }, 'acme.tools');

        expect(result.created).toEqual([]);
        expect(result.skipped[0]?.code).toBe('disabled-by-policy');
        expect(repo.create).not.toHaveBeenCalled();
    });

    /**
     * AP-14. A stdio server becomes a connection row like any other package
     * server — DISABLED and unbound — so it inherits the whole authorisation
     * story rather than needing a second one built for the transport that
     * runs local code. Its `url` is the opaque `stdio:<package>/<server>`
     * pointer; nothing dials it, `McpToolSource` reads it back to know which
     * package server to launch.
     */
    it('creates a stdio server as a DISABLED connection once the gate is open', async () => {
        process.env.AGENT_PLUGINS_STDIO = 'true';
        await writePackage(process.env.AGENT_PLUGINS_DIR!, 'acme', 'acme.tools', {
            local: { type: 'stdio', command: './bin/server' },
        });
        const { service, repo } = build();

        const result = await service.reconcile({ userId: 'user-1' }, 'acme.tools');

        expect(result.skipped).toEqual([]);
        expect(result.created).toHaveLength(1);
        expect(repo.create).toHaveBeenCalledWith(
            expect.objectContaining({
                transport: 'stdio',
                url: 'stdio:acme.tools/local',
                source: 'package',
                // The gate that makes putting it in this table safe.
                enabled: false,
                authHeaders: null,
            }),
        );
    });

    it('does not apply the public-address guard to a stdio pointer', async () => {
        // `stdio:` is not an http(s) URL and would fail isSafeWebhookUrl. The
        // guard is for addresses something dials; this is a pointer.
        process.env.AGENT_PLUGINS_STDIO = 'true';
        await writePackage(process.env.AGENT_PLUGINS_DIR!, 'acme', 'acme.tools', {
            local: { type: 'stdio', command: './bin/server' },
        });
        const { service, repo } = build();

        const result = await service.reconcile({ userId: 'user-1' }, 'acme.tools');

        expect(result.skipped.map((entry) => entry.code)).not.toContain('unsafe-url');
        expect(repo.create).toHaveBeenCalled();
    });

    /**
     * The escalation this must not allow. What an operator authorised when
     * they enabled a `streamable-http` row is an agent reaching a remote API.
     * If a package update turns that same row into `stdio`, carrying the
     * enable forward would silently convert it into permission to execute
     * local code — with the package author's release as the only input.
     */
    it('DISABLES an enabled row when a package update changes its transport to stdio', async () => {
        process.env.AGENT_PLUGINS_STDIO = 'true';
        await writePackage(process.env.AGENT_PLUGINS_DIR!, 'acme', 'acme.tools', {
            local: { type: 'stdio', command: './bin/server' },
        });
        const { service, repo } = build();
        const existing = {
            id: 'c1',
            name: 'acme-tools-local',
            url: 'https://acme.example.com/mcp',
            transport: 'streamable-http',
            source: 'package',
            enabled: true,
        };
        repo.findByUserAndName.mockResolvedValue(existing);

        const result = await service.reconcile({ userId: 'user-1' }, 'acme.tools');

        expect(result.updated).toHaveLength(1);
        expect(existing.transport).toBe('stdio');
        expect(existing.enabled).toBe(false);
        expect(repo.save).toHaveBeenCalledWith(existing);
    });

    it('leaves `enabled` alone when only the URL moved — a new address is not a new kind', async () => {
        await writePackage(process.env.AGENT_PLUGINS_DIR!, 'acme', 'acme.tools', {
            local: { type: 'streamable-http', url: 'https://moved.example.com/mcp' },
        });
        const { service, repo } = build();
        const existing = {
            id: 'c1',
            name: 'acme-tools-local',
            url: 'https://acme.example.com/mcp',
            transport: 'streamable-http',
            source: 'package',
            enabled: true,
        };
        repo.findByUserAndName.mockResolvedValue(existing);

        await service.reconcile({ userId: 'user-1' }, 'acme.tools');

        expect(existing.url).toBe('https://moved.example.com/mcp');
        expect(existing.enabled).toBe(true);
    });

    it('carries forward what the resolver already refused, in one report', async () => {
        await writePackage(process.env.AGENT_PLUGINS_DIR!, 'acme', 'acme.tools', {
            // A REMOTE server referencing ${PLUGIN_DATA}: nothing can resolve
            // it, so the resolver refuses it and the reconciler passes the
            // refusal through rather than producing a second half-report.
            api: { type: 'streamable-http', url: 'https://x.example.com/${PLUGIN_DATA}' },
        });
        const { service } = build();

        const result = await service.reconcile({ userId: 'user-1' }, 'acme.tools');

        // One report explaining every declared server beats two half-reports.
        expect(result.skipped).toHaveLength(1);
        expect(result.skipped[0].reason).toContain('PLUGIN_DATA');
        // The resolver's code survives the reconciler boundary.
        expect(result.skipped[0].code).toBe('needs-plugin-data');
    });

    it('reconciles ONLY the named package, never everything on the shared root', async () => {
        // The packages root is deployment-wide: remote packages are keyed by
        // ORIGIN (`git/<url>/<sha>`, `npm/<name>/<version>`) and never by
        // owner, so every user's packages sit side by side under it. A
        // reconcile that walked all of them would mint connection rows for
        // whichever owner happened to install something, pointing at URLs
        // chosen by another tenant's package. The rows arrive disabled, but
        // their new owner can enable them.
        const root = process.env.AGENT_PLUGINS_DIR!;
        await writePackage(root, 'one', 'pkg.one', {
            api: { type: 'streamable-http', url: 'https://one.example.com/mcp' },
        });
        await writePackage(root, 'two', 'pkg.two', {
            api: { type: 'sse', url: 'https://two.example.com/sse' },
        });
        const { service, repo } = build();

        const result = await service.reconcile({ userId: 'user-1' }, 'pkg.one');

        expect(result.created).toEqual(['pkg-one-api']);
        expect(repo.rows.map((row) => row.name)).toEqual(['pkg-one-api']);
    });

    it('stamps the owner tenancy onto a row it creates', async () => {
        // The install row carries tenantId/organizationId (EW-651 Tier A). A
        // connection minted because of that install must carry the same, or a
        // scoped query cannot account for it.
        await writePackage(process.env.AGENT_PLUGINS_DIR!, 'acme', 'acme.tools', {
            api: { type: 'streamable-http', url: 'https://acme.example.com/mcp' },
        });
        const { service, repo } = build();

        await service.reconcile(
            { userId: 'user-1', tenantId: 'tenant-1', organizationId: 'org-1' },
            'acme.tools',
        );

        expect(repo.create).toHaveBeenCalledWith(
            expect.objectContaining({
                userId: 'user-1',
                tenantId: 'tenant-1',
                organizationId: 'org-1',
            }),
        );
    });
});
