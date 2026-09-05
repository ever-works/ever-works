import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentPluginStdioServerService, createStdioTransportFactory } from './stdio-server.service';
import { AgentPluginPackageDataDirService } from './package-data-dir.service';
import { LaunchRefused } from './stdio-launcher';

/**
 * The spawn point. These are about the gate, the lifecycle and what is
 * handed to the transport — the rules about environments and binaries are
 * asserted against plain values in `stdio-launcher.spec.ts`.
 */

let root: string;
let pkg: string;
let service: AgentPluginStdioServerService;
let created: Array<Record<string, unknown>>;
let closes: number;

const originalEnv = process.env;

function transportStub(closeImpl?: () => Promise<void>) {
    return {
        create: jest.fn(async (params: Record<string, unknown>) => {
            created.push(params);
            return {
                close:
                    closeImpl ??
                    (async () => {
                        closes += 1;
                    }),
            };
        }),
    };
}

beforeEach(async () => {
    process.env = { ...originalEnv };
    root = await mkdtemp(join(tmpdir(), 'ap-stdio-'));
    pkg = join(root, 'package');
    await mkdir(join(pkg, 'bin'), { recursive: true });
    await writeFile(join(pkg, 'bin', 'server'), '#!/bin/sh\n', 'utf8');

    process.env.AGENT_PLUGINS_DATA_DIR = join(root, 'data');
    process.env.AGENT_PLUGINS_STDIO = 'true';

    created = [];
    closes = 0;
    service = new AgentPluginStdioServerService(new AgentPluginPackageDataDirService());
});

afterAll(() => {
    process.env = originalEnv;
});

const request = {
    server: { type: 'stdio' as const, command: 'node', args: ['${PLUGIN_ROOT}/index.js'] },
    packageRoot: '',
    userId: 'user-1',
    packageName: 'acme.tools',
};

