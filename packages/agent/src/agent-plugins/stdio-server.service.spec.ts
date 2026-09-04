import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentPluginStdioServerService } from './stdio-server.service';
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