describe('AgentPluginStdioServerService', () => {
    it('REFUSES to spawn while the gate is closed', async () => {
        delete process.env.AGENT_PLUGINS_STDIO;
        const transport = transportStub();
        service.setTransportFactory(transport);

        await expect(service.launch({ ...request, packageRoot: pkg })).rejects.toMatchObject({
            code: 'disabled-by-policy',
        });

        // The resolver already refuses earlier, so this is the second gate —
        // and the one that matters, because it is the function that spawns.
        expect(transport.create).not.toHaveBeenCalled();
    });

    it('creates the data directory before launching, not at install', async () => {
        const transport = transportStub();
        service.setTransportFactory(transport);

        const running = await service.launch({ ...request, packageRoot: pkg });

        // A directory created at install is missing on every replica that did
        // not perform it.
        expect(running.plan.env.PLUGIN_DATA).toContain('data');
        const { stat } = await import('node:fs/promises');
        await expect(stat(running.plan.env.PLUGIN_DATA)).resolves.toMatchObject({});
    });

    it('pipes stderr rather than letting it into the API log stream', async () => {
        const transport = transportStub();
        service.setTransportFactory(transport);

        await service.launch({ ...request, packageRoot: pkg });

        // The SDK default is 'inherit', which writes a package's stderr
        // straight into the API's own log stream, where it is
        // indistinguishable from platform output and can forge log lines.
        expect(created[0].stderr).toBe('pipe');
    });

    it('hands the transport the planned command, args, env and cwd', async () => {
        const transport = transportStub();
        service.setTransportFactory(transport);

        await service.launch({ ...request, packageRoot: pkg });

        expect(created[0]).toMatchObject({ command: 'node', cwd: expect.any(String) });
        expect(created[0].args).toEqual([`${pkg}/index.js`]);
        const env = created[0].env as Record<string, string>;
        expect(env.PLUGIN_ROOT).toBe(pkg);
        expect(env.DATABASE_URL).toBeUndefined();
    });

    it('refuses a command that escapes the package, without spawning', async () => {
        const transport = transportStub();
        service.setTransportFactory(transport);

        await expect(
            service.launch({
                ...request,
                packageRoot: pkg,
                server: { type: 'stdio', command: '/bin/sh' },
            }),
        ).rejects.toBeInstanceOf(LaunchRefused);

        expect(transport.create).not.toHaveBeenCalled();
    });

    it('closes a single server and forgets it', async () => {
        const transport = transportStub();
        service.setTransportFactory(transport);

        const running = await service.launch({ ...request, packageRoot: pkg });
        await running.close();

        expect(closes).toBe(1);
        // Already closed, so a later shutdown must not try again.
        await expect(service.shutdownAll()).resolves.toEqual({ stopped: 0, failed: 0 });
    });

    it('stops every server it started at run end', async () => {
        const transport = transportStub();
        service.setTransportFactory(transport);

        await service.launch({ ...request, packageRoot: pkg });
        await service.launch({ ...request, packageRoot: pkg, packageName: 'other.tools' });

        await expect(service.shutdownAll()).resolves.toEqual({ stopped: 2, failed: 0 });
        expect(closes).toBe(2);
    });

    it('does not let one unresponsive server strand the others', async () => {
        let good = 0;
        const transport = {
            create: jest
                .fn()
                .mockResolvedValueOnce({
                    close: async () => {
                        throw new Error('hung');
                    },
                })
                .mockResolvedValue({
                    close: async () => {
                        good += 1;
                    },
                }),
        };
        service.setTransportFactory(transport);

        await service.launch({ ...request, packageRoot: pkg });
        await service.launch({ ...request, packageRoot: pkg, packageName: 'other.tools' });

        // A half-completed teardown leaks processes for the lifetime of the
        // pod, which is worse than a noisy log line.
        await expect(service.shutdownAll()).resolves.toEqual({ stopped: 1, failed: 1 });
        expect(good).toBe(1);
    });

    it('does not leak a process that finishes starting DURING shutdown', async () => {
        // `factory.create()` is async, so a shutdown can snapshot the running
        // set while a launch is still in flight. Without the guard the
        // transport is added AFTER teardown and never closed — a process
        // leaked for the lifetime of the pod.
        let release!: () => void;
        const pending = new Promise<void>((resolve) => {
            release = resolve;
        });
        let closed = 0;

        const transport = {
            create: jest.fn(async () => {
                await pending;
                return {
                    close: async () => {
                        closed += 1;
                    },
                };
            }),
        };
        service.setTransportFactory(transport);

        const launching = service.launch({ ...request, packageRoot: pkg });
        const shutdown = await service.shutdownAll();
        release();

        await expect(launching).rejects.toMatchObject({ code: 'shutting-down' });

        // Nothing was registered, so shutdown legitimately saw nothing — and
        // the late transport closed itself rather than surviving.
        expect(shutdown).toEqual({ stopped: 0, failed: 0 });
        expect(closed).toBe(1);
    });

    it('is usable again after a shutdown', async () => {
        // The service is a singleton across runs: a latched shutdown flag
        // would make every launch after the first teardown fail.
        const transport = transportStub();
        service.setTransportFactory(transport);

        await service.shutdownAll();
        const running = await service.launch({ ...request, packageRoot: pkg });

        expect(running.plan.command).toBe('node');
    });

    it('is idempotent at shutdown', async () => {
        const transport = transportStub();
        service.setTransportFactory(transport);
        await service.launch({ ...request, packageRoot: pkg });

        await service.shutdownAll();

        await expect(service.shutdownAll()).resolves.toEqual({ stopped: 0, failed: 0 });
        expect(closes).toBe(1);
    });
});

/**
 * The REAL factory, spawning a REAL process.
 *
 * Everything above injects a fake factory, which is right for testing the gate
 * and the lifecycle but means `createStdioTransportFactory` — the only code
 * that starts a process — ran in no test at all. It shipped a stall.
 */
describe('createStdioTransportFactory', () => {
    let dir: string;
    let child: string;

    beforeAll(async () => {
        dir = await mkdtemp(join(tmpdir(), 'stdio-real-'));
        child = join(dir, 'child.cjs');
        // Writes `PROBE_SIZE` bytes to stderr, then records that the write
        // actually FLUSHED. A blocked child never reaches the callback.
        await writeFile(
            child,
            [
                "const fs = require('node:fs');",
                "process.stderr.write('x'.repeat(Number(process.env.PROBE_SIZE)), () => {",
                "    try { fs.writeFileSync(process.env.PROBE_MARKER, 'flushed'); } catch {}",
                '});',
                'setInterval(() => {}, 10000);',
            ].join('\n'),
            'utf8',
        );
    });

    async function spawnWriting(bytes: number): Promise<boolean> {
        const marker = join(dir, `marker-${bytes}-${Date.now()}`);

        const factory = await createStdioTransportFactory();
        const transport = await factory.create({
            command: process.execPath,
            args: [child],
            env: { PROBE_SIZE: String(bytes), PROBE_MARKER: marker },
            cwd: dir,
            stderr: 'pipe',
        });

        try {
            // Generous, because the assertion is "does it EVER finish", not
            // "how fast". A stalled child never writes the marker at all.
            for (let waited = 0; waited < 4000; waited += 100) {
                if (existsSync(marker)) return true;
                await new Promise((resolve) => setTimeout(resolve, 100));
            }
            return false;
        } finally {
            await transport.close().catch(() => undefined);
        }
    }

    it('spawns a process that can write a little to stderr', async () => {
        await expect(spawnWriting(10)).resolves.toBe(true);
    }, 30000);

    /**
     * The regression. `stderr: 'pipe'` routes the child's stderr into a
     * PassThrough that nothing reads, so past roughly 80 KB (16 KB PassThrough
     * + ~64 KB OS pipe) backpressure stalls the child mid-write — and an MCP
     * server frozen inside a write to stderr stops answering entirely.
     *
     * 10 bytes passes either way, which is exactly why this needs a payload
     * larger than the buffers rather than a token one.
     */
    it('does not stall a process that writes 200 KB to stderr', async () => {
        await expect(spawnWriting(200_000)).resolves.toBe(true);
    }, 30000);
});

/**
 * `launchClient` — the AP-14 sibling of `launch()`.
 *
 * Same gate, same plan, same shutdown-generation race guard; the difference
 * is that the SDK client starts the transport. `connect` is `protected`
 * precisely so these can drive the lifecycle without spawning: the real
 * connect path has its own spec against a real child process
 * (`mcp/__tests__/mcp-sdk-stdio.spec.ts`), because a seam every test stubs is
 * a seam nothing runs.
 */
describe('AgentPluginStdioServerService.launchClient', () => {
    class TestableService extends AgentPluginStdioServerService {
        public readonly connects: Array<Record<string, unknown>> = [];
        public readonly closes: string[] = [];
        public connectImpl: (() => Promise<void>) | null = null;

        protected override async connect(params: {
            command: string;
            args: string[];
            env: Record<string, string>;
            cwd: string;
        }) {
            this.connects.push(params);
            if (this.connectImpl) await this.connectImpl();
            return {
                client: { id: 'client' } as never,
                close: async () => {
                    this.closes.push('closed');
                },
            };
        }
    }

    let svc: TestableService;

    beforeEach(() => {
        process.env.AGENT_PLUGINS_STDIO = 'true';
        svc = new TestableService(new AgentPluginPackageDataDirService());
    });

    const req = () => ({
        server: { type: 'stdio' as const, command: 'node', args: ['${PLUGIN_ROOT}/index.js'] },
        packageRoot: pkg,
        userId: 'user-1',
        packageName: 'acme.tools',
    });

    it('REFUSES while the gate is closed, without connecting anything', async () => {
        process.env.AGENT_PLUGINS_STDIO = 'false';

        await expect(svc.launchClient(req())).rejects.toThrow('disabled by policy');
        expect(svc.connects).toHaveLength(0);
    });

    it('hands the connection the planned command, args and cwd', async () => {
        const running = await svc.launchClient(req());

        expect(svc.connects[0]).toEqual(
            expect.objectContaining({ command: 'node', cwd: expect.any(String) }),
        );
        expect(running.client).toEqual({ id: 'client' });
    });

    it('registers with the service, so shutdownAll stops a client-launched server too', async () => {
        await svc.launchClient(req());

        const result = await svc.shutdownAll();

        expect(result.stopped).toBe(1);
        expect(svc.closes).toEqual(['closed']);
    });

    it('closing the handle forgets it, so a later shutdownAll does not double-close', async () => {
        const running = await svc.launchClient(req());
        await running.close();

        const result = await svc.shutdownAll();

        expect(svc.closes).toEqual(['closed']);
        expect(result.stopped).toBe(0);
    });

    /**
     * The backstop. `McpToolSource.releaseRun` handles the normal case, but a
     * pod told to drain mid-run has no run end to hook — and until this was
     * wired, `running` was a write-only accumulator while the docstring
     * claimed otherwise.
     */
    it('onModuleDestroy stops everything still running', async () => {
        await svc.launchClient(req());
        await svc.launchClient(req());

        await svc.onModuleDestroy();

        expect(svc.closes).toEqual(['closed', 'closed']);
    });

    it('onModuleDestroy is quiet and safe when nothing is running', async () => {
        await expect(svc.onModuleDestroy()).resolves.toBeUndefined();
        expect(svc.closes).toEqual([]);
    });

    /**
     * The race the generation counter exists for: a shutdown that snapshots
     * the running set while this launch is still connecting would never see
     * the new server. It must stop itself rather than register into a set
     * nothing will drain again.
     */
    it('stops itself when a shutdown began while it was connecting', async () => {
        svc.connectImpl = async () => {
            await svc.shutdownAll();
        };

        await expect(svc.launchClient(req())).rejects.toThrow('Shutdown began');
        expect(svc.closes).toEqual(['closed']);
    });
});
